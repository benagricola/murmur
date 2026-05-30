// Aura registry — the single source of truth for every modifier
// ("aura") kind. Adding a new aura is now one entry here plus (if it
// makes sound) one setup function in audio/chains.js; the inspector,
// MiniLab encoders, plant tool, blob rendering, audio routing, and
// tooltips all iterate this table rather than carrying their own
// per-kind switch ladders.
//
// Each entry may declare:
//   label      — UI metaphor name (mirrors labels.js KIND_LABELS)
//   color      — blob + point-cloud colour
//   baseR      — body radius when planted from the palette
//   coreClass  — extra CSS class on the seed core (pulse animations)
//   ghosts     — true to spawn the ripple ghost trail in renderSeed
//   harmonics  — sparse {index: amp} blob silhouette hint at plant time
//   defaults   — kind-specific seed fields merged at plant time
//   chain      — { setup(seed), inputProp } for auras that route audio.
//                inputProp is the seed field holding the chain's input
//                GainNode; audio/events.js sends captured voices into it.
//   param      — the one kind-specific control surfaced by the inspector
//                picker AND the MiniLab encoder (see shape below). Omit
//                for auras with no tunable param (e.g. shift).
//
// param shape:
//   prop      — seed field this controls (diagnostic / introspection)
//   label     — inspector row label
//   options() — array of { label, val } (function so tempo-dependent
//               option sets like ripple delay stay live)
//   range     — [min, max] for the continuous MiniLab encoder mapping;
//               defaults to the option value span when omitted
//   apply(seed, val) — write the value AND perform any live audio-graph
//               side effect (curve rebuild, node param ramp, …)
//   format(val) — short string for encoder popups
//   tooltip(seed) — the aura-tooltip settings line

import { audioCtx, onContextCreated } from '../audio/context.js';
import { seeds } from '../state.js';
import { BAR_MS } from '../tempo.js';
import {
  SWING_OPTIONS, RIPPLE_DELAY_OPTIONS, CLOUD_SIZE_OPTIONS, POLY_RATIOS,
  WEAVE_COLOR, RIPPLE_COLOR, CLOUD_COLOR, POLY_COLOR, DRIVE_COLOR,
  GAIN_COLOR, MUTE_COLOR, SQUASH_COLOR, WOBBLE_COLOR, CRUSH_COLOR, SHIFT_COLOR,
  RUNNER_COLOR,
} from '../constants.js';
import {
  setupRippleChain, setupCloudChain, setupDriveChain, setupSquashChain,
  setupWobbleChain, setupCrushChain, createReverbIR, makeDriveCurve,
  makeBitCrushCurve,
} from '../audio/chains.js';

const HARMONIC_SLOTS = 12;
const at = () => (audioCtx ? audioCtx.currentTime : 0);

// Re-anchor every voice captured by this aura so a timing-affecting
// change (swing, polyrhythm ratio) takes effect on the next bar.
function retrigger(seed) {
  for (const v of seeds) {
    if (v.capturedByIds && v.capturedByIds.has(seed.id)) v.nextTrigger = 0;
  }
}

// Static option lists for the louder/dirtier auras (previously inline
// in inspector.js). Returned via a thunk for a uniform options() API.
const DRIVE_OPTIONS = [
  { label: 'subtle', val: 0.5 }, { label: 'warm', val: 1.0 },
  { label: 'medium', val: 1.6 }, { label: 'strong', val: 2.2 },
  { label: 'crush', val: 3.0 },
];
const GAIN_OPTIONS = [
  { label: '1.2×', val: 1.2 }, { label: '1.5×', val: 1.5 },
  { label: '2×', val: 2.0 }, { label: '2.5×', val: 2.5 },
  { label: '3×', val: 3.0 },
];
const MUTE_OPTIONS = [
  { label: '-3dB', val: 0.7 }, { label: '-6dB', val: 0.5 },
  { label: '-12dB', val: 0.25 }, { label: '-24dB', val: 0.06 },
  { label: 'silent', val: 0.0 },
];
const SQUASH_OPTIONS = [
  { label: 'glue', val: 0.7 }, { label: 'pump', val: 1.2 },
  { label: 'slam', val: 1.8 }, { label: 'crush', val: 2.5 },
  { label: 'brick', val: 3.2 },
];
const WOBBLE_OPTIONS = [
  { label: 'slow', val: 1.5 }, { label: 'mid', val: 3.0 },
  { label: 'fast', val: 4.5 }, { label: 'rapid', val: 7.0 },
  { label: 'manic', val: 12.0 },
];
const CRUSH_OPTIONS = [
  { label: '8-bit', val: 8 }, { label: '6-bit', val: 6 },
  { label: '5-bit', val: 5 }, { label: '4-bit', val: 4 },
  { label: '3-bit', val: 3 },
];
// Runner (LFO) oscillation period, in bars — musically synced.
const LFO_RATE_OPTIONS = [
  { label: '8 bars', val: 8 }, { label: '4 bars', val: 4 },
  { label: '2 bars', val: 2 }, { label: '1 bar', val: 1 },
  { label: '1/2', val: 0.5 },  { label: '1/4', val: 0.25 },
];

