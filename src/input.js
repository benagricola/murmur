// All keyboard-shaped input: live notes, MIDI hardware, QWERTY rows,
// on-screen piano. Every entry point funnels through noteOn/noteOff
// so the rest of the app sees a single, unified note stream.
//
// Lives as one module rather than three because all four input sources
// share state (activeLiveNotes, sustain pedal, MIDI log) and call the
// same release/highlight helpers.

import { freqFromMidi, snapToScale, inScale, noteName, SCALE_ROOT_PC } from './constants.js';
import {
  audioCtx, masterGain, initAudio,
} from './audio/context.js';
import { playPatch } from './audio/voices.js';
import {
  liveTimbre, rollLiveTimbre, regenerateLiveTimbre, revertLiveTimbre,
  LIVE_ROLE_OCTAVE_SHIFT,
} from './timbres.js';
import { state, activeLiveNotes, releasingNotes, sustainedMidis } from './state.js';
import { rescheduleRecordingAutoFinish } from './recording.js';
import {
  transportStop, transportPlay, transportContinue, transportRecord,
  transportTap, transportClockTick, transportClockReset,
} from './transport.js';
import { handleControlCC } from './controls.js';
import {
  connectMinilab, paintScreen, refreshPadLights, setMidiAccessRef,
  paintTappedPad, diagSinglePadOnly,
} from './output/minilab3.js';
import { logIn } from './midi-log-panel.js';

// Lazy hook for setPlantMode (lives in pointer.js). pointer.js
// registers itself on load — avoids importing pointer.js here and
// creating an import cycle through the canvas plant code.
let setPlantModeFn = null;
export function setSetPlantModeFn(fn) { setPlantModeFn = fn; }

// === LIVE PLAY (sustained) ===

export function liveNoteOn(midi, velocity = 0.7, source = 'qwerty') {
  if (!audioCtx) { initAudio(); return midi; }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  if (activeLiveNotes.has(midi)) liveNoteOff(midi);
  // Live input never snaps to scale, regardless of source. But we
  // DO octave-shift per role so bass sits two octaves below the
  // pressed key while melody stays at pitch — without this, a
  // 25-key controller can't comfortably play bass and melody from
  // the same key positions. The user's own octave nudging comes
  // from the MiniLab's Oct+/Oct- buttons (which change which MIDI
  // note each key sends), so we don't layer an app-side shift on
  // top of that.
  const roleShift = (LIVE_ROLE_OCTAVE_SHIFT[liveTimbre.role] || 0) * 12;
  const targetMidi = midi + roleShift;
  const freq = freqFromMidi(targetMidi);
  const patch = liveTimbre.patch;
  const handle = playPatch(patch, audioCtx.currentTime, freq, 0.25 * velocity, null, (n) => n.connect(masterGain));
  if (handle && handle.detune) handle.detune(state.pitchBendCents, audioCtx.currentTime);
  activeLiveNotes.set(midi, { handle, targetMidi });
  showFloatingNote(targetMidi);
  return targetMidi;
}

export function liveNoteOff(midi) {
  const note = activeLiveNotes.get(midi);
  if (!note) return;
  const now = audioCtx.currentTime;
  try { note.handle.release(now); } catch (e) {}
  activeLiveNotes.delete(midi);
  releasingNotes.add(note);
  // Released notes still receive pitch-bend updates during their decay
  // tail. Drop them from the Set well after the tail has gone silent.
  setTimeout(() => releasingNotes.delete(note), 2000);
}

// === noteOn / noteOff — the single entry point ===
export function noteOn(midi, velocity, source = 'qwerty') {
  if (state.isRecording) {
    if (!state.recordingBuffer) {
      state.recordingBuffer = { startTime: performance.now(), notes: [], lastActivityMs: performance.now() };
    }
    state.recordingBuffer.notes.push({
      midi,
      t: performance.now() - state.recordingBuffer.startTime,
      velocity,
      noteOnMs: performance.now(),
      duration: null,
    });
    state.recordingBuffer.lastActivityMs = performance.now();
    rescheduleRecordingAutoFinish();
  }
  const playedMidi = liveNoteOn(midi, velocity, source);
  highlightPianoKey(midi, true);
  highlightPianoKey(playedMidi, true);
  flashMidiLED();
  return playedMidi;
}

