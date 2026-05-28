// Pure constants and stateless helpers. No side effects, no DOM access,
// no audio context. Anything that needs to mutate or read shared state
// lives elsewhere; this file is safe to import from anywhere.

// === Rhythm / length / sphere / effect option arrays ===
// Each option carries a musical fraction (`frac`) and a cached `ms`
// computed against the current BAR_MS. The `ms` cache is recomputed by
// recomputeOptionsMs (in main.js / tempo) whenever BPM changes — these
// arrays are exported as live references so external mutation works.

export const RHYTHM_OPTIONS = [
  { label: '1/16',  frac: 1/16, ms: 0 },
  { label: '1/8',   frac: 1/8,  ms: 0 },
  { label: '1/4',   frac: 1/4,  ms: 0 },
  { label: '3/8',   frac: 3/8,  ms: 0 },
  { label: '1/2',   frac: 1/2,  ms: 0 },
  { label: '1 bar', frac: 1,    ms: 0 },
  { label: '2 bar', frac: 2,    ms: 0 },
];

export const LENGTH_OPTIONS = [
  { label: '1/16',  frac: 1/16, ms: 0 },
  { label: '1/8',   frac: 1/8,  ms: 0 },
  { label: '1/4',   frac: 1/4,  ms: 0 },
  { label: '1/2',   frac: 1/2,  ms: 0 },
  { label: '1 bar', frac: 1,    ms: 0 },
  { label: '2 bar', frac: 2,    ms: 0 },
];

export const SPHERE_OPTIONS = [
  { label: 'tight', r: 110 },
  { label: 'med',   r: 180 },
  { label: 'wide',  r: 260 },
  { label: 'huge',  r: 360 },
];

export const RIPPLE_DELAY_OPTIONS = [
  { label: '1/16', frac: 1/16, ms: 0 },
  { label: '1/8',  frac: 1/8,  ms: 0 },
  { label: '3/16', frac: 3/16, ms: 0 },
  { label: '1/4',  frac: 1/4,  ms: 0 },
  { label: '3/8',  frac: 3/8,  ms: 0 },
];

export const CLOUD_SIZE_OPTIONS = [
  { label: 'room',  sec: 0.7 },
  { label: 'hall',  sec: 1.8 },
  { label: 'cave',  sec: 3.2 },
  { label: 'space', sec: 5.0 },
];

export const SWING_OPTIONS = [
  { label: 'straight', val: 0.50 },
  { label: 'light',    val: 0.58 },
  { label: 'med',      val: 0.67 },
  { label: 'hard',     val: 0.75 },
];

export const POLY_RATIOS = [
  { label: '3:2', factor: 2/3 },  // 3 hits in time of 2 (faster)
  { label: '4:3', factor: 3/4 },  // 4 hits in time of 3 (faster)
  { label: '5:4', factor: 4/5 },  // 5 hits in time of 4 (faster)
  { label: '7:8', factor: 8/7 },  // 7 hits in time of 8 (slightly slower)
];

export function nearestOptionIdx(options, ms) {
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < options.length; i++) {
    const d = Math.abs(options[i].ms - ms);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return best;
}

// === Scale and pitch helpers ===
// G minor pentatonic is the default playground key — sounds good across
// every interaction, including kids mashing keys (snapToScale rounds any
// MIDI note to the nearest scale degree).
export const SCALE_PITCH_CLASSES = [0, 3, 5, 7, 10];
export const SCALE_ROOT_PC = 7;

export function snapToScale(midi) {
  const rel = midi - SCALE_ROOT_PC;
  const oct = Math.floor(rel / 12);
  const mod = ((rel % 12) + 12) % 12;
  let best = SCALE_PITCH_CLASSES[0], bestDist = 12;
  for (const s of SCALE_PITCH_CLASSES) {
    const d = Math.min(Math.abs(mod - s), 12 - Math.abs(mod - s));
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return SCALE_ROOT_PC + oct * 12 + best;
}

export function inScale(midi) {
  const mod = ((midi - SCALE_ROOT_PC) % 12 + 12) % 12;
  return SCALE_PITCH_CLASSES.includes(mod);
}

export function freqFromMidi(m) { return 440 * Math.pow(2, (m - 69) / 12); }
export function midiFromFreq(f) { return Math.round(69 + 12 * Math.log2(f / 440)); }

export const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export function noteName(midi) { return NOTE_NAMES[midi % 12] + Math.floor(midi / 12 - 1); }

// === Colours ===
export const SEED_COLORS  = ['#5fd2e8', '#e85a6f', '#7ddfb3', '#ffd166', '#b393d6'];
export const WEAVE_COLOR  = '#ffa94d';
export const RIPPLE_COLOR = '#e8a8c8';
export const CLOUD_COLOR  = '#d0d8e8';
export const POLY_COLOR   = '#9be9a8';
// Phase 3 — louder/dirtier territory.
//   drive : saturation / soft clip
//   gain  : volume boost (multiplier > 1)
//   mute  : volume reduce (multiplier < 1)
export const DRIVE_COLOR = '#ff7a4d';
export const GAIN_COLOR  = '#ffe066';
export const MUTE_COLOR  = '#7a7f8e';
// Effects pass auras (#54):
//   squash : compressor — pumps and slams transients
//   wobble : LFO trem + filter modulation — movement
//   crush  : bitcrusher — lo-fi texture
export const SQUASH_COLOR = '#7ad6ff';
export const WOBBLE_COLOR = '#c478ff';
export const CRUSH_COLOR  = '#ff5577';
// Shift aura: raises the per-loop probability that a seed in its
// field switches to a different pattern variation (#53).
export const SHIFT_COLOR  = '#ffac4d';

// === Small generic helpers ===
export function makeHarmonicsArr() { return new Array(12).fill(0); }

export function shuffleArr(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Weighted random pick — `weights` is an object like { foo: 2, bar: 1 }.
// `foo` is twice as likely as `bar`.
export function pickWeighted(weights) {
  let total = 0;
  for (const k in weights) total += weights[k];
  let r = Math.random() * total;
  for (const k in weights) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return Object.keys(weights)[0];
}
