'use strict';

import {
  RHYTHM_OPTIONS, LENGTH_OPTIONS, SPHERE_OPTIONS, RIPPLE_DELAY_OPTIONS,
  CLOUD_SIZE_OPTIONS, SWING_OPTIONS, POLY_RATIOS,
  nearestOptionIdx,
  SCALE_PITCH_CLASSES, SCALE_ROOT_PC, snapToScale, inScale,
  freqFromMidi, midiFromFreq, NOTE_NAMES, noteName,
  SEED_COLORS, WEAVE_COLOR, RIPPLE_COLOR, CLOUD_COLOR, POLY_COLOR,
  makeHarmonicsArr, shuffleArr, pickWeighted,
} from './constants.js';
import { patchFromLegacySeed, harmonicsForPatch } from './audio/patches.js';
import { BPM, BEAT_MS, BAR_MS, setTempo } from './tempo.js';
import {
  TIMBRE_ROLES, activeRole, setActiveRole, liveTimbre, rollLiveTimbre,
  generateKick, generateSnare, generateHihat,
  generateBass, generateMelody, generateVoice,
} from './timbres.js';
import {
  audioCtx, masterGain, supportsPeriodicWave, NUM_HARMONICS,
  showAudioStatus, withTimeout, tryCreateContext, ensureAudio, initAudio,
  setMasterVol, buildPeriodicWave, setOscWave, createNoiseBuffer,
  onContextCreated,
} from './audio/context.js';
import { VOICES, playPatch } from './audio/voices.js';
import {
  setupRippleChain, setupCloudChain, createReverbIR, setupModifierChain,
} from './audio/chains.js';
import {
  BOMB_KINDS, SWEEP_KINDS, bombCurrentRadius, activeBombsAffecting,
  routeFinalOutput, routeToModifiers, spawnBomb, spawnSweep,
} from './audio/events.js';
import {
  seeds, activeEvents, snapshots,
  activeLiveNotes, releasingNotes, sustainedMidis,
  state, seedById,
} from './state.js';
import {
  SVGNS, canvasEl, canvasWrap, spheresLayer, tethersLayer, seedsLayer,
  tapMarkersLayer, seedNodes,
  PEAK_STRENGTH, PEAK_WIDTH, PEAK_TIP_FACTOR,
  makeSeed, removeSeed, radiusForFundamental, blobPath, attachmentsForSeed,
  renderSeed, renderSpheres, renderTethers, syncRenderedSeeds,
} from './seeds.js';
import {
  playNoteAt, playSeedStep, scheduleAhead, setStepHighlightHandler,
} from './scheduler.js';
import {
  inspectorEl, selectSeed, setTakeSnapshotFn, setReevaluateAllCapturesFn,
} from './inspector.js';
import {
  takeSnapshot, clearCanvas, revertToSnapshot, setLiveNoteOffFn,
} from './snapshots.js';

// Inspector / snapshots use handlers so they don't have to import
// from main.js (which would be a cycle). Function declarations are
// hoisted, so referring to them here resolves at call time.
setTakeSnapshotFn(takeSnapshot);
setReevaluateAllCapturesFn(() => reevaluateAllCaptures());
setLiveNoteOffFn(liveNoteOff);

// High-level tempo change — updates state via setTempo, then rescales
// each seed's bar-fraction-derived timings (intervalMs, decay, attack,
// delay) so the music stays musically aligned across tempo changes,
// and refreshes the on-screen BPM readout.
function setBPM(newBPM) {
  const oldBar = setTempo(newBPM);
  for (const s of seeds) {
    if (s.intervalMs) s.intervalMs = (s.intervalMs / oldBar) * BAR_MS;
    if (s.decay)      s.decay      = (s.decay      / oldBar) * BAR_MS;
    if (s.attackMs)   s.attackMs   = (s.attackMs   / oldBar) * BAR_MS;
    if (s.delayMs)    s.delayMs    = (s.delayMs    / oldBar) * BAR_MS;
    s.nextTrigger = 0;  // re-phase on next schedule pass
  }
  const el = document.getElementById('tempo-val');
  if (el) el.textContent = BPM + ' bpm';
}

//
// =========================================================================
//  TIMBRE ROLES — procedural sound generation
//  Each role generates harmonics + decay + default rhythm characteristic
//  of its musical function. The same role re-rolled produces a different
//  variation in the same family.
// =========================================================================
//
//
// =========================================================================
//  STATE
// =========================================================================
//
const RECORD_AUTO_FINISH_MS = 1500;  // stop after this much silence

//
// =========================================================================
//  AUDIO orchestration left in main.js: playback state + first-interaction
//  bootstrap. The rest of the audio surface lives in ./audio/.
// =========================================================================
//

// Try creating the context on first user gesture so audio is ready by
// the time the scheduler fires. tryCreateContext is idempotent.
let firstInteractionHandled = false;
function handleFirstInteraction() {
  if (firstInteractionHandled) return;
  firstInteractionHandled = true;
  ensureAudio();
}
document.addEventListener('pointerdown', handleFirstInteraction, { capture: true });
document.addEventListener('keydown', handleFirstInteraction, { capture: true });
document.addEventListener('touchstart', handleFirstInteraction, { capture: true });

// === LIVE PLAY (sustained) ===
// noteOn creates an oscillator + envelope and stores them in activeLiveNotes
// keyed by INPUT midi (the raw key the user pressed). noteOff fires the
// release ramp and stops the oscillator after release. Holding a key produces
// a sustained note; releasing it produces a release tail.

