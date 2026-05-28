// All keyboard-shaped input: live notes, MIDI hardware, QWERTY rows,
// on-screen piano. Every entry point funnels through noteOn/noteOff
// so the rest of the app sees a single, unified note stream.
//
// Lives as one module rather than three because all four input sources
// share state (activeLiveNotes, sustain pedal, MIDI log) and call the
// same release/highlight helpers.

import { freqFromMidi, snapToScale, inScale, noteName, SCALE_ROOT_PC } from './constants.js';
import {
  audioCtx, masterGain, drumBus, initAudio,
} from './audio/context.js';
import { playPatch } from './audio/voices.js';
import { DRUM_KIT, DRUM_KIT_FUNDAMENTAL_HZ } from './audio/drum-kit.js';
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
  // Run the live trigger first so we can record what the user
  // ACTUALLY HEARD — `liveNoteOn` applies LIVE_ROLE_OCTAVE_SHIFT
  // (bass plays two octaves below the pressed key, etc.). Storing
  // the raw key would make playback an octave or more off from what
  // the user heard while recording.
  const playedMidi = liveNoteOn(midi, velocity, source);
  if (state.isRecording) {
    if (!state.recordingBuffer) {
      state.recordingBuffer = { startTime: performance.now(), notes: [], lastActivityMs: performance.now() };
    }
    state.recordingBuffer.notes.push({
      midi: playedMidi,   // the sounded pitch — what playback should reproduce
      key: midi,          // the original input key — used by noteOff to find this entry
      t: performance.now() - state.recordingBuffer.startTime,
      velocity,
      noteOnMs: performance.now(),
      duration: null,
    });
    state.recordingBuffer.lastActivityMs = performance.now();
    rescheduleRecordingAutoFinish();
  }
  highlightPianoKey(midi, true);
  highlightPianoKey(playedMidi, true);
  flashMidiLED();
  return playedMidi;
}