export function noteOff(midi) {
  if (state.isRecording && state.recordingBuffer) {
    for (let i = state.recordingBuffer.notes.length - 1; i >= 0; i--) {
      const note = state.recordingBuffer.notes[i];
      if (note.midi === midi && note.duration === null) {
        note.duration = performance.now() - note.noteOnMs;
        break;
      }
    }
    state.recordingBuffer.lastActivityMs = performance.now();
    rescheduleRecordingAutoFinish();
  }
  // Sustain pedal: defer audible release until the pedal lifts. The
  // recording timestamps above already captured the finger-release
  // time, so the recorded duration reflects the keypress, not the
  // sustained tail — matching standard MIDI-piano convention.
  highlightPianoKey(midi, false);
  if (state.sustainPedalDown && activeLiveNotes.has(midi)) {
    sustainedMidis.add(midi);
    return;
  }
  liveNoteOff(midi);
}

// === Expressive controls (pitch bend, sustain pedal) ===
const PITCH_BEND_RANGE_SEMITONES = 2;

function applyPitchBend(normalised) {
  state.pitchBendCents = normalised * PITCH_BEND_RANGE_SEMITONES * 100;
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  for (const note of activeLiveNotes.values()) {
    try { note.handle.detune(state.pitchBendCents, now); } catch (e) {}
  }
  for (const note of releasingNotes) {
    try { note.handle.detune(state.pitchBendCents, now); } catch (e) {}
  }
}

function setSustainPedal(down) {
  if (down === state.sustainPedalDown) return;
  state.sustainPedalDown = down;
  if (!down) {
    for (const m of sustainedMidis) liveNoteOff(m);
    sustainedMidis.clear();
  }
}

// Pad routing (MiniLab 3) — assignments are device-conventions
// declared in `./devices/minilab3.js`. Bank A pads 1-4 are finger-
// drum live notes; bank A pads 5-8 are the four effect plant modes;
// bank B is the full plant-mode picker. Transport sits behind the
// device's Shift key, sending MIDI Real-Time.
import {
  PAD_CHANNEL,
  PAD_NOTE_BANK_A_BASE,
  PAD_NOTE_BANK_B_BASE,
  PAD_BANK_A_5_8_PLANT_MODES as PAD_BANK_A_PLANT_5_8,
  PAD_BANK_B_PLANT_MODES as PAD_BANK_B_TO_PLANT,
  MAIN_ROTARY_CC,
  DISPLAY_ENCODER_CLICK_CC,
  SUSTAIN_PEDAL_CC,
  ENCODER_LONG_PRESS_MS,
  TRANSPORT_CC,
  TRANSPORT_UNMAPPED_CCS,
} from './devices/minilab3.js';

// === MIDI debug log ===
// Every incoming MIDI message is recorded so we can dump a trace
// to disk and diagnose what a particular controller is sending.
const MIDI_LOG_MAX = 8000;
const midiLog = [];
let midiVerbose = false;

// Encoder long-press detection — captures the timestamp of the most
// recent CC 118 press so the matching release can decide whether to
// treat the gesture as a short press (re-roll) or long press (revert
// from history). 500ms threshold matches the device's own long-press
// feel on the OLED-mode button.
let encoderPressedMs = 0;

// Last-seen value per transport CC so we can detect rising-edge
// (button press) vs falling-edge (release). Keyed by CC number.
const lastTransportCC = {};
const midiSessionStart = performance.now();

function midiCmdName(status) {
  const cmd = status & 0xf0;
  switch (cmd) {
    case 0x80: return 'noteOff';
    case 0x90: return 'noteOn';
    case 0xa0: return 'polyAftertouch';
    case 0xb0: return 'cc';
    case 0xc0: return 'programChange';
    case 0xd0: return 'channelAftertouch';
    case 0xe0: return 'pitchBend';
    case 0xf0: return status === 0xf0 ? 'sysex' : 'system';
    default:   return 'unknown';
  }
}