function liveNoteOn(midi, velocity = 0.7, source = 'qwerty') {
  if (!audioCtx) { initAudio(); return midi; }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  // Retrigger if already held — release old, start fresh
  if (activeLiveNotes.has(midi)) liveNoteOff(midi);
  // Live input never snaps to scale, regardless of source.
  const targetMidi = midi;
  const freq = freqFromMidi(targetMidi);
  const patch = liveTimbre.patch;
  const handle = playPatch(patch, audioCtx.currentTime, freq, 0.25 * velocity, null, (n) => n.connect(masterGain));
  if (handle && handle.detune) handle.detune(state.pitchBendCents, audioCtx.currentTime);
  activeLiveNotes.set(midi, { handle, targetMidi });
  showFloatingNote(targetMidi);
  return targetMidi;
}

// Notes that have been released but are still ringing out. We keep these
// reachable so pitch-bend updates during the decay tail continue to take
// effect — otherwise bending the strip stops working the moment you lift
// your finger off the key, which feels broken on a real keyboard.

function liveNoteOff(midi) {
  const note = activeLiveNotes.get(midi);
  if (!note) return;
  const now = audioCtx.currentTime;
  try { note.handle.release(now); } catch (e) {}
  activeLiveNotes.delete(midi);
  releasingNotes.add(note);
  // The patch envelope's releaseMs determines the tail length. Use a
  // conservative upper bound so the bend-during-release Set drops
  // entries well after the tail has gone silent.
  setTimeout(() => releasingNotes.delete(note), 2000);
}

// Backwards-compat alias for any code still calling playLiveNote
function playLiveNote(midi, velocity = 0.7) { return liveNoteOn(midi, velocity); }


