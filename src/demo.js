// Demo composition + final boot steps.
//
// On first load we plant a generative groove so the canvas isn't empty.
// The composition is rolled from one of several style templates
// (techno, dnb, dub) — each style hand-tunes positions, rhythms, and
// pattern bones, then pulls fresh timbres from the role generators in
// timbres.js so the multi-voice synthesis system shows up immediately.
//
// The 🎲 demo button (top bar) calls `rollDemo()` which clears the
// canvas, picks a different random style + variation, and plants the
// new composition. Snapshot-first means the old composition is always
// recoverable from the timeline strip. The per-seed 🎲 regenerate
// button still re-rolls a single seed's timbre without disturbing
// patterns.
//
// All styles use a 16-step bar so kicks, snares and hats share the
// same grid — that's what makes the rhythms feel rhythmically
// coherent rather than drifting.
//
// Exports: rollDemo(styleName?) — fresh composition, called on boot
// and from the top-bar 🎲 demo button. Without a style name we pick a
// random one (excluding the last-rolled style so consecutive presses
// always feel like a change).

import { NUM_HARMONICS } from './audio/context.js';
import { BEAT_MS, BAR_MS } from './tempo.js';
import { setBPM } from './transport.js';
import { makeSeed, syncRenderedSeeds } from './seeds.js';
import { takeSnapshot } from './snapshots.js';
import { tryCreateContext } from './audio/context.js';
import { setupMIDI } from './input.js';
import { TIMBRE_ROLES } from './timbres.js';
import { seeds, activeEvents, activeLiveNotes, state } from './state.js';
import { inspectorEl } from './inspector.js';

function makeHarmonics(spec) {
  const arr = new Array(NUM_HARMONICS).fill(0);
  for (const k of Object.keys(spec)) {
    const i = parseInt(k) - 2;
    if (i >= 0 && i < NUM_HARMONICS) arr[i] = spec[k];
  }
  return arr;
}

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

// Helper: 16-step pattern from a string of 16 chars where 'x' = hit,
// 'X' = accented hit (velocity 1.0), '.' = rest, digits 1-9 set
// velocity (1 → 0.1, 9 → 0.9). The offset arg is the pitch offset
// applied to every hit (so we don't have to repeat it 16 times).
function step16(spec, offset = 0) {
  if (spec.length !== 16) throw new Error('step16 needs exactly 16 chars: ' + spec);
  const out = [];
  for (let i = 0; i < 16; i++) {
    const ch = spec[i];
    let vel = 0;
    if (ch === 'X') vel = 1.0;
    else if (ch === 'x') vel = 0.85;
    else if (ch >= '1' && ch <= '9') vel = (ch.charCodeAt(0) - 48) / 10;
    else if (ch === '.') vel = 0;
    out.push({ offset, velocity: vel });
  }
  return out;
}

// Helper: a melodic line over 16 steps, where each non-dot char is a
// scale-step offset (a-g for negative, A-G for positive) and dots are
// rests. Simpler than handwriting 16 offset/velocity pairs.
function notes16(offsets) {
  if (offsets.length !== 16) throw new Error('notes16 needs exactly 16 entries: ' + JSON.stringify(offsets));
  return offsets.map(o => o === null
    ? { offset: 0, velocity: 0 }
    : { offset: o, velocity: 0.85 });
}

