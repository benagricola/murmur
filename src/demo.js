// Demo composition + final boot steps. Plants an immediate four-on-floor
// groove so the canvas isn't empty on first load, then snapshots that
// state as the first entry in the history strip and kicks off the
// AudioContext + MIDI subsystems.

import { NUM_HARMONICS } from './audio/context.js';
import { BEAT_MS, BAR_MS } from './tempo.js';
import { setBPM } from './transport.js';
import { makeSeed, syncRenderedSeeds } from './seeds.js';
import { takeSnapshot } from './snapshots.js';
import { tryCreateContext } from './audio/context.js';
import { setupMIDI } from './input.js';

function makeHarmonics(spec) {
  const arr = new Array(NUM_HARMONICS).fill(0);
  for (const k of Object.keys(spec)) {
    const i = parseInt(k) - 2;
    if (i >= 0 && i < NUM_HARMONICS) arr[i] = spec[k];
  }
  return arr;
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
const bass = makeSeed({
  cx: 760, cy: 580, r: 56,
  fundamental: 82,
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
const lead = makeSeed({
  cx: 1080, cy: 340, r: 44,
  fundamental: 392,
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
// Chord pad — G minor → F-major-ish (pentatonic-snapped), one chord per bar.
const pad = makeSeed({
  cx: 460, cy: 200, r: 62,
  fundamental: 196,
  decay: 700, attackMs: 80,
  intervalMs: BAR_MS,
  harmonics: makeHarmonics({ 2: 0.28, 3: 0.15, 4: 0.08, 5: 0.05 }),
  color: '#b393d6', label: 'pad', gain: 0.16,
  role: 'voice', synthesisModel: 'additive',
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