//
// =========================================================================
//  KEYBOARD INPUT (MIDI + QWERTY + on-screen piano)
//  All three sources end at noteOn(midi, velocity) → noteOff(midi).
// =========================================================================
//
function noteOn(midi, velocity, source = 'qwerty') {
  // If recording, push this note into the buffer.
  if (state.isRecording) {
    if (!state.recordingBuffer) {
      state.recordingBuffer = { startTime: performance.now(), notes: [], lastActivityMs: performance.now() };
    }
    state.recordingBuffer.notes.push({
      midi,
      t: performance.now() - state.recordingBuffer.startTime,
      velocity,
      noteOnMs: performance.now(),
      duration: null,  // filled in on noteOff
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

function noteOff(midi) {
  // Capture duration during recording — find the most recent open note with this midi
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

// Auto-finish recording when there's been no activity AND no keys held.
// Without the held-keys check, holding a long note would falsely auto-finish.
function rescheduleRecordingAutoFinish() {
  if (!state.recordingBuffer) return;
  clearTimeout(state.recordingBuffer.silenceTimer);
  state.recordingBuffer.silenceTimer = setTimeout(checkAutoFinishRecording, RECORD_AUTO_FINISH_MS);
}
function checkAutoFinishRecording() {
  if (!state.isRecording || !state.recordingBuffer) return;
  if (activeLiveNotes.size > 0) {
    // Keys still held — recheck in 100ms
    state.recordingBuffer.silenceTimer = setTimeout(checkAutoFinishRecording, 100);
    return;
  }
  const sinceActivity = performance.now() - state.recordingBuffer.lastActivityMs;
  if (sinceActivity < RECORD_AUTO_FINISH_MS) {
    state.recordingBuffer.silenceTimer = setTimeout(checkAutoFinishRecording, RECORD_AUTO_FINISH_MS - sinceActivity + 50);
    return;
  }
  finishRecording();
}

// === Web MIDI ===
let midiAccess = null;
const midiOutputs = [];  // populated by refreshMIDIInputs; reserved for SysEx light/screen control

// === Expressive controls (pitch bend, sustain) ===
const PITCH_BEND_RANGE_SEMITONES = 2;   // standard default
function applyPitchBend(normalised) {
  // normalised in [-1, +1]. Convert to cents and push to every held and
  // releasing note so the bend follows through into the decay tail.
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

// === Pad routing ===
// MiniLab 3 pads sit on MIDI channel 10.
//   Bank A pads 1-4 (notes 36-39): play pitched live notes (drum surface).
//   Bank A pads 5-8 (notes 40-43): transport — STOP, PLAY, REC, TAP.
//     These pads are labelled with transport icons on the device in DAW
//     mode, so mapping them to transport functions matches what the user
//     sees printed under the pads.
//   Bank B (notes 44-51): plant-mode selector. User switches banks on
//     the device (local-only — no MIDI sent).
const PAD_BANK_B_TO_PLANT = [
  'drop',   // pad 1 (note 44)
  'muffle', // pad 2 (note 45)
  'thin',   // pad 3 (note 46)
  'rise',   // pad 4 (note 47)
  'voice',  // pad 5 (note 48)
  'weave',  // pad 6 (note 49)
  'ripple', // pad 7 (note 50)
  'cloud',  // pad 8 (note 51)
];

// === Transport ===
function transportStop() {
  if (typeof state.isPlaying !== 'undefined' && state.isPlaying) {
    document.getElementById('play-btn').click();
  }
}
function transportPlay() {
  if (typeof state.isPlaying !== 'undefined' && !state.isPlaying) {
    document.getElementById('play-btn').click();
  }
}
function transportRecord() {
  document.getElementById('rec-btn').click();
}
// Tap tempo — average the last few inter-tap intervals and apply to BPM.
// Stale taps drop after 4 seconds so a fresh series doesn't get poisoned
// by an earlier abandoned attempt.
const tapTempoTaps = [];
function transportTap() {
  const now = performance.now();
  while (tapTempoTaps.length && now - tapTempoTaps[0] > 4000) tapTempoTaps.shift();
  tapTempoTaps.push(now);
  if (tapTempoTaps.length < 2) return;
  let total = 0;
  for (let i = 1; i < tapTempoTaps.length; i++) total += tapTempoTaps[i] - tapTempoTaps[i - 1];
  const avgMs = total / (tapTempoTaps.length - 1);
  const bpm = Math.round(60000 / avgMs);
  if (bpm < 40 || bpm > 240) return;
  setBPM(bpm);
  const slider = document.getElementById('tempo-slider');
  if (slider) slider.value = bpm;
  const tempoVal = document.getElementById('tempo-val');
  if (tempoVal) tempoVal.textContent = bpm + ' bpm';
}

// === MIDI debug log ===
// Every incoming MIDI message is recorded so we can dump a trace
// to disk and diagnose what a particular controller is actually
// sending. Ring-buffered so a long session doesn't run away.
const MIDI_LOG_MAX = 8000;
const midiLog = [];
let midiVerbose = false;  // toggle via window.murmurMidiVerbose = true in DevTools
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
// Toggle real-time console logging via DevTools: window.murmurMidiVerbose = true
Object.defineProperty(window, 'murmurMidiVerbose', {
  get: () => midiVerbose,
  set: (v) => { midiVerbose = !!v; console.log('[midi] verbose logging =', midiVerbose); },
});

function setupMIDI() {
  if (!navigator.requestMIDIAccess) {
    document.getElementById('midi-label').textContent = 'no midi support';
    return;
  }
  navigator.requestMIDIAccess({ sysex: true }).then((access) => {
    midiAccess = access;
    refreshMIDIInputs();
    access.onstatechange = refreshMIDIInputs;
  }).catch((err) => {
    console.warn('MIDI access (with SysEx) denied; retrying without SysEx', err);
    navigator.requestMIDIAccess().then((access) => {
      midiAccess = access;
      refreshMIDIInputs();
      access.onstatechange = refreshMIDIInputs;
    }).catch((err2) => {
      console.warn('MIDI access denied', err2);
      document.getElementById('midi-label').textContent = 'midi denied';
    });
  });
}
// Skip MIDI ports that aren't carrying user-played notes. Devices like the
// MiniLab 3 expose multiple ports for different protocols — the MCU/HUI
// port sends encoder data as pitch-bend, the ALV port talks to Analog Lab,
// DIN THRU is the physical 5-pin pass-through, "Midi Through" is the linux
// system loopback. None of these are what the user is playing.
const MIDI_PORT_SKIP_PATTERN = /\b(mcu|hui|alv|din[ _-]?thru|midi[ _-]?through|thru)\b/i;

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
  midiOutputs.length = 0;
  for (const output of midiAccess.outputs.values()) {
    if (MIDI_PORT_SKIP_PATTERN.test(output.name || '')) continue;
    midiOutputs.push(output);
  }
  const led = document.getElementById('midi-led');
  const label = document.getElementById('midi-label');
  if (inputCount > 0) {
    led.classList.add('connected');
    label.textContent = firstName.toLowerCase().replace(/^.*:/, '').slice(0, 14);
  } else {
    led.classList.remove('connected');
    label.textContent = 'no midi';
  }
}
function handleMIDIMessage(evt) {
  logMIDI(evt, evt.target && evt.target.name);
  const data = evt.data;
  const status = data[0];
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
    if (cc === 64) { setSustainPedal(v >= 64); return; }
    // MiniLab 3 main rotary (relative-1 encoding): 65-67 = +1..+3,
    // 61-63 = -3..-1, 64 = no change. Roll the live timbre to the
    // next pitched role and regenerate a fresh harmonic profile.
    if (cc === 28) {
      if (v > 64) rollLiveTimbre(1);
      else if (v < 64) rollLiveTimbre(-1);
      return;
    }
    return;
  }
  // Notes
  if (cmd === 0x90 && data[2] > 0) {
    const note = data[1], velocity = data[2];
    // MiniLab 3 pad bank A pads 5-8 = transport (stop/play/record/tap)
    if (channel === 10 && note >= 40 && note <= 43) {
      if (note === 40) transportStop();
      else if (note === 41) transportPlay();
      else if (note === 42) transportRecord();
      else if (note === 43) transportTap();
      flashMidiLED();
      return;
    }
    // MiniLab 3 pad bank B selects plant mode
    if (channel === 10 && note >= 44 && note <= 51) {
      const kind = PAD_BANK_B_TO_PLANT[note - 44];
      if (kind) setPlantMode(kind);
      flashMidiLED();
      return;
    }
    noteOn(note, velocity / 127, 'midi');
    return;
  }
  if (cmd === 0x80 || (cmd === 0x90 && data[2] === 0)) {
    const note = data[1];
    // Transport + bank B pads are momentary; ignore their note-off.
    if (channel === 10 && note >= 40 && note <= 51) return;
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
// Two rows of keys spanning ~2 octaves. White keys on home row.
const QWERTY_MAP = {
  // Lower octave (a-row = white, w-row = black)
  'a': 55, 'w': 56, 's': 57, 'e': 58, 'd': 59, 'f': 60, 't': 61, 'g': 62, 'y': 63, 'h': 64, 'j': 65, 'i': 66, 'k': 67, 'o': 68, 'l': 69, 'p': 70, ';': 71, "'": 72,
};
const heldKeys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  // Don't intercept when typing in form fields
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
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
const PIANO_KEYS = [];   // {midi, kind: 'white'|'black', el}

function buildPiano() {
  const piano = document.getElementById('piano');
  piano.innerHTML = '';
  // First pass: count white keys for layout
  const whiteKeys = [];
  const blackKeys = [];
  for (let midi = PIANO_LOW; midi <= PIANO_HIGH; midi++) {
    const pc = midi % 12;
    const isBlack = [1, 3, 6, 8, 10].includes(pc);
    if (isBlack) blackKeys.push(midi);
    else whiteKeys.push(midi);
  }
  const whiteW = 100 / whiteKeys.length;  // %
  whiteKeys.forEach((midi, i) => {
    const k = document.createElement('div');
    k.className = 'piano-key white';
    k.style.left = (i * whiteW) + '%';
    k.style.width = whiteW + '%';
    k.dataset.midi = midi;
    if (inScale(midi)) k.classList.add('in-scale');
    if ((midi % 12) === SCALE_ROOT_PC) k.textContent = noteName(midi);
    k.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      noteOn(midi, 0.7);
      k.dataset.held = '1';
    });
    k.addEventListener('pointerup', () => {
      if (k.dataset.held) { noteOff(midi); delete k.dataset.held; }
    });
    k.addEventListener('pointerleave', () => {
      if (k.dataset.held) { noteOff(midi); delete k.dataset.held; }
    });
    piano.appendChild(k);
    PIANO_KEYS.push({ midi, kind: 'white', el: k });
  });
  // Black keys positioned over the boundary between two whites.
  // Width is a fraction of the white-key width so they never overlap awkwardly.
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
    k.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      noteOn(midi, 0.7);
      k.dataset.held = '1';
    });
    k.addEventListener('pointerup', () => {
      if (k.dataset.held) { noteOff(midi); delete k.dataset.held; }
    });
    k.addEventListener('pointerleave', () => {
      if (k.dataset.held) { noteOff(midi); delete k.dataset.held; }
    });
    piano.appendChild(k);
    PIANO_KEYS.push({ midi, kind: 'black', el: k });
  });
}
buildPiano();