function logMIDI(evt, portName) {
  const bytes = Array.from(evt.data);
  const status = bytes[0] || 0;
  // Live panel sees every byte — it does its own filtering at the UI
  // layer so the user can flip clock/sense visibility on demand.
  logIn(bytes, portName);
  // MIDI Clock (0xF8) fires 24× per beat — at 120 BPM that's 48/sec,
  // and our 8000-entry ring buffer would fill in ~3 minutes of clock
  // traffic alone. Skip from JSON log unless verbose is on.
  if (status === 0xF8 && !midiVerbose) return;
  const cmd = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  const isSystem = status >= 0xf0;
  const entry = {
    t: +(performance.now() - midiSessionStart).toFixed(2),
    port: portName,
    bytes,
    hex: bytes.map(b => b.toString(16).padStart(2, '0')).join(' '),
    type: midiCmdName(status),
    channel: isSystem ? null : channel,
  };
  if (cmd === 0x90 || cmd === 0x80 || cmd === 0xa0) {
    entry.note = bytes[1];
    entry.velocity = bytes[2];
  } else if (cmd === 0xb0) {
    entry.cc = bytes[1];
    entry.value = bytes[2];
  } else if (cmd === 0xe0) {
    entry.pitchBend = ((bytes[2] << 7) | bytes[1]) - 8192;
  } else if (cmd === 0xc0 || cmd === 0xd0) {
    entry.value = bytes[1];
  }
  midiLog.push(entry);
  if (midiLog.length > MIDI_LOG_MAX) midiLog.shift();
  if (midiVerbose) console.log('[midi]', entry);
}