// === Style: TECHNO (128 BPM) =================================
// Hammered four-on-floor, offbeat open hat, snare on 2 + 4, walking
// minor-key bass, sparse lead stab, slow chord pad. Weave gives the
// lead a touch of swing; ripple delays it. Sub-bass + lead live in
// the ripple sphere so they share an echo.
function plantTechno() {
  setBPM(128);
  const stepMs = BAR_MS / 16;

  const weave = makeSeed({
    kind: 'modifier', modifierKind: 'weave',
    cx: 1120, cy: 360, r: 30, sphereR: 240,
    intervalMs: BEAT_MS, swing: 0.56,
    harmonics: makeHarmonics({ 4: 0.06, 7: 0.04 }),
    label: 'weave',
  });
  const ripple = makeSeed({
    kind: 'modifier', modifierKind: 'ripple',
    cx: 1100, cy: 200, r: 26, sphereR: 200,
    delayMs: BAR_MS * 3/16,
    harmonics: makeHarmonics({ 4: 0.05, 7: 0.03 }),
    label: 'ripple',
  });

  timbredSeed('kick', {
    cx: 220, cy: 660, r: 56, fundamental: 55,
    intervalMs: stepMs, gain: 0.42, label: 'kick',
    pattern: step16('X...X...X...X...'),
  });
  timbredSeed('snare', {
    cx: 400, cy: 680, r: 40, fundamental: 200,
    intervalMs: stepMs, gain: 0.30, label: 'clap',
    pattern: step16('....X.......X...'),
  });
  timbredSeed('hat', {
    cx: 560, cy: 620, r: 28, fundamental: 1100,
    intervalMs: stepMs, gain: 0.20, label: 'hat',
    pattern: step16('..x...x...x...x.'),
  });
  timbredSeed('hat', {
    cx: 640, cy: 580, r: 26, fundamental: 1600,
    intervalMs: stepMs, gain: 0.16, label: 'shaker',
    pattern: step16('5.6.5.6.5.7.5.8.'),
  });
  timbredSeed('bass', {
    cx: 760, cy: 580, r: 56, fundamental: 65,  // C2-ish
    intervalMs: stepMs, gain: 0.38, label: 'sub',
    pattern: step16('X...........X...', 0),
  });
  timbredSeed('bass', {
    cx: 880, cy: 540, r: 48, fundamental: 130,
    intervalMs: stepMs, gain: 0.26, label: 'bass',
    // 16-step rolling line: roots, 5ths, octaves
    pattern: notes16([0, null, 0, null, 7, null, 0, null,
                       0, null, 12, null, 7, null, 5, null]),
  });
  timbredSeed('melody', {
    cx: 1080, cy: 320, r: 44, fundamental: 392,
    intervalMs: stepMs, gain: 0.28, label: 'stab',
    pattern: notes16([0, null, null, null, null, null, null, 7,
                       null, null, null, null, 5, null, null, null]),
  });
  timbredSeed('voice', {
    cx: 460, cy: 200, r: 62, fundamental: 196,
    decay: 600, intervalMs: BAR_MS, gain: 0.18, label: 'pad',
    pattern: [
      { offset: 0, velocity: 0.85, duration: 1.0, extras: [
        { offset: 3, velocity: 0.78, duration: 1.0 },
        { offset: 7, velocity: 0.72, duration: 1.0 },
      ]},
      { offset: -2, velocity: 0.85, duration: 1.0, extras: [
        { offset: 2, velocity: 0.78, duration: 1.0 },
        { offset: 5, velocity: 0.72, duration: 1.0 },
      ]},
    ],
  });

  autoCapture();
  return 'techno';
}

// === Style: DNB (174 BPM) ===================================
// Amen-flavoured breakbeat (kick on 1 + and-of-3, snare on 2 + 4),
// fast 16th-note hats with ghost notes, deep sub bass dropping on
// the 1, atmospheric chord pad. Cloud reverb engulfs the pad +
// sub for depth.
function plantDnB() {
  setBPM(174);
  const stepMs = BAR_MS / 16;

  const cloud = makeSeed({
    kind: 'modifier', modifierKind: 'cloud',
    cx: 480, cy: 240, r: 30, sphereR: 280,
    reverbSec: 3.5, intervalMs: BEAT_MS,
    harmonics: makeHarmonics({ 4: 0.04, 6: 0.03 }),
    label: 'cloud',
  });
  const ripple = makeSeed({
    kind: 'modifier', modifierKind: 'ripple',
    cx: 1100, cy: 320, r: 26, sphereR: 220,
    delayMs: BAR_MS * 3/8,  // dotted-eighth at 174 BPM
    harmonics: makeHarmonics({ 4: 0.05 }),
    label: 'ripple',
  });

  timbredSeed('kick', {
    cx: 220, cy: 660, r: 56, fundamental: 50,
    intervalMs: stepMs, gain: 0.42, label: 'kick',
    // 1 and the 'and of 3' (step 10) — classic amen punctuation
    pattern: step16('X.........X.....'),
  });
  timbredSeed('snare', {
    cx: 400, cy: 680, r: 42, fundamental: 220,
    intervalMs: stepMs, gain: 0.36, label: 'snare',
    pattern: step16('....X..2....X..3'),
  });
  timbredSeed('hat', {
    cx: 560, cy: 620, r: 28, fundamental: 1200,
    intervalMs: stepMs, gain: 0.18, label: 'hat',
    pattern: step16('x4x5x4x6x4x5x4x7'),
  });
  timbredSeed('bass', {
    cx: 760, cy: 580, r: 60, fundamental: 41,  // E1
    intervalMs: stepMs, gain: 0.44, label: 'sub',
    // Long sub note on 1, retrigger 9, drop on 13
    pattern: notes16([0, null, null, null, null, null, null, null,
                       0, null, null, null, -3, null, null, null]),
  });
  timbredSeed('bass', {
    cx: 860, cy: 540, r: 44, fundamental: 110,
    intervalMs: stepMs, gain: 0.24, label: 'bass',
    pattern: notes16([0, null, 7, null, null, null, 0, null,
                       0, null, null, 7, null, null, 5, null]),
  });
  timbredSeed('melody', {
    cx: 1080, cy: 360, r: 42, fundamental: 440,
    intervalMs: stepMs, gain: 0.22, label: 'lead',
    pattern: notes16([null, null, null, 7, null, null, null, 5,
                       null, null, null, 3, null, null, null, 0]),
  });
  timbredSeed('voice', {
    cx: 460, cy: 220, r: 62, fundamental: 165,  // E3
    decay: 700, intervalMs: BAR_MS * 2, gain: 0.20, label: 'pad',
    pattern: [
      { offset: 0, velocity: 0.80, duration: 2.0, extras: [
        { offset: 4, velocity: 0.70, duration: 2.0 },
        { offset: 7, velocity: 0.65, duration: 2.0 },
      ]},
      { offset: -3, velocity: 0.80, duration: 2.0, extras: [
        { offset: 0, velocity: 0.70, duration: 2.0 },
        { offset: 4, velocity: 0.65, duration: 2.0 },
      ]},
    ],
  });

  autoCapture();
  return 'dnb';
}