function highlightPianoKey(midi, on) {
  const k = PIANO_KEYS.find(x => x.midi === midi);
  if (k) k.el.classList.toggle('active', on);
}

// Floating note indicator above the piano
function showFloatingNote(midi) {
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

//
// =========================================================================
//  RECORDING — turn a played phrase into a seed (or overwrite selected)
// =========================================================================
//
function startRecording() {
  if (state.isRecording) return;
  state.isRecording = true;
  state.recordingBuffer = null;
  document.getElementById('rec-btn').classList.add('recording');
  document.getElementById('rec-btn').textContent = '■ stop';
  // Show overlay
  const ov = document.createElement('div');
  ov.className = 'recording-overlay';
  ov.id = 'rec-overlay';
  ov.innerHTML = '<span class="rec-dot"></span><span>recording · play a phrase</span>';
  document.getElementById('canvas-wrap').appendChild(ov);
}

function finishRecording() {
  if (!state.isRecording) return;
  state.isRecording = false;
  document.getElementById('rec-btn').classList.remove('recording');
  document.getElementById('rec-btn').textContent = '● record';
  const ov = document.getElementById('rec-overlay');
  if (ov) ov.remove();

  if (!state.recordingBuffer || state.recordingBuffer.notes.length === 0) {
    return;
  }
  const result = phraseFromRecording(state.recordingBuffer);
  state.recordingBuffer = null;

  if (!result) return;

  // If a voice seed is selected, overwrite its pattern; otherwise plant new.
  const sel = seedById(state.selectedSeedId);
  if (sel && sel.kind === 'voice') {
    sel.pattern = result.pattern;
    sel.intervalMs = result.intervalMs;
    sel.fundamental = result.fundamental;
    sel.r = radiusForFundamental(sel.fundamental);
    syncRenderedSeeds();
    selectSeed(sel.id);
    takeSnapshot('rewrote ' + sel.label);
  } else {
    plantRecordedSeed(result);
  }
}

// Transform a recorded note stream into seed parameters.
// Guardrails on: quantize to 16th notes, deduplicate near-simultaneous,
// pick the strongest 8-16 notes, snap to scale.
function phraseFromRecording(buf) {
  const notes = buf.notes;
  if (notes.length === 0) return null;

  const midis = notes.map(n => n.midi).slice().sort((a, b) => a - b);
  const fundamentalMidi = midis[Math.floor(midis.length / 2)];
  const fundamentalFreq = freqFromMidi(fundamentalMidi);

  const stepMs = state.guardrails ? (BAR_MS / 16) : (BAR_MS / 32);
  const maxSteps = state.guardrails ? 16 : 32;
  const totalSpan = Math.max(...notes.map(n => n.t)) + stepMs;
  const totalSteps = Math.min(maxSteps, Math.max(4, Math.ceil(totalSpan / stepMs)));

  // Bucket notes by step. Each step keeps an array of unique-pitch notes.
  // If a pitch hits the same step twice (unlikely but possible), the louder wins.
  const stepBuckets = new Array(totalSteps).fill(null).map(() => []);
  for (const n of notes) {
    const step = Math.min(totalSteps - 1, Math.round(n.t / stepMs));
    const durMs = n.duration !== null && n.duration !== undefined ? n.duration : (stepMs * 0.6);
    const existingIdx = stepBuckets[step].findIndex(x => x.midi === n.midi);
    const entry = { midi: n.midi, velocity: n.velocity, durMs };
    if (existingIdx >= 0) {
      if (stepBuckets[step][existingIdx].velocity < n.velocity) {
        stepBuckets[step][existingIdx] = entry;
      }
    } else {
      stepBuckets[step].push(entry);
    }
  }
  // Drop trailing empty buckets
  while (stepBuckets.length > 1 && stepBuckets[stepBuckets.length - 1].length === 0) stepBuckets.pop();

  const toStep = (notes) => {
    if (notes.length === 0) return { offset: 0, velocity: 0, duration: 1.0 };
    // Sort ascending by pitch — lowest is the primary (chord root)
    notes.sort((a, b) => a.midi - b.midi);
    const noteToFields = (nn) => {
      const useMidi = state.guardrails ? snapToScale(nn.midi) : nn.midi;
      return {
        offset: useMidi - fundamentalMidi,
        velocity: Math.max(0.3, Math.min(1.0, nn.velocity * 1.3)),
        duration: Math.max(0.15, Math.min(8.0, nn.durMs / stepMs)),
      };
    };
    const primary = noteToFields(notes[0]);
    if (notes.length > 1) {
      primary.extras = notes.slice(1).map(noteToFields);
    }
    return primary;
  };

  const pattern = stepBuckets.map(toStep);

  return {
    fundamental: fundamentalFreq,
    intervalMs: stepMs,
    pattern,
  };
}

function plantRecordedSeed(result) {
  // Pick a spot on the canvas — somewhere not too crowded.
  // Simple heuristic: in the upper-middle area, offset by seed count.
  const n = seeds.filter(s => s.kind === 'voice').length;
  const cx = 240 + (n % 4) * 280 + 40 * Math.random();
  const cy = 180 + Math.floor(n / 4) * 200 + 40 * Math.random();

  // Build harmonics — moderate brightness so it cuts through but isn't harsh
  const harmonics = new Array(NUM_HARMONICS).fill(0);
  for (let i = 0; i < 5; i++) {
    harmonics[i] = 0.3 * Math.exp(-i * 0.5);
  }

  const color = SEED_COLORS[n % SEED_COLORS.length];
  const labels = ['little wisp', 'soft hum', 'echo bone', 'spark', 'glimmer', 'small stone', 'feather', 'dapple', 'flicker', 'reed'];
  const label = labels[Math.floor(Math.random() * labels.length)];

  const seed = makeSeed({
    cx, cy,
    r: radiusForFundamental(result.fundamental),
    fundamental: result.fundamental,
    decay: BAR_MS / 4,
    intervalMs: result.intervalMs,
    harmonics, color, label,
    pattern: result.pattern,
    quantize: true,
  });

  // Auto-capture if planted inside a sphere
  for (const m of seeds.filter(s => s.kind === 'modifier')) {
    const d = Math.hypot(seed.cx - m.cx, seed.cy - m.cy);
    if (d < m.sphereR) {
      seed.capturedByIds.add(m.id);
      m.capturedSeedIds.add(seed.id);
    }
  }

  syncRenderedSeeds();
  selectSeed(seed.id);
  takeSnapshot('recorded ' + label);
}

document.getElementById('rec-btn').addEventListener('click', async () => {
  await initAudio();
  if (state.isRecording) finishRecording();
  else startRecording();
});

//
// =========================================================================
//  CANVAS POINTER (plant / drag / select)
// =========================================================================
//
function canvasCoords(evt) {
  const ctm = canvasEl.getScreenCTM();
  if (ctm) {
    const pt = canvasEl.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y, screenX: evt.clientX, screenY: evt.clientY };
  }
  const rect = canvasEl.getBoundingClientRect();
  return {
    x: ((evt.clientX - rect.left) / rect.width) * 1400,
    y: ((evt.clientY - rect.top) / rect.height) * 800,
    screenX: evt.clientX, screenY: evt.clientY,
  };
}
function seedAtCanvas(c) {
  let best = null, bestDist = Infinity;
  for (const s of seeds) {
    const d = Math.hypot(c.x - s.cx, c.y - s.cy);
    if (d <= s.r * 1.4 && d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

let tapBuffer = null;
const TAP_FINALIZE_MS = 1400;
function showPlantingFeedback(x, y, taps) {
  let el = document.getElementById('planting-feedback');
  if (!el) {
    el = document.createElement('div');
    el.id = 'planting-feedback';
    el.className = 'planting-indicator';
    canvasWrap.appendChild(el);
  }
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.textContent = `${taps} ${taps === 1 ? 'tap' : 'taps'} · keep going or wait`;
}
function hidePlantingFeedback() {
  const el = document.getElementById('planting-feedback');
  if (el) el.remove();
  while (tapMarkersLayer.firstChild) tapMarkersLayer.removeChild(tapMarkersLayer.firstChild);
}
function addTapMarker(x, y) {
  const dot = document.createElementNS(SVGNS, 'circle');
  dot.setAttribute('cx', x); dot.setAttribute('cy', y);
  dot.setAttribute('r', 6);
  dot.setAttribute('fill', 'rgba(255, 209, 102, 0.65)');
  dot.setAttribute('class', 'tap-marker');
  tapMarkersLayer.appendChild(dot);
}

function startTap(c) {
  // Bomb modes spawn a one-shot event at the tap point
  if (BOMB_KINDS[state.plantMode]) {
    spawnBomb(c.x, c.y, state.plantMode);
    takeSnapshot('fired ' + state.plantMode);
    return;
  }
  // Sweep modes start a drag: user defines start and end with one gesture
  if (SWEEP_KINDS[state.plantMode]) {
    if (!audioCtx) initAudio();
    state.sweepDrag = {
      x0: c.x, y0: c.y,
      x1: c.x, y1: c.y,
      kind: state.plantMode,
    };
    return;
  }
  if (state.plantMode !== 'voice') {
    plantModifierAt(c);
    return;
  }
  if (!tapBuffer) {
    tapBuffer = {
      svgX: c.x, svgY: c.y,
      screenX: c.screenX - canvasWrap.getBoundingClientRect().left,
      screenY: c.screenY - canvasWrap.getBoundingClientRect().top,
      taps: [{ ts: performance.now(), y: c.y, x: c.x }],
      firstY: c.y,
    };
  } else {
    tapBuffer.taps.push({ ts: performance.now(), y: c.y, x: c.x });
  }
  addTapMarker(c.x, c.y);
  showPlantingFeedback(tapBuffer.screenX, tapBuffer.screenY - 30, tapBuffer.taps.length);
  clearTimeout(tapBuffer.timer);
  tapBuffer.timer = setTimeout(finalizeTaps, TAP_FINALIZE_MS);
}

function finalizeTaps() {
  if (!tapBuffer) return;
  const taps = tapBuffer.taps;
  const role = TIMBRE_ROLES[activeRole] || TIMBRE_ROLES.melody;
  const gen = role.generate();

  // Rhythm from tap intervals if 2+ taps, otherwise role default
  let intervalMs = gen.intervalMs;
  if (taps.length >= 2) {
    let total = 0;
    for (let i = 1; i < taps.length; i++) total += taps[i].ts - taps[i - 1].ts;
    intervalMs = total / (taps.length - 1);
    intervalMs = RHYTHM_OPTIONS[nearestOptionIdx(RHYTHM_OPTIONS, intervalMs)].ms;
  }

  // Pitch from Y position, biased into role's natural range
  const yNorm = Math.max(0, Math.min(1, tapBuffer.firstY / 800));
  // Octave shift based on Y: top of canvas = +1 octave, bottom = -1 octave
  const fundamental = gen.fundamentalHz * Math.pow(2, (0.5 - yNorm) * 1.6);

  // Pattern from tap Y positions (relative to first tap)
  const PIXELS_PER_SEMITONE = 18;
  const pattern = taps.map((t) => {
    const dy = tapBuffer.firstY - t.y;
    const offset = Math.round(dy / PIXELS_PER_SEMITONE);
    return { offset: Math.max(-14, Math.min(14, offset)), velocity: 1.0 };
  });

  const r = radiusForFundamental(fundamental);
  const labels = ['little wisp', 'soft hum', 'echo bone', 'spark', 'glimmer', 'small stone', 'feather', 'dapple', 'flicker', 'reed'];
  const label = labels[Math.floor(Math.random() * labels.length)];

  const seed = makeSeed({
    cx: tapBuffer.svgX, cy: tapBuffer.svgY, r,
    fundamental: Math.round(fundamental),
    decay: Math.round(gen.decay),
    intervalMs: Math.round(intervalMs),
    harmonics: gen.harmonics,
    color: role.color,
    label, pattern,
    role: activeRole,
    synthesisModel: gen.synthesisModel,
    attackMs: gen.attackMs,
    patch: gen.patch,
    quantize: true,
  });
  for (const m of seeds.filter(s => s.kind === 'modifier')) {
    const d = Math.hypot(seed.cx - m.cx, seed.cy - m.cy);
    if (d < m.sphereR) {
      seed.capturedByIds.add(m.id);
      m.capturedSeedIds.add(seed.id);
    }
  }
  hidePlantingFeedback();
  tapBuffer = null;
  syncRenderedSeeds();
  selectSeed(seed.id);
  takeSnapshot('planted ' + label);
}

function plantModifierAt(c) {
  const modKind = state.plantMode;
  const baseR = modKind === 'weave' ? 30 : (modKind === 'ripple' ? 26 : (modKind === 'poly' ? 28 : 32));
  const seed = makeSeed({
    kind: 'modifier', modifierKind: modKind,
    cx: c.x, cy: c.y,
    r: baseR,
    intervalMs: BEAT_MS,
    sphereR: SPHERE_OPTIONS[1].r,
    delayMs: BAR_MS * 3/16,
    reverbSec: 2.0,
    polyFactor: 2/3,  // default 3:2 for new poly modifiers
    harmonics: makeHarmonics(modKind === 'weave' ? { 4: 0.06, 7: 0.04 }
                              : modKind === 'ripple' ? { 4: 0.05, 7: 0.03 }
                              : modKind === 'poly' ? { 3: 0.06, 6: 0.04, 9: 0.03 }
                              : { 3: 0.03, 5: 0.02 }),
    label: modKind,
  });
  setupModifierChain(seed);
  for (const v of seeds.filter(s => s.kind === 'voice')) {
    const d = Math.hypot(v.cx - seed.cx, v.cy - seed.cy);
    if (d < seed.sphereR) {
      v.capturedByIds.add(seed.id);
      seed.capturedSeedIds.add(v.id);
    }
  }
  syncRenderedSeeds();
  selectSeed(seed.id);
  takeSnapshot('planted ' + modKind);
}

canvasEl.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0) return;
  // Audio init is handled by the document-level capture listener
  const c = canvasCoords(evt);
  const hit = seedAtCanvas(c);
  if (hit) { beginDrag(evt, hit.id); return; }
  startTap(c);
});

