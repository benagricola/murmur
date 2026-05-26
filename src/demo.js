// Demo composition + final boot steps. Plants an immediate four-on-floor
// groove so the canvas isn't empty on first load, then snapshots that
// state as the first entry in the history strip and kicks off the
// AudioContext + MIDI subsystems.
//
// Each demo seed pulls its timbre from the role generators in
// timbres.js so the multi-voice synthesis system (subtractive saws,
// FM bells, supersaw, noise layers) shows up on first load instead of
// being gated behind "plant something new" or "press regenerate".
// Pattern, position, and rhythm stay hand-tuned per seed; only the
// timbre is rolled. The 🎲 regenerate button re-rolls the timbre
// without disturbing the pattern.

import { NUM_HARMONICS } from './audio/context.js';
import { BEAT_MS, BAR_MS } from './tempo.js';
import { setBPM } from './transport.js';
import { makeSeed, syncRenderedSeeds } from './seeds.js';
import { takeSnapshot } from './snapshots.js';
import { tryCreateContext } from './audio/context.js';
import { setupMIDI } from './input.js';
import { TIMBRE_ROLES } from './timbres.js';

function makeHarmonics(spec) {
  const arr = new Array(NUM_HARMONICS).fill(0);
  for (const k of Object.keys(spec)) {
    const i = parseInt(k) - 2;
    if (i >= 0 && i < NUM_HARMONICS) arr[i] = spec[k];
  }
  return arr;
}

// Roll a fresh timbre for a role and merge with caller-supplied
// fields. The caller's `decay` / `attackMs` / `harmonics` / `patch`
// override the generated ones (rare — usually we want the rolled
// values to show the synthesis variety on first load).
function timbredSeed(role, opts) {
  const gen = TIMBRE_ROLES[role].generate();
  return makeSeed({
    decay: gen.decay,
    attackMs: gen.attackMs,
    harmonics: gen.harmonics,
    patch: gen.patch,
    synthesisModel: gen.synthesisModel,
    role,
    ...opts,
  });
}

// Start at 120 BPM (matches the tempo slider default) so the demo
// plays at pop / dance speed rather than 96 BPM.
setBPM(120);

// === Demo composition: basic four-on-floor groove ===
// Drums (kick/snare/hat) demonstrate the procedural drum voices.
// Bass + lead demonstrate sustained additive voices.
// Weave imposes light swing on the lead; ripple gives lead an echo trail.
const weave = makeSeed({
  kind: 'modifier', modifierKind: 'weave',
  cx: 1120, cy: 380, r: 30,
  intervalMs: BEAT_MS, sphereR: 200,
  swing: 0.58,
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

const kick = timbredSeed('kick', {
  cx: 240, cy: 660, r: 56,
  fundamental: 55,
  intervalMs: BAR_MS / 8,
  color: '#e85a6f', label: 'kick', gain: 0.40,
  pattern: [
    {offset:0,velocity:1.0},{offset:0,velocity:0},{offset:0,velocity:0},{offset:0,velocity:0},
    {offset:0,velocity:1.0},{offset:0,velocity:0},{offset:0,velocity:0},{offset:0,velocity:0},
  ],
});
const snare = timbredSeed('snare', {
  cx: 400, cy: 680, r: 40,
  fundamental: 200,
  intervalMs: BAR_MS / 8,
  color: '#ffa94d', label: 'snare', gain: 0.32,
  pattern: [
    {offset:0,velocity:0},{offset:0,velocity:0},{offset:0,velocity:1.0},{offset:0,velocity:0},
    {offset:0,velocity:0},{offset:0,velocity:0},{offset:0,velocity:1.0},{offset:0,velocity:0},
  ],
});
const hat = timbredSeed('hat', {
  cx: 560, cy: 620, r: 28,
  fundamental: 1000,
  intervalMs: BAR_MS / 8,
  color: '#ffd166', label: 'hat', gain: 0.22,
  pattern: [
    {offset:0,velocity:0.9},{offset:0,velocity:0.6},{offset:0,velocity:0.7},{offset:0,velocity:0.6},
    {offset:0,velocity:0.9},{offset:0,velocity:0.6},{offset:0,velocity:0.7},{offset:0,velocity:0.6},
  ],
});
const bass = timbredSeed('bass', {
  cx: 760, cy: 580, r: 56,
  fundamental: 82,
  intervalMs: BAR_MS / 4,
  color: '#9474e8', label: 'bass', gain: 0.34,
  pattern: [
    {offset:0,velocity:1.0}, {offset:0,velocity:0.85},
    {offset:7,velocity:0.95}, {offset:5,velocity:0.85},
  ],
});
const lead = timbredSeed('melody', {
  cx: 1080, cy: 340, r: 44,
  fundamental: 392,
  intervalMs: BAR_MS / 4,
  color: '#5fd2e8', label: 'lead', gain: 0.26,
  pattern: [
    {offset:0,velocity:1.0}, {offset:5,velocity:0.85},
    {offset:7,velocity:0.95}, {offset:3,velocity:0.80},
    {offset:0,velocity:0.90}, {offset:-2,velocity:0.85},
    {offset:5,velocity:0.95}, {offset:7,velocity:0.80},
  ],
});
// Chord pad — G minor → F-major-ish (pentatonic-snapped), one chord
// per bar. Decay overridden to a slightly tighter ~500ms so adjacent
// chords don't mush together; the generator's default 700-1200ms is
// gorgeous in isolation but excessive at bar-by-bar chord changes.
const pad = timbredSeed('voice', {
  cx: 460, cy: 200, r: 62,
  fundamental: 196,
  decay: 500,
  intervalMs: BAR_MS,
  color: '#b393d6', label: 'pad', gain: 0.16,
  pattern: [
    { offset: 0, velocity: 0.85, duration: 1.0, extras: [
      { offset: 3, velocity: 0.80, duration: 1.0 },
      { offset: 7, velocity: 0.75, duration: 1.0 },
    ]},
    { offset: -2, velocity: 0.85, duration: 1.0, extras: [
      { offset: 2, velocity: 0.80, duration: 1.0 },
      { offset: 5, velocity: 0.75, duration: 1.0 },
    ]},
  ],
});

// Auto-capture: every voice inside a modifier's sphere joins it.
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

// Try to create the AudioContext now (it'll be suspended until a user
// gesture but having it exist avoids hangs in resume() later).
tryCreateContext();
setupMIDI();