// === Style: DUB TECHNO (118 BPM) ============================
// Slower techno cousin — half-time-feel kick, sparse offbeat chord
// stabs swimming in cloud reverb, dub-style delay tail on the stab,
// sub-bass anchor. Very few elements, lots of space.
function plantDub() {
  setBPM(118);
  const stepMs = BAR_MS / 16;

  const cloud = makeSeed({
    kind: 'modifier', modifierKind: 'cloud',
    cx: 700, cy: 220, r: 30, sphereR: 320,
    reverbSec: 4.5, intervalMs: BEAT_MS,
    harmonics: makeHarmonics({ 4: 0.04 }),
    label: 'cloud',
  });
  const ripple = makeSeed({
    kind: 'modifier', modifierKind: 'ripple',
    cx: 1080, cy: 280, r: 26, sphereR: 240,
    delayMs: BAR_MS * 3/8,
    harmonics: makeHarmonics({ 4: 0.05 }),
    label: 'dub delay',
  });

  timbredSeed('kick', {
    cx: 220, cy: 660, r: 58, fundamental: 50,
    intervalMs: stepMs, gain: 0.40, label: 'kick',
    pattern: step16('X...X...X...X...'),
  });
  timbredSeed('hat', {
    cx: 420, cy: 620, r: 26, fundamental: 1400,
    intervalMs: stepMs, gain: 0.12, label: 'hat',
    pattern: step16('..3...4...3...5.'),
  });
  timbredSeed('bass', {
    cx: 760, cy: 580, r: 58, fundamental: 55,
    intervalMs: BAR_MS, gain: 0.36, label: 'sub',
    pattern: [
      { offset: 0, velocity: 0.95, duration: 0.9 },
      { offset: -3, velocity: 0.85, duration: 0.9 },
    ],
  });
  timbredSeed('voice', {
    cx: 1080, cy: 360, r: 48, fundamental: 220,
    decay: 800, intervalMs: stepMs, gain: 0.22, label: 'stab',
    // Two offbeat chord stabs per bar
    pattern: [
      { offset: 0, velocity: 0 }, { offset: 0, velocity: 0 },
      { offset: 0, velocity: 0.85, duration: 0.4, extras: [
        { offset: 3, velocity: 0.75, duration: 0.4 },
        { offset: 7, velocity: 0.70, duration: 0.4 },
      ]},
      { offset: 0, velocity: 0 },
      { offset: 0, velocity: 0 }, { offset: 0, velocity: 0 },
      { offset: 0, velocity: 0 }, { offset: 0, velocity: 0 },
      { offset: 0, velocity: 0 }, { offset: 0, velocity: 0 },
      { offset: 0, velocity: 0.80, duration: 0.4, extras: [
        { offset: 3, velocity: 0.70, duration: 0.4 },
        { offset: 7, velocity: 0.65, duration: 0.4 },
      ]},
      { offset: 0, velocity: 0 },
      { offset: 0, velocity: 0 }, { offset: 0, velocity: 0 },
      { offset: 0, velocity: 0 },
    ],
  });
  timbredSeed('voice', {
    cx: 460, cy: 200, r: 62, fundamental: 110,
    decay: 1200, intervalMs: BAR_MS * 4, gain: 0.14, label: 'drone',
    pattern: [
      { offset: 0, velocity: 0.80, duration: 4.0, extras: [
        { offset: 7, velocity: 0.65, duration: 4.0 },
        { offset: 12, velocity: 0.55, duration: 4.0 },
      ]},
    ],
  });

  autoCapture();
  return 'dub';
}