let drag = null;
function beginDrag(evt, seedId) {
  const seed = seedById(seedId);
  if (!seed) return;
  const c = canvasCoords(evt);
  drag = { seed, offsetX: c.x - seed.cx, offsetY: c.y - seed.cy, moved: false };
  selectSeed(seedId);
}
function continueDrag(evt) {
  if (!drag) return;
  const c = canvasCoords(evt);
  drag.seed.cx = Math.max(40, Math.min(1360, c.x - drag.offsetX));
  drag.seed.cy = Math.max(40, Math.min(760, c.y - drag.offsetY));
  drag.moved = true;
  renderSeed(drag.seed);
  if (drag.seed.kind === 'voice') {
    updateVoiceCaptures(drag.seed);
    renderTethers();
    renderSeed(drag.seed);
  } else if (drag.seed.kind === 'modifier') {
    reevaluateAllCaptures();
    renderTethers();
  }
}

// Sync a voice's capturedByIds with the modifiers whose spheres it's currently inside.
function updateVoiceCaptures(v) {
  if (!v.capturedByIds) v.capturedByIds = new Set();
  const newCaptors = new Set();
  for (const m of seeds.filter(s => s.kind === 'modifier')) {
    if (Math.hypot(v.cx - m.cx, v.cy - m.cy) < m.sphereR) {
      newCaptors.add(m.id);
    }
  }
  for (const id of v.capturedByIds) {
    if (!newCaptors.has(id)) {
      const m = seedById(id);
      if (m) m.capturedSeedIds.delete(v.id);
    }
  }
  for (const id of newCaptors) {
    if (!v.capturedByIds.has(id)) {
      const m = seedById(id);
      if (m) m.capturedSeedIds.add(v.id);
    }
  }
  v.capturedByIds = newCaptors;
}
function reevaluateAllCaptures() {
  for (const v of seeds.filter(s => s.kind === 'voice')) {
    updateVoiceCaptures(v);
  }
}
function endDrag() {
  if (drag) {
    if (drag.seed.kind === 'modifier') renderSpheres();
    if (drag.moved) takeSnapshot('moved ' + drag.seed.label);
    drag = null;
  }
}

