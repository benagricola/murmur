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
import { liveTimbre, rollLiveTimbre } from './timbres.js';
import { state, activeLiveNotes, releasingNotes, sustainedMidis } from './state.js';
import { rescheduleRecordingAutoFinish } from './recording.js';
import {
  transportStop, transportPlay, transportRecord, transportTap,
} from './transport.js';

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

// === Pad routing (MiniLab 3) ===
// Pads sit on MIDI channel 10. Bank A pads 1-4 (notes 36-39) play
// pitched live notes. Bank A pads 5-8 (notes 40-43) are transport
// (the device labels them stop / play / rec / tap in DAW mode).
// Bank B (notes 44-51) selects plant mode.
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

// === MIDI debug log ===
// Every incoming MIDI message is recorded so we can dump a trace
// to disk and diagnose what a particular controller is sending.
const MIDI_LOG_MAX = 8000;
const midiLog = [];
let midiVerbose = false;
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
const MIDI_PORT_SKIP_PATTERN = /\b(mcu|hui|alv|din[ _-]?thru|midi[ _-]?through|thru)\b/i;

export function setupMIDI() {
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
    // Bank A pads 5-8 = transport
    if (channel === 10 && note >= 40 && note <= 43) {
      if (note === 40) transportStop();
      else if (note === 41) transportPlay();
      else if (note === 42) transportRecord();
      else if (note === 43) transportTap();
      flashMidiLED();
      return;
    }
    // Bank B selects plant mode
    if (channel === 10 && note >= 44 && note <= 51) {
      const kind = PAD_BANK_B_TO_PLANT[note - 44];
      if (kind && setPlantModeFn) setPlantModeFn(kind);
      flashMidiLED();
      return;
    }
    noteOn(note, velocity / 127, 'midi');
    return;
  }
  if (cmd === 0x80 || (cmd === 0x90 && data[2] === 0)) {
    const note = data[1];
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
const QWERTY_MAP = {
  'a': 55, 'w': 56, 's': 57, 'e': 58, 'd': 59, 'f': 60, 't': 61, 'g': 62, 'y': 63, 'h': 64, 'j': 65, 'i': 66, 'k': 67, 'o': 68, 'l': 69, 'p': 70, ';': 71, "'": 72,
};
const heldKeys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
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