export function noteOff(midi) {
  if (state.isRecording && state.recordingBuffer) {
    for (let i = state.recordingBuffer.notes.length - 1; i >= 0; i--) {
      const note = state.recordingBuffer.notes[i];
      const matches = note.key != null ? note.key === midi : note.midi === midi;
      if (matches && note.duration === null) {
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

// === Aftertouch → live filter modulation ===
// Channel aftertouch (0xD0) → ramp filter cutoff on every active
// live note via the voice's liveParams.cutoff. Pressure 0 = base
// cutoff, pressure 1 = base + AFTERTOUCH_CUTOFF_RANGE_HZ.
const AFTERTOUCH_BASE_CUTOFF_HZ = 800;
const AFTERTOUCH_CUTOFF_RANGE_HZ = 4000;
function applyChannelAftertouch(pressure) {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const targetHz = AFTERTOUCH_BASE_CUTOFF_HZ + pressure * AFTERTOUCH_CUTOFF_RANGE_HZ;
  for (const note of activeLiveNotes.values()) {
    rampCutoffOnHandle(note.handle, targetHz, now);
  }
  for (const note of releasingNotes) {
    rampCutoffOnHandle(note.handle, targetHz, now);
  }
}

// Poly aftertouch (0xA0) → per-note modulation. We look up the
// specific live note by midi (or the bank-B pad mapping) and ramp
// its cutoff only.
function applyPolyAftertouch(midi, pressure) {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  // The pad might have been mapped to a different midi via bank-B
  // scale routing — translate if so.
  const liveMidi = bankBPadNoteToPadMidi.get(midi) || midi;
  const note = activeLiveNotes.get(liveMidi);
  if (!note) return;
  const targetHz = AFTERTOUCH_BASE_CUTOFF_HZ + pressure * AFTERTOUCH_CUTOFF_RANGE_HZ;
  rampCutoffOnHandle(note.handle, targetHz, now);
}

function rampCutoffOnHandle(handle, targetHz, now) {
  if (!handle || !handle.voices) return;
  for (const v of handle.voices) {
    if (v.liveParams && v.liveParams.cutoff) {
      try { v.liveParams.cutoff.setTargetAtTime(targetHz, now, 0.02); } catch (e) {}
    }
  }
}

function setSustainPedal(down) {
  if (down === state.sustainPedalDown) return;
  state.sustainPedalDown = down;
  // Visible logging — sustain state is invisible to the user, so a
  // CC 64 that gets stuck "on" silently swallows every subsequent
  // note-off. Print to console so it shows up if we ever wonder
  // why notes are hanging.
  console.log(`[sustain] pedal ${down ? 'DOWN' : 'UP'}` +
    (down ? '' : ` — releasing ${sustainedMidis.size} held notes`));
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
  TRANSPORT_RISING_THRESHOLD,
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

// === Drum-kit pad trigger (bank A, pad layout v2) ===
// Bank-A pad N (notes 36-43) fires DRUM_KIT[N] at its fixed
// fundamental, routed through drumBus so it gets the kit compressor
// glue. One-shot — pad release ignored.
//
// While recording, each hit is also pushed into the recording buffer
// with a kind:'drum' marker so finishRecording can split drum hits
// from tonal notes and plant a drum loop as one seed per slot used.
function fireDrumPad(slot, velocity) {
  if (slot < 0 || slot >= DRUM_KIT.length) return;
  if (state.isRecording) {
    if (!state.recordingBuffer) {
      state.recordingBuffer = { startTime: performance.now(), notes: [], lastActivityMs: performance.now() };
    }
    state.recordingBuffer.notes.push({
      kind: 'drum',
      slot,
      t: performance.now() - state.recordingBuffer.startTime,
      velocity,
    });
    state.recordingBuffer.lastActivityMs = performance.now();
    rescheduleRecordingAutoFinish();
  }
  if (!audioCtx) { initAudio(); return; }
  const freq = DRUM_KIT_FUNDAMENTAL_HZ[slot];
  const gain = Math.max(0.1, Math.min(1.0, velocity)) * 0.5;
  // Drum patches are category:'drum' so playPatch fires one-shot
  // mode (internal envelope from voice, no shared attack/release).
  // Route through drumBus when available; fall back to masterGain.
  playPatch(DRUM_KIT[slot].patch, audioCtx.currentTime + 0.005, freq, gain, null,
    (env) => env.connect(drumBus || masterGain));
}

// === Scale-pad live trigger (bank B, pad layout v2) ===
// Bank-B pad N plays the current liveTimbre at the Nth scale step
// above the keyboard root. Guardrails on → minor pentatonic + octave;
// off → chromatic. The pad stays held: noteOff releases it.
const BANK_B_SCALE_OFFSETS = [0, 2, 3, 5, 7, 8, 10, 12];
const BANK_B_CHROMATIC_OFFSETS = [0, 1, 2, 3, 4, 5, 6, 7];
const BANK_B_ROOT_MIDI = 60;   // middle C — could be made tunable later
function bankBPadMidi(slot) {
  const offsets = state.guardrails ? BANK_B_SCALE_OFFSETS : BANK_B_CHROMATIC_OFFSETS;
  return BANK_B_ROOT_MIDI + (offsets[slot] || 0);
}
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
    onAccessGranted(access);
  }).catch((err) => {
    console.warn('MIDI access (with SysEx) denied; retrying without SysEx', err);
    navigator.requestMIDIAccess().then((access) => {
      onAccessGranted(access);
    }).catch((err2) => {
      console.warn('MIDI access denied', err2);
      document.getElementById('midi-label').textContent = 'midi denied';
    });
  });
}

// Initial enumeration of already-connected MIDI devices is unreliable
// on Linux/Chromium — the WebMIDI client opened by requestMIDIAccess
// can miss ALSA ports that existed BEFORE that client was created.
// Symptom: the user has to unplug + replug the MiniLab to get the app
// to notice it, even though permission was already granted.
//
// Mitigations layered here:
//   1. Re-call requestMIDIAccess on a back-off schedule. Each call
//      makes Chrome create a fresh seq client which DOES enumerate
//      already-connected devices. Permission is cached after the
//      first grant, so no prompts.
//   2. State-change debounced refresh covers hot-plug events.
//   3. First user gesture also triggers a re-probe — Brave/Chrome in
//      some configs gate enumeration behind a user gesture.
function onAccessGranted(access) {
  installAccess(access);
  for (const delay of [250, 750, 2000, 4000, 8000]) {
    setTimeout(probeForDevicesIfMissing, delay);
  }
  const reprobeOnce = () => {
    probeForDevicesIfMissing();
    window.removeEventListener('pointerdown', reprobeOnce, true);
    window.removeEventListener('keydown', reprobeOnce, true);
  };
  window.addEventListener('pointerdown', reprobeOnce, true);
  window.addEventListener('keydown', reprobeOnce, true);
}

function installAccess(access) {
  midiAccess = access;
  setMidiAccessRef(access);
  access.onstatechange = refreshMIDIInputsDebounced;
  refreshMIDIInputs();
}

// If we don't have ANY non-skipped inputs yet, ask Chrome for a new
// MIDIAccess. This rebuilds the seq client and surfaces ports that
// the original access object missed. We only do this when nothing's
// detected, so a healthy session isn't disturbed.
function probeForDevicesIfMissing() {
  if (!midiAccess) return;
  const haveInputs = countUsableInputs(midiAccess) > 0;
  if (haveInputs) return;
  if (!navigator.requestMIDIAccess) return;
  navigator.requestMIDIAccess({ sysex: true })
    .then(installAccess)
    .catch(() => {
      navigator.requestMIDIAccess()
        .then(installAccess)
        .catch(() => {});
    });
}

function countUsableInputs(access) {
  let n = 0;
  for (const input of access.inputs.values()) {
    if (MIDI_PORT_SKIP_PATTERN.test(input.name || '')) continue;
    n++;
  }
  return n;
}

if (typeof window !== 'undefined') {
  window.murmurMIDIDiag = () => {
    if (!midiAccess) return console.log('[midi-diag] no MIDIAccess yet');
    const rows = [];
    for (const input of midiAccess.inputs.values()) {
      rows.push({ direction: 'in', name: input.name, manufacturer: input.manufacturer, state: input.state, connection: input.connection, skipped: MIDI_PORT_SKIP_PATTERN.test(input.name || '') });
    }
    for (const output of midiAccess.outputs.values()) {
      rows.push({ direction: 'out', name: output.name, manufacturer: output.manufacturer, state: output.state, connection: output.connection });
    }
    if (rows.length === 0) console.log('[midi-diag] no ports visible to the page — try replug or run navigator.requestMIDIAccess() manually');
    else console.table(rows);
    return rows;
  };
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

// === Latency measurement ===
//
// Two distinct numbers, displayed in the bottom-right audio-status pill:
//   midi  — wall-clock gap between the MIDI message's `evt.timeStamp`
//           (OS-side arrival) and JS handler completion. This is the
//           "extra" cost incurred ONLY when input comes from a MIDI
//           device — driver delivery + browser dispatch + handler work.
//           Captured on each MIDI noteOn; rolling-averaged.
//   audio — `audioCtx.outputLatency + baseLatency` in ms. The audio
//           buffer + driver delay between scheduling a sound at
//           currentTime and the user actually hearing it. Applies to
//           EVERY sound the app produces: pattern playback, drums,
//           live keys. Same number whether MIDI or on-screen
//           keyboard initiated it.
// Total for a MIDI key press ≈ midi + audio. Total for a pattern
// note or on-screen-keyboard press ≈ audio alone.
// Exposed via murmurLatency() in devtools.
const latencyHistory = [];
let lastMidiHandlerStart = 0;
let lastMidiLatencyMs = null;   // last captured midi delivery+handler
function recordHandlerStart() { lastMidiHandlerStart = performance.now(); }
export function recordPlayLatency(evtTimeStamp, audioCtxRef) {
  if (evtTimeStamp == null || !audioCtxRef) return;
  const handlerEnd = performance.now();
  // Single "midi" number: gap from MIDI message arriving at OS to JS
  // finishing its handler. Includes both browser delivery delay and
  // our handler work — both add to the perceived press-to-hear gap.
  const midi = Math.max(0, handlerEnd - evtTimeStamp);
  const audio = ((audioCtxRef.outputLatency || 0) + (audioCtxRef.baseLatency || 0)) * 1000;
  lastMidiLatencyMs = midi;
  latencyHistory.push({ midi, audio, ts: handlerEnd });
  while (latencyHistory.length > 50) latencyHistory.shift();
  refreshLatencyDisplay();
}

// Push the current numbers into the audio-status pill. Polled once
// a second so the audio number refreshes as the context settles,
// and called immediately whenever a MIDI note updates the midi side.
function refreshLatencyDisplay() {
  if (typeof window.showAudioStatusLatency !== 'function') return;
  const audioMs = audioCtx ? ((audioCtx.outputLatency || 0) + (audioCtx.baseLatency || 0)) * 1000 : null;
  window.showAudioStatusLatency(audioMs, lastMidiLatencyMs);
}
if (typeof setInterval !== 'undefined') {
  setInterval(refreshLatencyDisplay, 1000);
}

if (typeof window !== 'undefined') {
  window.murmurLatency = () => {
    const baseMs = audioCtx ? (audioCtx.baseLatency || 0) * 1000 : 0;
    const outputMs = audioCtx ? (audioCtx.outputLatency || 0) * 1000 : 0;
    const audioMs = audioCtx ? baseMs + outputMs : null;
    const sampleRate = audioCtx ? audioCtx.sampleRate : null;
    const rows = [
      { phase: 'audio.base (script render buffer)', ms: baseMs.toFixed(2) },
      { phase: 'audio.output (device + system)', ms: outputMs.toFixed(2) },
      { phase: 'audio.total = base + output', ms: audioMs == null ? '—' : audioMs.toFixed(2) },
    ];
    if (latencyHistory.length > 0) {
      const last = latencyHistory[latencyHistory.length - 1];
      const avg = latencyHistory.reduce((s, x) => s + x.midi, 0) / latencyHistory.length;
      rows.push({ phase: 'midi.last (delivery + handler)', ms: last.midi.toFixed(2) });
      rows.push({ phase: 'midi.avg (rolling 50)', ms: avg.toFixed(2) });
      if (audioMs != null) {
        rows.push({ phase: 'TOTAL keypress = midi.last + audio.total', ms: (last.midi + audioMs).toFixed(2) });
      }
    } else {
      rows.push({ phase: 'midi', ms: 'no presses yet' });
    }
    console.table(rows);
    console.log('[latency] sampleRate:', sampleRate, 'Hz · context state:', audioCtx && audioCtx.state);
    if (outputMs > 60) {
      console.log('[latency] %coutputLatency is high — common causes: Bluetooth audio (A2DP ≈ 150-300ms), virtual audio device, OS audio session with a fat buffer. Try wired output / a different audio device in the OS sound settings.', 'color:#ffc56b');
    }
    return {
      audio: { base: baseMs, output: outputMs, total: audioMs, sampleRate },
      midi: latencyHistory.length > 0
        ? { last: latencyHistory[latencyHistory.length - 1].midi,
            avg: latencyHistory.reduce((s, x) => s + x.midi, 0) / latencyHistory.length,
            samples: latencyHistory.length }
        : null,
      total_keypress: latencyHistory.length > 0 && audioMs != null
        ? latencyHistory[latencyHistory.length - 1].midi + audioMs
        : null,
    };
  };
}

function handleMIDIMessage(evt) {
  recordHandlerStart();
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
  // Channel aftertouch (0xD0): single-byte pressure for all notes
  // on this channel. Used for expression on held notes — modulates
  // every active live note's filter cutoff via the new liveParams
  // surface from src/audio/voices.js.
  if (cmd === 0xd0) {
    const pressure = data[1] / 127;
    applyChannelAftertouch(pressure);
    return;
  }
  // Poly aftertouch (0xA0): per-note pressure. Targets the specific
  // note's voice. Useful for shaped drone leans on bank-B held pads.
  if (cmd === 0xa0) {
    const midi = data[1];
    const pressure = data[2] / 127;
    applyPolyAftertouch(midi, pressure);
    return;
  }
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
    // Shift + transport buttons send momentary action CCs. Trigger
    // on rising edge (value crossing the threshold from below); the
    // release back to 0 is ignored. We don't track the shift
    // modifier ourselves — the device handles that internally and
    // just sends us the action CC.
    {
      const isTransportCC = cc === TRANSPORT_CC.loop || cc === TRANSPORT_CC.stop
        || cc === TRANSPORT_CC.playStop || cc === TRANSPORT_CC.record
        || cc === TRANSPORT_CC.tap;
      if (isTransportCC) {
        const t = TRANSPORT_RISING_THRESHOLD;
        const rising = v >= t && (lastTransportCC[cc] || 0) < t;
        lastTransportCC[cc] = v;
        if (rising) {
          if (cc === TRANSPORT_CC.playStop) {
            if (state.isPlaying) transportStop(); else transportPlay();
          } else if (cc === TRANSPORT_CC.stop) {
            transportStop();
          } else if (cc === TRANSPORT_CC.record) {
            transportRecord();
          } else if (cc === TRANSPORT_CC.tap) {
            transportTap();
          } else if (cc === TRANSPORT_CC.loop) {
            // No loop state in the app today — just log so the user
            // sees the press lands. Hook into a future loop feature.
            console.log('[transport] shift+loop pressed (no action wired)');
          }
        }
        return;
      }
    }
    // CCs we know about but don't act on (e.g. CC 27 is the bare
    // shift-state indicator). Swallow them silently so they don't
    // fall through to controls.js as encoder/fader CCs.
    if (TRANSPORT_UNMAPPED_CCS.has(cc)) return;
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
  // === Notes ===
  // PAD ROUTING (pad layout v2)
  //   Bank A (notes 36-43, ch10): drum kit slots 0-7. One-shot.
  //   Bank B (notes 44-51, ch10): liveTimbre at scale pitches. Held.
  //   Shift+pad: TODO — device sends different CCs (not notes) for
  //     shifted gestures on this template; map them when the user
  //     enumerates them on-device.
  if (cmd === 0x90 && data[2] > 0) {
    const note = data[1], velocity = data[2];
    const bankALo = PAD_NOTE_BANK_A_BASE;
    const bankAHi = PAD_NOTE_BANK_A_BASE + 7;
    const bankBLo = PAD_NOTE_BANK_B_BASE;
    const bankBHi = PAD_NOTE_BANK_B_BASE + 7;
    const isBankA = channel === PAD_CHANNEL && note >= bankALo && note <= bankAHi;
    const isBankB = channel === PAD_CHANNEL && note >= bankBLo && note <= bankBHi;

    // Diagnostic single-pad mode: paint the tapped pad and return.
    if (diagSinglePadOnly && (isBankA || isBankB)) {
      const padIdx = isBankB ? (note - bankBLo + 8) : (note - bankALo);
      const colours = ['#ff0040', '#40ff00', '#0040ff', '#ffff00', '#ff00ff', '#00ffff'];
      const colour = colours[padIdx % colours.length];
      console.log(`[diag] pad tap idx=${padIdx} note=${note} → paint ${colour}`);
      paintTappedPad(padIdx, colour);
      flashMidiLED();
      return;
    }

    // Bank A → drum kit slot (one-shot, no noteOff to track).
    if (isBankA) {
      fireDrumPad(note - bankALo, velocity / 127);
      flashMidiLED();
      return;
    }
    // Bank B → liveTimbre at scale pitch. Sustained — noteOff
    // released below.
    if (isBankB) {
      const padMidi = bankBPadMidi(note - bankBLo);
      // Stash original pad note so noteOff can find the live entry.
      bankBPadNoteToPadMidi.set(note, padMidi);
      noteOn(padMidi, velocity / 127, 'midi-pad-b');
      recordPlayLatency(evt.timeStamp, audioCtx);
      flashMidiLED();
      return;
    }
    // Anything else on a keyboard channel → live note.
    noteOn(note, velocity / 127, 'midi');
    recordPlayLatency(evt.timeStamp, audioCtx);
    return;
  }
  if (cmd === 0x80 || (cmd === 0x90 && data[2] === 0)) {
    const note = data[1];
    const bankALo = PAD_NOTE_BANK_A_BASE;
    const bankAHi = PAD_NOTE_BANK_A_BASE + 7;
    const bankBLo = PAD_NOTE_BANK_B_BASE;
    const bankBHi = PAD_NOTE_BANK_B_BASE + 7;
    // Bank A drum pads are one-shot; noteOff is a no-op.
    if (channel === PAD_CHANNEL && note >= bankALo && note <= bankAHi) return;
    // Bank B sustained pad: release via the stashed scale midi.
    if (channel === PAD_CHANNEL && note >= bankBLo && note <= bankBHi) {
      const padMidi = bankBPadNoteToPadMidi.get(note);
      if (padMidi != null) {
        noteOff(padMidi);
        bankBPadNoteToPadMidi.delete(note);
      }
      return;
    }
    noteOff(note);
    return;
  }
}

// Bank-B pads send a fixed note but PLAY a scale-derived midi. The
// device's noteOff carries the pad's original note number; we need
// to know which live-midi to release. Map kept while the pad is
// held.
const bankBPadNoteToPadMidi = new Map();

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
  // Sustain pedal is the most common cause of stuck notes — if CC 64
  // got stuck "on" and never released, every noteOff has been silently
  // deferred. Clear that state first, then release everything.
  state.sustainPedalDown = false;
  sustainedMidis.clear();
  for (const m of [...activeLiveNotes.keys()]) liveNoteOff(m);
  // Force-stop any oscillators still in their release tail.
  for (const note of [...releasingNotes]) {
    try {
      if (note.handle && note.handle.output) {
        note.handle.output.disconnect();
      }
    } catch (e) {}
    releasingNotes.delete(note);
  }
  console.log('[panic] released all live notes + cleared sustain');
}
if (typeof window !== 'undefined') {
  window.murmurPanic = murmurPanic;
  // Lighter-weight: just clear sustain, don't touch held notes.
  // Useful when notes are hanging but you haven't lifted the pedal
  // yet (or there is no pedal but state is stuck).
  window.murmurReleaseSustain = () => {
    if (!state.sustainPedalDown) {
      console.log('[sustain] already up; sustainedMidis size =', sustainedMidis.size);
    }
    state.sustainPedalDown = false;
    for (const m of [...sustainedMidis]) liveNoteOff(m);
    sustainedMidis.clear();
    console.log('[sustain] cleared');
  };
}

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