function continueSweepDrag(evt) {
  if (!state.sweepDrag) return;
  const c = canvasCoords(evt);
  state.sweepDrag.x1 = c.x;
  state.sweepDrag.y1 = c.y;
}
function endSweepDrag() {
  if (!state.sweepDrag) return;
  spawnSweep(state.sweepDrag.x0, state.sweepDrag.y0, state.sweepDrag.x1, state.sweepDrag.y1, state.sweepDrag.kind);
  takeSnapshot('fired ' + state.sweepDrag.kind);
  state.sweepDrag = null;
}

window.addEventListener('pointermove', continueDrag);
window.addEventListener('pointermove', continueSweepDrag);
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointerup', endSweepDrag);

function setPlantMode(kind) {
  const opt = document.querySelector(`.plant-opt[data-kind="${kind}"]`);
  if (!opt) return;
  state.plantMode = kind;
  document.querySelectorAll('.plant-opt').forEach(el =>
    el.classList.toggle('active', el === opt));
}
document.getElementById('plant-group').addEventListener('click', (e) => {
  const opt = e.target.closest('.plant-opt');
  if (!opt) return;
  setPlantMode(opt.dataset.kind);
});

// === PALETTE (active timbre role for new voices) ===
function buildPalette() {
  const el = document.getElementById('palette');
  if (!el) return;
  el.innerHTML = '<span class="palette-label">palette</span>';
  for (const [roleKey, def] of Object.entries(TIMBRE_ROLES)) {
    const item = document.createElement('div');
    item.className = 'palette-item';
    if (roleKey === activeRole) item.classList.add('active');
    item.dataset.role = roleKey;
    item.innerHTML = `<span class="pal-dot" style="background:${def.color}"></span>${def.label}`;
    item.addEventListener('click', () => {
      setActiveRole(roleKey);
      document.querySelectorAll('.palette-item').forEach(x => x.classList.remove('active'));
      item.classList.add('active');
    });
    el.appendChild(item);
  }
}
buildPalette();