export const AURAS = {
  weave: {
    label: 'weave', color: WEAVE_COLOR, baseR: 30, coreClass: 'weave-pulse',
    harmonics: { 2: 0.06, 5: 0.04 }, defaults: { swing: 0.5 },
    param: {
      prop: 'swing', label: 'swing',
      options: () => SWING_OPTIONS, range: [0.50, 0.75],
      apply: (s, v) => { s.swing = v; retrigger(s); },
      format: (v) => v.toFixed(2),
      tooltip: (s) => `swing ${(s.swing || 0.5).toFixed(2)}`,
    },
  },
  ripple: {
    label: 'ripple', color: RIPPLE_COLOR, baseR: 26, ghosts: true,
    harmonics: { 2: 0.05, 5: 0.03 }, defaults: {},
    chain: { setup: setupRippleChain, inputProp: 'delayInput' },
    param: {
      prop: 'delayMs', label: 'delay', range: [60, 1200],
      options: () => RIPPLE_DELAY_OPTIONS.map(o => ({ label: o.label, val: o.ms })),
      apply: (s, ms) => {
        s.delayMs = ms; s.delayFrac = ms / BAR_MS;
        if (s.delayNode && audioCtx) s.delayNode.delayTime.setTargetAtTime(ms / 1000, at(), 0.02);
      },
      format: (v) => Math.round(v) + 'ms',
      tooltip: (s) => `delay ${Math.round(s.delayMs || 0)} ms`,
    },
  },
  cloud: {
    label: 'cloud', color: CLOUD_COLOR, baseR: 32, coreClass: 'cloud-pulse',
    harmonics: { 1: 0.03, 3: 0.02 }, defaults: {},
    chain: { setup: setupCloudChain, inputProp: 'reverbInput' },
    param: {
      prop: 'reverbSec', label: 'size', range: [0.5, 5.0],
      options: () => CLOUD_SIZE_OPTIONS.map(o => ({ label: o.label, val: o.sec })),
      apply: (s, sec) => {
        s.reverbSec = sec;
        if (s.convolver && audioCtx) s.convolver.buffer = createReverbIR(sec);
      },
      format: (v) => v.toFixed(1) + 's',
      tooltip: (s) => `reverb ${(s.reverbSec || 0).toFixed(1)} s`,
    },
  },
  poly: {
    label: 'vine', color: POLY_COLOR, baseR: 28, coreClass: 'poly-pulse',
    harmonics: { 1: 0.06, 4: 0.04, 7: 0.03 }, defaults: {},
    param: {
      prop: 'polyFactor', label: 'ratio', range: [0.4, 1.6],
      options: () => POLY_RATIOS.map(r => ({ label: r.label, val: r.factor })),
      apply: (s, v) => { s.polyFactor = v; retrigger(s); },
      format: (v) => v.toFixed(2),
      tooltip: (s) => `ratio ${(s.polyFactor || 1).toFixed(2)}`,
    },
  },
  drive: {
    label: 'drive', color: DRIVE_COLOR, baseR: 32,
    harmonics: { 0: 0.10, 2: 0.07, 6: 0.05 }, defaults: {},
    chain: { setup: setupDriveChain, inputProp: 'driveInput' },
    param: {
      prop: 'driveAmount', label: 'drive',
      options: () => DRIVE_OPTIONS,
      apply: (s, v) => {
        s.driveAmount = v;
        if (s.driveShaper && audioCtx) s.driveShaper.curve = makeDriveCurve(v);
      },
      format: (v) => '×' + v.toFixed(1),
      tooltip: (s) => `drive ×${(s.driveAmount || 0).toFixed(1)}`,
    },
  },
  gain: {
    label: 'boost', color: GAIN_COLOR, baseR: 32,
    harmonics: { 0: 0.08, 1: 0.06 }, defaults: { gainAmount: 1.6 },
    param: {
      prop: 'gainAmount', label: 'boost',
      options: () => GAIN_OPTIONS,
      apply: (s, v) => { s.gainAmount = v; },
      format: (v) => v.toFixed(2) + '×',
      tooltip: (s) => `boost ${(s.gainAmount || 1).toFixed(2)}× at centre`,
    },
  },
  mute: {
    label: 'hush', color: MUTE_COLOR, baseR: 32,
    harmonics: { 3: 0.04, 5: 0.03 }, defaults: { gainAmount: 0.0 },
    param: {
      prop: 'gainAmount', label: 'hush',
      options: () => MUTE_OPTIONS,
      apply: (s, v) => { s.gainAmount = v; },
      format: (v) => v.toFixed(2) + '×',
      tooltip: (s) => `hush ${(s.gainAmount || 0).toFixed(2)}× at centre`,
    },
  },
  squash: {
    label: 'squash', color: SQUASH_COLOR, baseR: 34,
    harmonics: { 0: 0.12, 1: 0.04 }, defaults: {},
    chain: { setup: setupSquashChain, inputProp: 'squashInput' },
    param: {
      prop: 'squashAmount', label: 'squash',
      options: () => SQUASH_OPTIONS,
      apply: (s, v) => {
        s.squashAmount = v;
        if (s.squashComp && audioCtx) {
          s.squashComp.threshold.setTargetAtTime(-30 - v * 4, at(), 0.02);
          s.squashComp.ratio.setTargetAtTime(6 + v * 4, at(), 0.02);
          if (s.squashMakeup) s.squashMakeup.gain.setTargetAtTime(1 + v * 0.8, at(), 0.02);
          if (s.squashInput) s.squashInput.gain.setTargetAtTime(1 + v * 0.5, at(), 0.02);
        }
      },
      format: (v) => '×' + v.toFixed(1),
      tooltip: (s) => `squash ×${(s.squashAmount || 0).toFixed(1)}`,
    },
  },
  wobble: {
    label: 'wobble', color: WOBBLE_COLOR, baseR: 30,
    harmonics: { 1: 0.09, 2: 0.06, 3: 0.04 }, defaults: {},
    chain: { setup: setupWobbleChain, inputProp: 'wobbleInput' },
    param: {
      prop: 'wobbleRate', label: 'wobble rate',
      options: () => WOBBLE_OPTIONS,
      apply: (s, v) => {
        s.wobbleRate = v;
        if (s.wobbleLFO && audioCtx) s.wobbleLFO.frequency.setTargetAtTime(v, at(), 0.02);
      },
      format: (v) => v.toFixed(1) + 'Hz',
      tooltip: (s) => `wobble ${(s.wobbleRate || 0).toFixed(1)} Hz`,
    },
  },
  crush: {
    label: 'crush', color: CRUSH_COLOR, baseR: 28,
    harmonics: { 4: 0.08, 8: 0.06 }, defaults: {},
    chain: { setup: setupCrushChain, inputProp: 'crushInput' },
    param: {
      prop: 'crushBits', label: 'crush',
      options: () => CRUSH_OPTIONS,
      apply: (s, v) => {
        s.crushBits = v;
        if (s.crushShaper && audioCtx) s.crushShaper.curve = makeBitCrushCurve(v);
      },
      format: (v) => v + '-bit',
      tooltip: (s) => `crush ${s.crushBits || 5}-bit`,
    },
  },
  shift: {
    label: 'shift', color: SHIFT_COLOR, baseR: 30,
    harmonics: { 2: 0.07, 3: 0.05, 5: 0.04 }, defaults: {},
    // No tunable param — strength is purely proximity (centerIntensity).
    param: null,
  },
  runner: {
    label: 'runner', color: RUNNER_COLOR, baseR: 26, coreClass: 'cloud-pulse',
    harmonics: { 1: 0.08, 2: 0.05, 4: 0.03 },   // slow swell silhouette
    defaults: { lfoBars: 2 },
    // A runner isn't a field — it's a node that sends tendrils to the
    // seeds / auras it's linked to and oscillates their strength /
    // params over time (see scheduler.updateRunnerModulation). It has no
    // sphere; its centreIntensity slider is the modulation amplitude and
    // this param is the oscillation period.
    param: {
      prop: 'lfoBars', label: 'rate',
      options: () => LFO_RATE_OPTIONS,
      apply: (s, v) => { s.lfoBars = v; },
      format: (v) => (v >= 1 ? v + ' bar' + (v > 1 ? 's' : '') : '1/' + Math.round(1 / v)),
      tooltip: (s) => `runner ${s.lfoBars || 2} bar${(s.lfoBars || 2) > 1 ? 's' : ''}`,
    },
  },
};

