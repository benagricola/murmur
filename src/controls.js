// MiniLab 3 encoder + fader bindings.
//
// In the user's device template the eight panel encoders send
// absolute CC values 0..127 on CC 86 / 87 / 89 / 90 / 110 / 111 /
// 116 / 117 (confirmed from a real-device MIDI log). The four
// faders send absolute 0..127 on CC 14 / 15 / 30 / 31. CC 1 is the
// mod strip (kept as a global brightness control on live notes).
// CC 28 is the main rotary in relative-1 mode (handled separately
// in input.js for the live-timbre roll).
//
// Encoder bindings are context-sensitive: when no seed is selected,
// encoders 1-4 control the live keyboard timbre. When a voice is
// selected, encoders bind to that seed's pitch / rhythm / length /
// gain + four harmonic amps. When a modifier is selected, encoders
// bind to its sphere reach + kind-specific params.

import {
  RHYTHM_OPTIONS, LENGTH_OPTIONS, SPHERE_OPTIONS,
  freqFromMidi, midiFromFreq, snapToScale, noteName,
} from './constants.js';
import { audioCtx, setMasterVol } from './audio/context.js';
import { state, seedById } from './state.js';
import { renderSeed } from './seeds.js';
import { setBPM } from './transport.js';
import { BPM } from './tempo.js';
import { popupEncoder, popupFader } from './output/minilab3.js';

// Map an encoder CC to its slot index (0..7).
const ENCODER_CCS = [86, 87, 89, 90, 110, 111, 116, 117];
const FADER_CCS = [14, 15, 30, 31];

function encoderSlot(cc) { return ENCODER_CCS.indexOf(cc); }
function faderSlot(cc) { return FADER_CCS.indexOf(cc); }

// Map a 0..127 CC value to a numeric range, optionally with a curve.
function cc01(v) { return v / 127; }
function ccRange(v, lo, hi) { return lo + cc01(v) * (hi - lo); }
function ccPickIdx(v, options) {
  return Math.min(options.length - 1, Math.floor(cc01(v) * options.length));
}

// Bind a CC value to the currently-selected seed (or live timbre).
// Returns true if the CC was handled, false otherwise — caller can
// then fall through to default behaviour.
export function handleControlCC(cc, value) {
  // Faders are always global.
  const fIdx = faderSlot(cc);
  if (fIdx >= 0) return handleFader(fIdx, value);

  const eIdx = encoderSlot(cc);
  if (eIdx < 0) return false;

  const seed = seedById(state.selectedSeedId);
  if (!seed) return handleEncoderNoSelection(eIdx, value);
  if (seed.kind === 'voice') return handleEncoderVoice(seed, eIdx, value);
  if (seed.kind === 'modifier') return handleEncoderModifier(seed, eIdx, value);
  return false;
}

function handleFader(idx, value) {
  if (idx === 0) {
    const v = cc01(value);
    setMasterVol(v);
    const slider = document.getElementById('vol');
    if (slider) slider.value = Math.round(v * 100);
    popupFader(value, 'volume', Math.round(v * 100) + '%');
    return true;
  }
  if (idx === 1) {
    const bpm = Math.round(ccRange(value, 60, 180));
    setBPM(bpm);
    const slider = document.getElementById('tempo-slider');
    if (slider) slider.value = bpm;
    popupFader(value, 'tempo', bpm + ' bpm');
    return true;
  }
  // Faders 3 and 4 reserved for future globals (filter, send).
  return false;
}

function handleEncoderNoSelection(idx, value) {
  // With nothing selected the encoders steer the live keyboard tone.
  // Slot 0-3 modulate the four most audibly-useful live params; the
  // rest are reserved.
  if (idx === 0) {
    // No-op for now — live-timbre roll is on the main rotary (CC 28).
  }
  return false;
}