//

//
// =========================================================================
//  GUARDRAILS TOGGLE
// =========================================================================
//
document.getElementById('guard-toggle').addEventListener('click', () => {
  state.guardrails = !state.guardrails;
  document.getElementById('guard-pill').classList.toggle('on', state.guardrails);
  // Re-paint piano in-scale highlights
  for (const k of PIANO_KEYS) {
    if (k.kind === 'white') k.el.classList.toggle('in-scale', state.guardrails && inScale(k.midi));
  }
});


//
// =========================================================================
//  PLAY / VOL
// =========================================================================
//
const playBtn = document.getElementById('play-btn');
playBtn.addEventListener('click', async () => {
  const ctx = await ensureAudio();
  if (!ctx) return;
  if (state.isPlaying) {
    state.isPlaying = false;
    try { await ctx.suspend(); } catch (e) {}
    playBtn.textContent = '▶ start';
    playBtn.classList.add('primary');
    showAudioStatus(ctx.state + ' · stopped');
  } else {
    state.isPlaying = true;
    if (ctx.state === 'suspended') {
      const result = await withTimeout(ctx.resume(), 1500, 'resume');
      if (result.timeout || result.error) {
        showAudioStatus('cannot resume · state=' + ctx.state, 'error');
        state.isPlaying = false;
        return;
      }
    }
    playBtn.textContent = '■ stop';
    playBtn.classList.remove('primary');
    state.playbackStartTime = ctx.currentTime + 0.04;
    for (const s of seeds) {
      s.nextTrigger = 0; s.patternIdx = 0;
    }
    showAudioStatus(ctx.state + ' · playing' + (supportsPeriodicWave ? '' : ' · basic'),
                    ctx.state === 'running' ? 'ok' : '');
  }
});
document.getElementById('vol').addEventListener('input', (e) => {
  setMasterVol(parseFloat(e.target.value) / 100);
});

document.getElementById('tempo-slider').addEventListener('input', (e) => {
  setBPM(parseInt(e.target.value));
});

//
// =========================================================================
//  DEMO COMPOSITION (same as v3, gives an immediate starting point)
// =========================================================================
//
function makeHarmonics(spec) {
  const arr = new Array(NUM_HARMONICS).fill(0);
  for (const k of Object.keys(spec)) {
    const i = parseInt(k) - 2;
    if (i >= 0 && i < NUM_HARMONICS) arr[i] = spec[k];
  }
  return arr;
}

// Set initial tempo to 120 BPM (matches the tempo slider default) so the
// demo plays at pop/dance speed rather than 96 BPM.
setBPM(120);

// === Demo composition: basic four-on-floor groove ===
// Drums (kick/snare/hat) demonstrate the new synthesis paths.
// Bass + lead demonstrate sustained additive voices.
// Weave imposes triplet swing on the lead; ripple gives lead an echo trail.
const weave = makeSeed({
  kind: 'modifier', modifierKind: 'weave',
  cx: 1120, cy: 380, r: 30,
  intervalMs: BEAT_MS, sphereR: 200,
  swing: 0.58,  // light swing
  harmonics: makeHarmonics({ 4: 0.06, 7: 0.04 }),
  label: 'weave',
});
const ripple = makeSeed({
  kind: 'modifier', modifierKind: 'ripple',
  cx: 1100, cy: 220, r: 26,
  delayMs: BAR_MS * 3/16, sphereR: 180,
  harmonics: makeHarmonics({ 4: 0.05, 7: 0.03 }),
  label: 'ripple',
});

