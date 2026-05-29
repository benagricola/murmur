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
import { setMasterVol } from './audio/context.js';
import { state, seedById } from './state.js';
import { renderSeed } from './seeds.js';
import { setBPM } from './transport.js';
import { BPM } from './tempo.js';
import { popupEncoder, popupFader } from './output/minilab3.js';
import { refreshInspector } from './inspector.js';
import { liveTimbre, LIVE_ROLE_OCTAVE_SHIFT } from './timbres.js';
import { ENCODER_CCS, FADER_CCS } from './devices/minilab3.js';
import { auraEntry } from './auras/registry.js';

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

// === Soft takeover for faders ===
// Without this, the moment the physical fader sends ANY value, the
// on-screen slider snaps to it — which is jarring when the two are
// far apart. Soft takeover holds the on-screen value steady until
// the physical fader passes through the current value (catches it),
// then "engages" and tracks normally. Until catch, a marker shows
// where the physical fader is so the user knows which way to move.

const FADER_DEFS = [
  { slot: 0, sliderId: 'vol', markerId: 'vol-soft-marker', min: 0, max: 100,
    apply: v => setMasterVol(v / 100),
    popup: v => popupFader(toCC(v, 0, 100), 'volume', Math.round(v) + '%') },
  { slot: 1, sliderId: 'tempo-slider', markerId: 'tempo-soft-marker', min: 60, max: 180,
    apply: v => setBPM(Math.round(v)),
    popup: v => popupFader(toCC(v, 60, 180), 'tempo', Math.round(v) + ' bpm') },
];
const faderEngaged = [false, false, false, false];
const faderPhysical = [null, null, null, null];  // last value 0..127

function toCC(value, lo, hi) { return Math.round(((value - lo) / (hi - lo)) * 127); }

function updateSoftMarker(idx) {
  const def = FADER_DEFS[idx];
  if (!def) return;
  const marker = document.getElementById(def.markerId);
  if (!marker) return;
  if (faderEngaged[idx] || faderPhysical[idx] == null) {
    marker.classList.remove('show');
    return;
  }
  marker.classList.add('show');
  marker.style.left = (faderPhysical[idx] / 127 * 100) + '%';
}

function handleFader(idx, value) {
  const def = FADER_DEFS[idx];
  if (!def) return false;
  const slider = document.getElementById(def.sliderId);
  const webValue = slider ? parseFloat(slider.value) : def.min;
  const physicalAsValue = def.min + (value / 127) * (def.max - def.min);
  const prevPhysical = faderPhysical[idx];
  faderPhysical[idx] = value;

  if (faderEngaged[idx]) {
    // Already caught — track normally.
    def.apply(physicalAsValue);
    if (slider) slider.value = physicalAsValue;
    def.popup(physicalAsValue);
    updateSoftMarker(idx);
    return true;
  }

  // Not engaged yet — check if this move crossed (or hit within ε)
  // the current on-screen value. If so, engage from this point.
  if (prevPhysical != null) {
    const prevAsValue = def.min + (prevPhysical / 127) * (def.max - def.min);
    const crossed = (prevAsValue <= webValue && physicalAsValue >= webValue) ||
                    (prevAsValue >= webValue && physicalAsValue <= webValue);
    if (crossed) {
      faderEngaged[idx] = true;
      def.apply(physicalAsValue);
      if (slider) slider.value = physicalAsValue;
      def.popup(physicalAsValue);
      updateSoftMarker(idx);
      return true;
    }
  }
  // Still chasing — update the marker so the user can see where
  // they need to move TO catch the on-screen value.
  updateSoftMarker(idx);
  return true;
}

// Called from transport.js whenever the on-screen slider is moved.
// Disengages the matching fader so the physical fader has to catch
// the new value again before it takes over.
export function disengageFader(sliderId) {
  for (let i = 0; i < FADER_DEFS.length; i++) {
    if (FADER_DEFS[i].sliderId === sliderId) {
      faderEngaged[i] = false;
      updateSoftMarker(i);
      return;
    }
  }
}

function handleEncoderNoSelection(idx, value) {
  // No-op with nothing selected. Octave shifts are handled by the
  // device's dedicated Oct+ / Oct- buttons; doubling that on an
  // encoder duplicates what the hardware already does well.
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
        seed.intervalFrac = opt.frac;       // canonical bar-fraction
        seed.nextTrigger = 0;
      }
      popupEncoder(value, 'rhythm', opt ? opt.label : '');
      refreshInspector();
      return true;
    }
    case 2: {
      const opt = LENGTH_OPTIONS[ccPickIdx(value, LENGTH_OPTIONS)];
      if (opt && seed.decay !== opt.ms) {
        seed.decay = opt.ms;
        seed.decayFrac = opt.frac;          // canonical bar-fraction
        seed._cachedPatch = null;
      }
      popupEncoder(value, 'length', opt ? opt.label : '');
      refreshInspector();
      return true;
    }
    case 3: {
      seed.gain = ccRange(value, 0.05, 0.6);
      popupEncoder(value, 'gain', Math.round(seed.gain * 100) + '%');
      refreshInspector();
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
      refreshInspector();
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
    refreshInspector();
    return true;
  }
  if (idx === 1) {
    // Kind-specific param comes from the aura registry. Encoder maps
    // its continuous 0..127 across the param's range (explicit, or the
    // span of its discrete option values). apply() handles the live
    // audio-graph side effect. Works for every aura that has a param.
    const param = auraEntry(seed.modifierKind) && auraEntry(seed.modifierKind).param;
    if (!param) return false;
    const [lo, hi] = param.range || optionSpan(param.options());
    const val = ccRange(value, lo, hi);
    param.apply(seed, val);
    popupEncoder(value, param.label, param.format(val));
    refreshInspector();
    return true;
  }
  return false;
}

// Min/max of an option list's values — fallback encoder range for
// auras that declare options but no explicit continuous range.
function optionSpan(options) {
  let lo = Infinity, hi = -Infinity;
  for (const o of options) { if (o.val < lo) lo = o.val; if (o.val > hi) hi = o.val; }
  return [lo, hi];
}