// Default blob silhouette for an unknown / future kind, matching the
// old plantModifierAt `else` branch.
const FALLBACK_HARMONICS = { 1: 0.03, 3: 0.02 };

export function auraEntry(kind) { return AURAS[kind] || null; }

// Expand a sparse {index: amp} spec into a fixed-length harmonics
// array (direct array indices, matching the old plant code).
export function auraHarmonics(kind) {
  const spec = (AURAS[kind] && AURAS[kind].harmonics) || FALLBACK_HARMONICS;
  const arr = new Array(HARMONIC_SLOTS).fill(0);
  for (const k of Object.keys(spec)) arr[+k] = spec[k];
  return arr;
}

export function auraColor(kind) { return AURAS[kind] ? AURAS[kind].color : null; }
export function auraBaseR(kind) { return AURAS[kind] ? AURAS[kind].baseR : 32; }

// gain/mute resting multiplier at full intensity, read by the scheduler
// modulation pass + tooltip. Falls back to neutral 1.0.
export function auraGainDefault(kind) {
  const d = AURAS[kind] && AURAS[kind].defaults;
  return d && d.gainAmount != null ? d.gainAmount : 1.0;
}

// Attach the audio chain for one modifier seed (no-op for auras that
// don't make their own sound, or before the AudioContext exists).
export function setupAuraChain(seed) {
  if (seed.kind !== 'modifier' || !audioCtx) return;
  const entry = AURAS[seed.modifierKind];
  if (entry && entry.chain) entry.chain.setup(seed);
}

// Re-attach chains for any modifier seeds that were planted before the
// AudioContext came online (previously lived in chains.js).
onContextCreated(() => {
  for (const s of seeds) setupAuraChain(s);
});