// Kick on beats 1 and 3 of a 4/4 bar (8-step pattern at 1/8 interval)
const kick = makeSeed({
  cx: 240, cy: 660, r: 56,
  fundamental: 55,
  decay: 200, attackMs: 2,
  intervalMs: BAR_MS / 8,
  harmonics: makeHarmonics({ 2: 0.5, 3: 0.2, 4: 0.08 }),
  color: '#e85a6f', label: 'kick', gain: 0.40,
  role: 'kick', synthesisModel: 'kick',
  pattern: [
    {offset:0,velocity:1.0},{offset:0,velocity:0},{offset:0,velocity:0},{offset:0,velocity:0},
    {offset:0,velocity:1.0},{offset:0,velocity:0},{offset:0,velocity:0},{offset:0,velocity:0},
  ],
});
// Snare on beats 2 and 4
const snare = makeSeed({
  cx: 400, cy: 680, r: 40,
  fundamental: 200,
  decay: 150, attackMs: 2,
  intervalMs: BAR_MS / 8,
  harmonics: makeHarmonics({ 2: 0.30, 3: 0.22, 4: 0.18, 5: 0.14, 6: 0.10 }),
  color: '#ffa94d', label: 'snare', gain: 0.32,
  role: 'snare', synthesisModel: 'snare',
  pattern: [
    {offset:0,velocity:0},{offset:0,velocity:0},{offset:0,velocity:1.0},{offset:0,velocity:0},
    {offset:0,velocity:0},{offset:0,velocity:0},{offset:0,velocity:1.0},{offset:0,velocity:0},
  ],
});
// Hi-hat on every 8th
const hat = makeSeed({
  cx: 560, cy: 620, r: 28,
  fundamental: 1000,
  decay: 60, attackMs: 2,
  intervalMs: BAR_MS / 8,
  harmonics: makeHarmonics({ 7: 0.15, 8: 0.18, 9: 0.15, 10: 0.12, 11: 0.10, 12: 0.08, 13: 0.06 }),
  color: '#ffd166', label: 'hat', gain: 0.22,
  role: 'hat', synthesisModel: 'hihat',
  pattern: [
    {offset:0,velocity:0.9},{offset:0,velocity:0.6},{offset:0,velocity:0.7},{offset:0,velocity:0.6},
    {offset:0,velocity:0.9},{offset:0,velocity:0.6},{offset:0,velocity:0.7},{offset:0,velocity:0.6},
  ],
});
// Bass walks
const bass = makeSeed({
  cx: 760, cy: 580, r: 56,
  fundamental: 82, // E2
  decay: 350, attackMs: 8,
  intervalMs: BAR_MS / 4,
  harmonics: makeHarmonics({ 2: 0.48, 3: 0.18, 4: 0.06 }),
  color: '#9474e8', label: 'bass', gain: 0.34,
  role: 'bass', synthesisModel: 'additive',
  pattern: [
    {offset:0,velocity:1.0}, {offset:0,velocity:0.85},
    {offset:7,velocity:0.95}, {offset:5,velocity:0.85},
  ],
});
// Lead melody
const lead = makeSeed({
  cx: 1080, cy: 340, r: 44,
  fundamental: 392, // G4
  decay: 350, attackMs: 12,
  intervalMs: BAR_MS / 4,
  harmonics: makeHarmonics({ 2: 0.32, 3: 0.20, 4: 0.13, 5: 0.08 }),
  color: '#5fd2e8', label: 'lead', gain: 0.26,
  role: 'melody', synthesisModel: 'additive',
  pattern: [
    {offset:0,velocity:1.0}, {offset:5,velocity:0.85},
    {offset:7,velocity:0.95}, {offset:3,velocity:0.80},
    {offset:0,velocity:0.90}, {offset:-2,velocity:0.85},
    {offset:5,velocity:0.95}, {offset:7,velocity:0.80},
  ],
});

// Chord pad — sustained chord progression demonstrating the chord feature.
// G minor: root + flat 3rd + 5th. Then to C: root + flat 3rd + 5th. Pentatonic-friendly.
const pad = makeSeed({
  cx: 460, cy: 200, r: 62,
  fundamental: 196,  // G3
  decay: 700, attackMs: 80,
  intervalMs: BAR_MS,  // chord changes every bar
  harmonics: makeHarmonics({ 2: 0.28, 3: 0.15, 4: 0.08, 5: 0.05 }),
  color: '#b393d6', label: 'pad', gain: 0.16,
  role: 'voice', synthesisModel: 'additive',
  pattern: [
    // G minor chord: G + Bb + D
    { offset: 0, velocity: 0.85, duration: 1.0, extras: [
      { offset: 3,  velocity: 0.80, duration: 1.0 },
      { offset: 7,  velocity: 0.75, duration: 1.0 },
    ]},
    // F major-ish chord: F + A + C (pentatonic-snapped)
    { offset: -2, velocity: 0.85, duration: 1.0, extras: [
      { offset: 2,  velocity: 0.80, duration: 1.0 },
      { offset: 5,  velocity: 0.75, duration: 1.0 },
    ]},
  ],
});

// Auto-capture: lead falls inside both weave and ripple spheres (overlapping)
for (const v of [kick, snare, hat, bass, lead, pad]) {
  for (const m of [weave, ripple]) {
    const d = Math.hypot(v.cx - m.cx, v.cy - m.cy);
    if (d < m.sphereR) {
      v.capturedByIds.add(m.id);
      m.capturedSeedIds.add(v.id);
    }
  }
}

syncRenderedSeeds();
takeSnapshot('start');

// Try to create the AudioContext now (it'll be suspended until a user gesture
// but having it exist avoids hangs in resume() later).
tryCreateContext();

// Try MIDI
setupMIDI();