// Encoder layout for a selected voice:
//   0  pitch          (semitones in scale grid)
//   1  rhythm         (RHYTHM_OPTIONS index)
//   2  length / decay (LENGTH_OPTIONS index)
//   3  gain           (0..1)
//   4  harmonic 1 (partial 2)
//   5  harmonic 3 (partial 4)
//   6  harmonic 5 (partial 6)
//   7  harmonic 7 (partial 8)
function handleEncoderVoice(seed, idx, value) {
  switch (idx) {
    case 0: {
      const midi = Math.round(ccRange(value, 24, 96));
      seed.fundamental = freqFromMidi(midi);
      const slider = document.getElementById('pitch-slider');
      if (slider && state.selectedSeedId === seed.id) {
        slider.value = midi;
        const val = document.getElementById('pitch-val');
        if (val) val.textContent = noteName(snapToScale(midi));
      }
      renderSeed(seed);
      popupEncoder(value, 'pitch', noteName(snapToScale(midi)));
      return true;
    }
    case 1: {
      const opt = RHYTHM_OPTIONS[ccPickIdx(value, RHYTHM_OPTIONS)];
      if (opt && seed.intervalMs !== opt.ms) {
        seed.intervalMs = opt.ms;
        seed.nextTrigger = 0;
      }
      popupEncoder(value, 'rhythm', opt ? opt.label : '');
      return true;
    }
    case 2: {
      const opt = LENGTH_OPTIONS[ccPickIdx(value, LENGTH_OPTIONS)];
      if (opt && seed.decay !== opt.ms) {
        seed.decay = opt.ms;
        seed._cachedPatch = null;
      }
      popupEncoder(value, 'length', opt ? opt.label : '');
      return true;
    }
    case 3: {
      seed.gain = ccRange(value, 0.05, 0.6);
      popupEncoder(value, 'gain', Math.round(seed.gain * 100) + '%');
      return true;
    }
    case 4: case 5: case 6: case 7: {
      const harmonicIdx = (idx - 4) * 2;  // 0, 2, 4, 6 → partials 2, 4, 6, 8
      const amp = cc01(value);
      if (seed.harmonics) {
        seed.harmonics[harmonicIdx] = amp;
        renderSeed(seed);
      }
      popupEncoder(value, 'harm ' + (harmonicIdx + 2), Math.round(amp * 100) + '%');
      return true;
    }
  }
  return false;
}

// Encoder layout for a selected modifier:
//   0  sphere reach (SPHERE_OPTIONS index)
//   1  kind-specific primary (swing / delay / size / ratio)
//   2-7  reserved
function handleEncoderModifier(seed, idx, value) {
  if (idx === 0) {
    const opt = SPHERE_OPTIONS[ccPickIdx(value, SPHERE_OPTIONS)];
    if (opt) seed.sphereR = opt.r;
    popupEncoder(value, 'reach', opt ? opt.label : '');
    return true;
  }
  if (idx === 1) {
    if (seed.modifierKind === 'weave') {
      seed.swing = ccRange(value, 0.50, 0.75);
      popupEncoder(value, 'swing', seed.swing.toFixed(2));
      return true;
    }
    if (seed.modifierKind === 'ripple') {
      seed.delayMs = ccRange(value, 60, 1200);
      if (seed.delayNode && audioCtx) {
        seed.delayNode.delayTime.setTargetAtTime(seed.delayMs / 1000, audioCtx.currentTime, 0.02);
      }
      popupEncoder(value, 'delay', Math.round(seed.delayMs) + 'ms');
      return true;
    }
    if (seed.modifierKind === 'cloud') {
      seed.reverbSec = ccRange(value, 0.5, 5.0);
      popupEncoder(value, 'size', seed.reverbSec.toFixed(1) + 's');
      return true;
    }
    if (seed.modifierKind === 'poly') {
      seed.polyFactor = ccRange(value, 0.4, 1.6);
      popupEncoder(value, 'ratio', seed.polyFactor.toFixed(2));
      return true;
    }
  }
  return false;
}