function downloadMIDILog() {
  const payload = {
    capturedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    ports: midiAccess ? [...midiAccess.inputs.values()].map(i => ({ name: i.name, manufacturer: i.manufacturer, id: i.id })) : [],
    events: midiLog,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `murmur-midi-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}
document.getElementById('midi-log-btn').addEventListener('click', downloadMIDILog);
Object.defineProperty(window, 'murmurMidiVerbose', {
  get: () => midiVerbose,
  set: (v) => { midiVerbose = !!v; console.log('[midi] verbose logging =', midiVerbose); },
});

// === Web MIDI setup ===
let midiAccess = null;
const midiOutputs = [];

// Skip MIDI ports that aren't carrying user-played notes. Devices
// like the MiniLab 3 expose multiple ports for different protocols —
// the MCU/HUI port sends encoder data as pitch-bend, the ALV port
// talks to Analog Lab, DIN THRU is the physical 5-pin pass-through,
// "Midi Through" is the linux system loopback. None of these are
// what the user is playing.
// Linux's WebMIDI loopback exposes each of our outputs as a phantom
// input named "WebMIDI output:Output connection NNN" — listening on
// those just records our own outgoing SysEx as if it were a reply.
const MIDI_PORT_SKIP_PATTERN = /\b(mcu|hui|alv|din[ _-]?thru|midi[ _-]?through|thru|webmidi)\b/i;

export function setupMIDI() {
  if (!navigator.requestMIDIAccess) {
    document.getElementById('midi-label').textContent = 'no midi support';
    return;
  }
  navigator.requestMIDIAccess({ sysex: true }).then((access) => {
    midiAccess = access;
    setMidiAccessRef(access);
    refreshMIDIInputs();
    access.onstatechange = refreshMIDIInputsDebounced;
  }).catch((err) => {
    console.warn('MIDI access (with SysEx) denied; retrying without SysEx', err);
    navigator.requestMIDIAccess().then((access) => {
      midiAccess = access;
      setMidiAccessRef(access);
      refreshMIDIInputs();
      access.onstatechange = refreshMIDIInputsDebounced;
    }).catch((err2) => {
      console.warn('MIDI access denied', err2);
      document.getElementById('midi-label').textContent = 'midi denied';
    });
  });
}

// MIDI access state-change events fire once per port (input + output)
// during initial enumeration AND on any subsequent change. For a
// MiniLab 3 that's ~10 fires in rapid succession on first connect.
// Without debouncing, we'd re-run the DAW handshake 10 times, which
// puts the device into a confused state where pad LED writes stop
// being interpreted. Coalesce all the calls inside a 200ms window
// into a single refresh.
let refreshTimer = null;
function refreshMIDIInputsDebounced() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshMIDIInputs();
  }, 200);
}

function refreshMIDIInputs() {
  if (!midiAccess) return;
  let inputCount = 0;
  let firstName = null;
  for (const input of midiAccess.inputs.values()) {
    if (MIDI_PORT_SKIP_PATTERN.test(input.name || '')) {
      input.onmidimessage = null;
      continue;
    }
    input.onmidimessage = handleMIDIMessage;
    inputCount++;
    if (!firstName) firstName = input.name || 'midi';
  }
  // For outputs we keep MCU/HUI/ALV/DIN-THRU — some MiniLab firmware
  // versions route lights/screen SysEx through the ALV port. But we
  // still skip the linux WebMIDI loopback ports (which appear as
  // outputs that mirror back to our own inputs) since spraying SysEx
  // at them is wasteful and pollutes the log.
  midiOutputs.length = 0;
  const OUTPUT_SKIP = /\bwebmidi\b/i;
  for (const output of midiAccess.outputs.values()) {
    if (OUTPUT_SKIP.test(output.name || '')) continue;
    midiOutputs.push(output);
  }
  const led = document.getElementById('midi-led');
  const label = document.getElementById('midi-label');
  if (inputCount > 0) {
    led.classList.add('connected');
    // Initial label from the port name. Gets upgraded to the actual
    // device name + firmware once the Universal Device Inquiry reply
    // arrives — see parseSysExReply / setDeviceLabel.
    let displayName = firstName.includes(':') ? firstName.substring(firstName.indexOf(':') + 1) : firstName;
    displayName = displayName.replace(/\s+\d+:\d+$/, '').toLowerCase();
    setDeviceLabel(displayName.slice(0, 16));
    // Send the DAW-connect handshake and paint the device's pads +
    // screen. If the user's device isn't a MiniLab 3 this is harmless
    // — non-Arturia devices ignore the manufacturer-prefixed SysEx.
    connectMinilab(midiOutputs);
  } else {
    led.classList.remove('connected');
    setDeviceLabel('no midi');
  }
}

// Holds the device label as we learn more about it. Starts as the
// port name, gets enriched with "MiniLab 3 · fw 1.0.5" once the
// Universal Device Inquiry reply lands.
let deviceLabel = '';

function setDeviceLabel(text) {
  deviceLabel = text;
  const el = document.getElementById('midi-label');
  if (el) el.textContent = text;
}

// Arturia manufacturer ID is `00 20 6B`. The Universal Device Inquiry
// reply for the MiniLab 3 looks like:
//   F0 7E 7F 06 02 00 20 6B <fam_lo> <fam_hi> <mod_lo> <mod_hi>
//                            <v1> <v2> <v3> <v4> F7
// Family bytes identify the product line, model bytes identify the
// specific device. The four version bytes are 7-bit-safe ASCII or
// numeric — we render them as `v1.v2.v3.v4` and let the user read it.
function parseSysExReply(data) {
  if (data.length < 2 || data[0] !== 0xF0) return;
  // Universal Device Inquiry reply: `F0 7E <ch> 06 02 <mfg…> ... F7`
  if (data[1] === 0x7E && data[3] === 0x06 && data[4] === 0x02) {
    // Manufacturer ID can be 1 byte or 3 bytes (the 3-byte form starts
    // with 0x00). Skip past it.
    let i = 5;
    let mfg;
    if (data[i] === 0x00) { mfg = `${hex2(data[i])} ${hex2(data[i+1])} ${hex2(data[i+2])}`; i += 3; }
    else                  { mfg = hex2(data[i]); i += 1; }
    const isArturia = mfg === '00 20 6b';
    // Family + model = 4 bytes total
    const family = (data[i+1] << 7) | data[i];
    const model  = (data[i+3] << 7) | data[i+2];
    i += 4;
    // Up to the closing 0xF7, the remaining bytes are firmware version.
    const verBytes = [];
    while (i < data.length && data[i] !== 0xF7) { verBytes.push(data[i]); i++; }
    const version = verBytes.length > 0 ? verBytes.join('.') : '?';
    const product = isArturia ? guessArturiaProduct(family, model) : '';
    const display = isArturia ? `${product} · fw ${version}` : `dev ${mfg} fw ${version}`;
    setDeviceLabel(display.slice(0, 24));
    console.log('[midi] device inquiry reply:', { mfg, family, model, version, display });
  }
}

function hex2(b) { return (b & 0xFF).toString(16).padStart(2, '0'); }

// Best-effort name lookup for Arturia family/model pairs. Unknown
// pairs fall back to a generic label.
function guessArturiaProduct(family, model) {
  if (family === 0x04 || family === 0x42) return 'minilab 3';  // observed values vary
  return 'arturia';
}

function handleMIDIMessage(evt) {
  logMIDI(evt, evt.target && evt.target.name);
  const data = evt.data;
  const status = data[0];
  // SysEx replies land here too — branch them off before normal
  // channel-message decoding (status >= 0xF0 is system messages).
  if (status === 0xF0) {
    parseSysExReply(data);
    return;
  }
  // System Real-Time messages (single-byte, status 0xF8..0xFF).
  // Each is wired to the most-natural app behaviour:
  //   0xF8 Clock        — slave murmur's BPM to external master (derives
  //                       tempo from tick interval, applied once/beat)
  //   0xFA Start        — restart playback from beat 0
  //   0xFB Continue     — resume playback without resetting position
  //   0xFC Stop         — stop the scheduler
  //   0xFE Active Sense — keepalive; intentionally ignored
  //   0xFF Reset        — intentionally ignored (don't want surprise wipes)
  if (status === 0xF8) { transportClockTick(); return; }
  if (status === 0xFA) { transportClockReset(); transportPlay(); return; }
  if (status === 0xFB) { transportContinue(); return; }
  if (status === 0xFC) { transportStop(); return; }
  if (status >= 0xF0) return;  // other system messages: ignore
  const cmd = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  // Pitch bend (14-bit, lsb first)
  if (cmd === 0xe0) {
    const value = ((data[2] << 7) | data[1]) - 8192;
    applyPitchBend(value / 8192);
    return;
  }
  // Continuous controllers
  if (cmd === 0xb0) {
    const cc = data[1], v = data[2];
    if (cc === SUSTAIN_PEDAL_CC) { setSustainPedal(v >= 64); return; }
    // Shift + transport buttons send momentary CCs on this template
    // (instead of the Ableton-script note IDs 105-109 we used to
    // see). Rising edge triggers the action; we ignore the release.
    if (cc === TRANSPORT_CC.shiftPlay) {
      const rising = v >= 64 && (lastTransportCC[cc] || 0) < 64;
      lastTransportCC[cc] = v;
      if (rising) {
        if (state.isPlaying) transportStop();
        else transportPlay();
      }
      return;
    }
    // Other transport CCs whose function isn't yet known — log them
    // so the user can press each button and see what fires, then
    // tell us so we can map them in TRANSPORT_CC.
    if (TRANSPORT_UNMAPPED_CCS.has(cc)) {
      console.log(`[transport] unmapped CC ${cc} = ${v}`);
      return;
    }
    // MiniLab 3 main rotary (relative-1 encoding): 65-67 = +1..+3,
    // 61-63 = -3..-1, 64 = no change. Twist scrolls through pitched
    // roles; the patch for each role is cached and reused so
    // scrolling doesn't continuously re-generate random sounds.
    if (cc === MAIN_ROTARY_CC) {
      if (v > 64) rollLiveTimbre(1);
      else if (v < 64) rollLiveTimbre(-1);
      return;
    }
    // Display encoder CLICK. Press = 127, release = 0.
    // Short press (< ENCODER_LONG_PRESS_MS) re-rolls the current
    // role's patch with a fresh variant (and pushes it onto a per-
    // role history ring). Long press (>= threshold) reverts to the
    // previous entry in that history — undo for unwanted re-rolls.
    if (cc === DISPLAY_ENCODER_CLICK_CC) {
      if (v >= 64) {
        encoderPressedMs = performance.now();
      } else {
        const held = encoderPressedMs ? performance.now() - encoderPressedMs : 0;
        encoderPressedMs = 0;
        if (held >= ENCODER_LONG_PRESS_MS) {
          const reverted = revertLiveTimbre();
          if (!reverted) console.log('[encoder] nothing to revert in this role');
        } else {
          regenerateLiveTimbre();
        }
      }
      return;
    }
    // The 8 panel encoders and 4 faders route through controls.js,
    // which binds them to the selected seed or global parameters.
    if (handleControlCC(cc, v)) return;
    return;
  }
  // Notes
  if (cmd === 0x90 && data[2] > 0) {
    const note = data[1], velocity = data[2];
    const bankA5_8Lo = PAD_NOTE_BANK_A_BASE + 4;
    const bankA5_8Hi = PAD_NOTE_BANK_A_BASE + 7;
    const bankBLo = PAD_NOTE_BANK_B_BASE;
    const bankBHi = PAD_NOTE_BANK_B_BASE + 7;
    const isBankA5_8 = channel === PAD_CHANNEL && note >= bankA5_8Lo && note <= bankA5_8Hi;
    const isBankB    = channel === PAD_CHANNEL && note >= bankBLo && note <= bankBHi;
    // Diagnostic single-pad mode: bypass the plant-mode change and
    // the refresh-all-pads side effect. Send exactly one LED-paint
    // command for the tapped pad with a bright test colour, so the
    // user can see whether a single isolated write works.
    if (diagSinglePadOnly && (isBankA5_8 || isBankB)) {
      // pad index 0..15: bank A = 0..7 (note - PAD_NOTE_BANK_A_BASE),
      // bank B = 8..15 (note - PAD_NOTE_BANK_B_BASE + 8).
      const padIdx = isBankB
        ? (note - PAD_NOTE_BANK_B_BASE + 8)
        : (note - PAD_NOTE_BANK_A_BASE);
      // Rotating colour so successive taps are visually distinct.
      const colours = ['#ff0040', '#40ff00', '#0040ff', '#ffff00', '#ff00ff', '#00ffff'];
      const colour = colours[padIdx % colours.length];
      console.log(`[diag] pad tap idx=${padIdx} note=${note} → paint ${colour}`);
      paintTappedPad(padIdx, colour);
      flashMidiLED();
      return;
    }
    // Bank A pads 5-8 = effect plant modes (drop / muffle / thin / rise).
    if (isBankA5_8) {
      const kind = PAD_BANK_A_PLANT_5_8[note - bankA5_8Lo];
      if (kind && setPlantModeFn) setPlantModeFn(kind);
      flashMidiLED();
      return;
    }
    // Bank B selects plant mode.
    if (isBankB) {
      const kind = PAD_BANK_B_TO_PLANT[note - bankBLo];
      if (kind && setPlantModeFn) setPlantModeFn(kind);
      flashMidiLED();
      return;
    }
    noteOn(note, velocity / 127, 'midi');
    return;
  }
  if (cmd === 0x80 || (cmd === 0x90 && data[2] === 0)) {
    const note = data[1];
    // Pad noteOffs for plant-mode pads are no-ops (mode is sticky).
    const bankA5_8Lo = PAD_NOTE_BANK_A_BASE + 4;
    const bankBHi = PAD_NOTE_BANK_B_BASE + 7;
    if (channel === PAD_CHANNEL && note >= bankA5_8Lo && note <= bankBHi) return;
    noteOff(note);
    return;
  }
}

function flashMidiLED() {
  const led = document.getElementById('midi-led');
  led.classList.add('activity');
  setTimeout(() => led.classList.remove('activity'), 100);
}

// === QWERTY → MIDI ===
const QWERTY_MAP = {
  'a': 55, 'w': 56, 's': 57, 'e': 58, 'd': 59, 'f': 60, 't': 61, 'g': 62, 'y': 63, 'h': 64, 'j': 65, 'i': 66, 'k': 67, 'o': 68, 'l': 69, 'p': 70, ';': 71, "'": 72,
};
const heldKeys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  // Never steal browser / OS shortcuts. Bare letter / spacebar only.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === ' ') {
    e.preventDefault();
    document.getElementById('play-btn').click();
    return;
  }
  if (key === 'r') {
    e.preventDefault();
    document.getElementById('rec-btn').click();
    return;
  }
  if (QWERTY_MAP[key] !== undefined && !heldKeys.has(key)) {
    heldKeys.add(key);
    noteOn(QWERTY_MAP[key], 0.7);
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => {
  const key = e.key.toLowerCase();
  if (QWERTY_MAP[key] !== undefined) {
    heldKeys.delete(key);
    noteOff(QWERTY_MAP[key]);
  }
});

// === On-screen piano ===
const PIANO_LOW = 55;   // G3
const PIANO_HIGH = 79;  // G5 (2 octaves)
const PIANO_KEYS = [];

function buildPiano() {
  const piano = document.getElementById('piano');
  piano.innerHTML = '';
  const whiteKeys = [];
  const blackKeys = [];
  for (let midi = PIANO_LOW; midi <= PIANO_HIGH; midi++) {
    const pc = midi % 12;
    const isBlack = [1, 3, 6, 8, 10].includes(pc);
    if (isBlack) blackKeys.push(midi);
    else whiteKeys.push(midi);
  }
  const whiteW = 100 / whiteKeys.length;
  whiteKeys.forEach((midi, i) => {
    const k = document.createElement('div');
    k.className = 'piano-key white';
    k.style.left = (i * whiteW) + '%';
    k.style.width = whiteW + '%';
    k.dataset.midi = midi;
    if (inScale(midi)) k.classList.add('in-scale');
    if ((midi % 12) === SCALE_ROOT_PC) k.textContent = noteName(midi);
    attachPianoKeyHandlers(k, midi);
    piano.appendChild(k);
    PIANO_KEYS.push({ midi, kind: 'white', el: k });
  });
  // Black keys positioned over the boundary between two whites.
  const blackWPct = whiteW * 0.62;
  blackKeys.forEach((midi) => {
    const whiteBelow = midi - 1;
    const whiteIdx = whiteKeys.indexOf(whiteBelow);
    if (whiteIdx < 0) return;
    const k = document.createElement('div');
    k.className = 'piano-key black';
    k.style.width = blackWPct + '%';
    k.style.left = `calc(${(whiteIdx + 1) * whiteW}% - ${blackWPct / 2}%)`;
    k.dataset.midi = midi;
    attachPianoKeyHandlers(k, midi);
    piano.appendChild(k);
    PIANO_KEYS.push({ midi, kind: 'black', el: k });
  });
}

// Wire pointer events on a piano key. Critically: setPointerCapture
// on pointerdown so the pointer stays "captured" by this key — any
// subsequent pointerup / pointercancel for that pointer ID is
// guaranteed to fire on THIS element regardless of where the cursor
// is when released. Without capture, pointer drift off the key
// before release would orphan the note (pointerup would fire on a
// different element and we'd never call noteOff).
function attachPianoKeyHandlers(k, midi) {
  const release = () => {
    if (k.dataset.held) { noteOff(midi); delete k.dataset.held; }
  };
  k.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { k.setPointerCapture(e.pointerId); } catch (e) {}
    noteOn(midi, 0.7);
    k.dataset.held = '1';
  });
  k.addEventListener('pointerup', release);
  k.addEventListener('pointercancel', release);
  // pointerleave still useful: if capture fails for any reason, this
  // catches the drag-off case too.
  k.addEventListener('pointerleave', release);
}

buildPiano();

// Belt-and-braces safety net: a window-level pointerup releases any
// piano key whose `held` flag wasn't cleared by the per-key handler.
// Triggers in corner cases like a system gesture interruption or the
// window losing focus mid-press.
window.addEventListener('pointerup', () => {
  for (const k of PIANO_KEYS) {
    if (k.el.dataset.held) {
      noteOff(k.midi);
      delete k.el.dataset.held;
    }
  }
});
window.addEventListener('blur', () => {
  // Window lost focus — release everything to be safe.
  murmurPanic();
});

// === Panic — kill every held / decaying live note now ===
// Exposed on window so it can be triggered from DevTools when a note
// gets stuck for any reason. Releases all activeLiveNotes via the
// normal liveNoteOff path, then force-stops any oscillators still in
// the release tail via releasingNotes.
function murmurPanic() {
  // Release everything still marked held on the piano.
  for (const k of PIANO_KEYS) {
    if (k.el.dataset.held) delete k.el.dataset.held;
  }
  // Release all live notes.
  for (const m of [...activeLiveNotes.keys()]) liveNoteOff(m);
  // Force-stop any oscillators still in their release tail. The
  // handles in releasingNotes hold references to the actual voice
  // objects via closure on `release` — but we can also call stop
  // through the output node's disconnect to silence them instantly.
  for (const note of [...releasingNotes]) {
    try {
      if (note.handle && note.handle.output) {
        note.handle.output.disconnect();
      }
    } catch (e) {}
    releasingNotes.delete(note);
  }
  console.log('[panic] released all live notes');
}
if (typeof window !== 'undefined') window.murmurPanic = murmurPanic;

export function highlightPianoKey(midi, on) {
  const k = PIANO_KEYS.find(x => x.midi === midi);
  if (k) k.el.classList.toggle('active', on);
}

export function showFloatingNote(midi) {
  const k = PIANO_KEYS.find(x => x.midi === midi);
  if (!k) return;
  const rect = k.el.getBoundingClientRect();
  const f = document.createElement('div');
  f.className = 'float-note';
  f.textContent = noteName(midi);
  f.style.left = (rect.left + rect.width / 2) + 'px';
  f.style.top = (rect.top - 6) + 'px';
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 1200);
}

// Re-paint in-scale highlights on guardrails change.
window.addEventListener('guardrails-changed', () => {
  for (const k of PIANO_KEYS) {
    if (k.kind === 'white') k.el.classList.toggle('in-scale', state.guardrails && inScale(k.midi));
  }
});