const STYLES = {
  techno: plantTechno,
  dnb: plantDnB,
  dub: plantDub,
};

// Auto-capture: every voice inside a modifier's sphere joins it.
// Called at the end of every plant function so each style can plant
// seeds in any order without thinking about capture wiring.
function autoCapture() {
  const voices = seeds.filter(s => s.kind === 'voice');
  const mods = seeds.filter(s => s.kind === 'modifier' && s.sphereR);
  for (const v of voices) {
    for (const m of mods) {
      const d = Math.hypot(v.cx - m.cx, v.cy - m.cy);
      if (d < m.sphereR) {
        v.capturedByIds.add(m.id);
        m.capturedSeedIds.add(v.id);
      }
    }
  }
}

// Wipe live seeds + events without going through clearCanvas() (which
// would auto-snapshot in a way that confuses the timeline label).
function wipeCanvas() {
  for (const s of seeds) {
    if (s.delayInput)  { try { s.delayInput.disconnect();  } catch (e) {} }
    if (s.reverbInput) { try { s.reverbInput.disconnect(); } catch (e) {} }
  }
  seeds.length = 0;
  activeEvents.length = 0;
  state.selectedSeedId = null;
  if (inspectorEl) inspectorEl.classList.remove('open');
}

let lastStyle = null;

export function rollDemo(styleName) {
  // Pick a style if not specified, avoiding the one we just played.
  if (!styleName) {
    const choices = Object.keys(STYLES).filter(k => k !== lastStyle);
    styleName = choices[Math.floor(Math.random() * choices.length)];
  }
  const plant = STYLES[styleName];
  if (!plant) {
    console.warn('[demo] unknown style:', styleName, '— try', Object.keys(STYLES).join(' / '));
    return;
  }
  // Snapshot whatever was on the canvas first (skip on first boot when
  // there's nothing yet) so the user can revert if they hit 🎲 by
  // mistake. We use `immediate` so the pre-roll snapshot ordering is
  // deterministic w.r.t. the post-plant snapshot.
  if (seeds.length > 0) takeSnapshot('before demo · ' + (lastStyle || ''), true);
  wipeCanvas();
  const planted = plant();
  lastStyle = planted;
  syncRenderedSeeds();
  takeSnapshot('demo · ' + planted, true);
  return planted;
}

// First-load composition: pick a random style so reloads feel fresh.
rollDemo();

// Try to create the AudioContext now (it'll be suspended until a user
// gesture but having it exist avoids hangs in resume() later).
tryCreateContext();
setupMIDI();

// Top-bar demo button. (Created in index.html.)
const demoBtn = document.getElementById('demo-btn');
if (demoBtn) demoBtn.addEventListener('click', () => rollDemo());

// On-screen keyboard toggle — hides / shows the piano-bar at the
// bottom. Useful on smaller screens or when the user is exclusively
// driving murmur via their MIDI device.
const kbdBtn = document.getElementById('kbd-btn');
const pianoBar = document.querySelector('.piano-bar');
if (kbdBtn && pianoBar) {
  // Remember the user's preference across reloads.
  const KEY = 'murmur.keyboardHidden';
  if (localStorage.getItem(KEY) === '1') pianoBar.classList.add('hidden');
  kbdBtn.classList.toggle('on', !pianoBar.classList.contains('hidden'));
  kbdBtn.addEventListener('click', () => {
    pianoBar.classList.toggle('hidden');
    const hidden = pianoBar.classList.contains('hidden');
    kbdBtn.classList.toggle('on', !hidden);
    try { localStorage.setItem(KEY, hidden ? '1' : '0'); } catch (e) {}
  });
}

// DevTools handle so the user can call murmurRollDemo('dnb') etc.
window.murmurRollDemo = rollDemo;
