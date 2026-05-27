// Role generators and live-keyboard timbre state.
//
// Each role's generate() returns the legacy seed-field shape (harmonics,
// decay, attackMs, intervalMs, fundamentalHz, synthesisModel) PLUS a
// `patch` object describing the multi-layer voice graph for the new
// player. Complexity is rolled per-call so each invocation gives a
// fresh mix of simple punchy and richer textured sounds — the
// generative-music story for "wide sonic variation without designing."

import { makeHarmonicsArr, pickWeighted } from './constants.js';
import { harmonicsForPatch } from './audio/patches.js';
import { BAR_MS } from './tempo.js';
import { generateName } from './names.js';

// Pack a generator's output into the legacy + patch shape. Used by every
// role generator so the call sites stay consistent.
function packRole({ patch, intervalMs, fundamentalHz, synthesisModel }) {
  const env = patch.envelope || { attackMs: 8, releaseMs: 400 };
  // Every generated patch gets a unique-ish two-word name so the
  // user has a visible marker that a re-roll actually produced a
  // new sound. ~2,500 combinations from a curated dictionary.
  patch.name = generateName();
  return {
    harmonics: harmonicsForPatch(patch),
    decay: env.releaseMs,
    attackMs: env.attackMs,
    intervalMs,
    fundamentalHz,
    synthesisModel,
    patch,
    name: patch.name,
  };
}

export function generateKick() {
  return packRole({
    patch: {
      layers: [{ voice: 'kick', gain: 1, params: {} }],
      envelope: { attackMs: 2, releaseMs: 200 },
      category: 'drum',
    },
    intervalMs: BAR_MS / 2,
    fundamentalHz: 55 + Math.random() * 18,
    synthesisModel: 'kick',
  });
}

export function generateSnare() {
  return packRole({
    patch: {
      layers: [{ voice: 'snare', gain: 1, params: {} }],
      envelope: { attackMs: 2, releaseMs: 150 },
      category: 'drum',
    },
    intervalMs: BAR_MS / 2,
    fundamentalHz: 180 + Math.random() * 40,
    synthesisModel: 'snare',
  });
}

export function generateHihat() {
  return packRole({
    patch: {
      layers: [{ voice: 'hihat', gain: 1, params: {} }],
      envelope: { attackMs: 2, releaseMs: 80 },
      category: 'drum',
    },
    intervalMs: BAR_MS / 8,
    fundamentalHz: 800 + Math.random() * 400,
    synthesisModel: 'hihat',
  });
}

// === Generative complexity ===
// Each tonal role rolls a `complexity` per call. Low complexity = one
// punchy layer, default params. Higher complexity adds secondary layers
// (a touch of FM bell, a body harmonic, a wisp of breath noise). The
// roll happens per generate() call so the 🎲 button and main encoder
// give a mix of simple and rich sounds without the user designing them.

export function generateBass() {
  const complexity = Math.random();
  const baseVoice = pickWeighted({ subtractive: 2.0, fm: 1.2, additive: 0.8 });
  const layers = [];
  if (baseVoice === 'subtractive') {
    layers.push({
      voice: 'subtractive',
      gain: 0.75 + Math.random() * 0.15,
      params: {
        wave: Math.random() < 0.7 ? 'sawtooth' : 'square',
        filterStartHz: 800 + Math.random() * 2400,
        filterEndHz: 120 + Math.random() * 180,
        filterDecayMs: 250 + Math.random() * 400,
        Q: 3 + Math.random() * 7,
      },
    });
  } else if (baseVoice === 'fm') {
    layers.push({
      voice: 'fm',
      gain: 0.6 + Math.random() * 0.15,
      params: {
        ratio: [0.5, 1, 2][Math.floor(Math.random() * 3)],
        modIndexStart: 1.5 + Math.random() * 3,
        modIndexEnd: 0.2 + Math.random() * 0.5,
        modDecayMs: 200 + Math.random() * 400,
      },
    });
  } else {
    const h = makeHarmonicsArr();
    h[0] = 0.42 + Math.random() * 0.12;
    h[1] = 0.16 + Math.random() * 0.08;
    h[2] = 0.05 + Math.random() * 0.05;
    layers.push({ voice: 'additive', gain: 0.7, params: { harmonics: h } });
  }
  if (complexity > 0.55) {
    if (Math.random() < 0.6) {
      layers.push({
        voice: 'fm', gain: 0.10 + Math.random() * 0.12,
        params: { ratio: 3, modIndexStart: 0.5, modIndexEnd: 0.1, modDecayMs: 200 },
      });
    } else {
      const h2 = makeHarmonicsArr();
      h2[0] = 0.3; h2[1] = 0.15;
      layers.push({ voice: 'additive', gain: 0.15, params: { harmonics: h2 } });
    }
  }
  if (complexity > 0.85) {
    layers.push({
      voice: 'noise', gain: 0.03 + Math.random() * 0.05,
      params: { bandHz: 180 + Math.random() * 300, Q: 1 },
    });
  }
  return packRole({
    patch: {
      layers,
      envelope: { attackMs: 8 + Math.random() * 15, releaseMs: 400 + Math.random() * 400 },
      category: 'tonal',
    },
    intervalMs: BAR_MS / 2,
    fundamentalHz: 55 + Math.random() * 55,
    synthesisModel: 'additive',
  });
}

export function generateMelody() {
  const complexity = Math.random();
  const baseVoice = pickWeighted({ subtractive: 1.5, fm: 1.3, additive: 1.0, supersaw: 0.6 });
  const layers = [];
  if (baseVoice === 'subtractive') {
    layers.push({
      voice: 'subtractive', gain: 0.6 + Math.random() * 0.2,
      params: {
        wave: pickWeighted({ sawtooth: 1.0, square: 0.4 }),
        filterStartHz: 2500 + Math.random() * 3500,
        filterEndHz: 600 + Math.random() * 1000,
        filterDecayMs: 250 + Math.random() * 500,
        Q: 2 + Math.random() * 4,
      },
    });
  } else if (baseVoice === 'fm') {
    layers.push({
      voice: 'fm', gain: 0.55 + Math.random() * 0.15,
      params: {
        ratio: [1, 2, 3, 0.5, 3.5][Math.floor(Math.random() * 5)],
        modIndexStart: 1.0 + Math.random() * 3,
        modIndexEnd: 0.2 + Math.random() * 0.6,
        modDecayMs: 150 + Math.random() * 400,
      },
    });
  } else if (baseVoice === 'supersaw') {
    layers.push({
      voice: 'supersaw', gain: 0.45 + Math.random() * 0.15,
      params: { voices: 3, detuneCents: 5 + Math.random() * 10, filterMult: 8 + Math.random() * 10 },
    });
  } else {
    const h = makeHarmonicsArr();
    for (let i = 0; i < 6; i++) h[i] = (0.32 - i * 0.045) * (0.85 + Math.random() * 0.3);
    layers.push({ voice: 'additive', gain: 0.6, params: { harmonics: h } });
  }
  if (complexity > 0.5) {
    if (Math.random() < 0.5) {
      layers.push({
        voice: 'fm', gain: 0.12 + Math.random() * 0.15,
        params: { ratio: 3, modIndexStart: 0.8, modIndexEnd: 0.15, modDecayMs: 200 },
      });
    } else {
      const h = makeHarmonicsArr();
      h[0] = 0.3; h[2] = 0.15; h[4] = 0.08;
      layers.push({ voice: 'additive', gain: 0.18, params: { harmonics: h } });
    }
  }
  if (complexity > 0.8) {
    layers.push({
      voice: 'noise', gain: 0.04 + Math.random() * 0.05,
      params: { bandHz: 800 + Math.random() * 2000, Q: 1.5 },
    });
  }
  return packRole({
    patch: {
      layers,
      envelope: { attackMs: 8 + Math.random() * 25, releaseMs: 400 + Math.random() * 500 },
      category: 'tonal',
    },
    intervalMs: BAR_MS / 4,
    fundamentalHz: 294 + Math.random() * 294,
    synthesisModel: 'additive',
  });
}

export function generateVoice() {
  const complexity = Math.random();
  const baseVoice = pickWeighted({ additive: 1.5, supersaw: 1.2, subtractive: 0.4 });
  const layers = [];
  if (baseVoice === 'additive') {
    const vowels = [
      { idx: [2, 3, 4],     amps: [0.40, 0.45, 0.20] },         // ah
      { idx: [0, 8, 9, 10], amps: [0.45, 0.30, 0.25, 0.15] },   // ee
      { idx: [0, 1, 2, 3],  amps: [0.30, 0.45, 0.35, 0.20] },   // oh
    ];
    const v = vowels[Math.floor(Math.random() * vowels.length)];
    const h = makeHarmonicsArr();
    h[0] = 0.22 + Math.random() * 0.15;
    v.idx.forEach((idx, i) => { h[idx] = v.amps[i] * (0.85 + Math.random() * 0.30); });
    layers.push({ voice: 'additive', gain: 0.55, params: { harmonics: h } });
  } else if (baseVoice === 'supersaw') {
    layers.push({
      voice: 'supersaw', gain: 0.4 + Math.random() * 0.15,
      params: { voices: 3, detuneCents: 6 + Math.random() * 8, filterMult: 5 + Math.random() * 7 },
    });
  } else {
    layers.push({
      voice: 'subtractive', gain: 0.5,
      params: { wave: 'sawtooth', filterStartHz: 1500, filterEndHz: 900, filterDecayMs: 800, Q: 2 },
    });
  }
  // A breath / air layer is a defining part of "voice" — include it often.
  if (Math.random() < 0.7 || complexity > 0.4) {
    layers.push({
      voice: 'noise', gain: 0.04 + Math.random() * 0.06,
      params: { bandHz: 1500 + Math.random() * 2500, Q: 1.2 },
    });
  }
  if (complexity > 0.7) {
    const h = makeHarmonicsArr();
    h[0] = 0.2; h[1] = 0.15; h[3] = 0.1;
    layers.push({ voice: 'additive', gain: 0.14, params: { harmonics: h } });
  }
  return packRole({
    patch: {
      layers,
      envelope: { attackMs: 50 + Math.random() * 60, releaseMs: 700 + Math.random() * 500 },
      category: 'tonal',
    },
    intervalMs: BAR_MS,
    fundamentalHz: 196 + Math.random() * 196,
    synthesisModel: 'additive',
  });
}

export const TIMBRE_ROLES = {
  kick:   { label: 'kick',  generate: generateKick,   color: '#e85a6f' },
  snare:  { label: 'snare', generate: generateSnare,  color: '#ffa94d' },
  hat:    { label: 'hat',   generate: generateHihat,  color: '#ffd166' },
  bass:   { label: 'bass',  generate: generateBass,   color: '#9474e8' },
  melody: { label: 'mel',   generate: generateMelody, color: '#5fd2e8' },
  voice:  { label: 'voi',   generate: generateVoice,  color: '#b393d6' },
};

// Per-role octave shift applied to LIVE keyboard notes so the same
// physical key gives a sensibly different pitch depending on the
// active role. The MiniLab 3 has only 25 keys (G3..G5), so without
// this you'd press middle C and get the same C5 sound for both bass
// and melody — defeating the role distinction. With the shift, bass
// sits two octaves below where you press, hat two above, and so on.
export const LIVE_ROLE_OCTAVE_SHIFT = {
  kick:   -2,   // sub-bass kick range
  snare:  -1,   // tom-ish low
  hat:    +1,   // crisp high
  bass:   -2,   // proper bass range
  melody:  0,   // around the key you pressed
  voice:  -1,   // pad/vocal a little lower than melody
};

// === Active role + live keyboard timbre ===
// `activeRole` is the timbre that new voice seeds adopt when planted.
// `liveTimbre` is what the keyboard plays through. Both live as
// exported `let` so importers see live bindings; mutation goes through
// setActiveRole / rollLiveTimbre rather than direct assignment.

export let activeRole = 'melody';

export function setActiveRole(role) {
  if (TIMBRE_ROLES[role]) activeRole = role;
}

// Includes the three drum roles too — kick/snare/hat play pitched
// versions of themselves on the keyboard, which is musically odd but
// playable and gives more variety per encoder turn.
// Pitched roles only. Drums live on bank A pads 1-4 — they don't
// make sense as a keyboard timbre (one kick voice doesn't change
// pitch in a musically useful way per key) and would force the user
// to scroll past three "useless on the keys" entries.
const LIVE_TIMBRE_CYCLE = ['bass', 'melody', 'voice'];
let liveTimbreIdx = 1;  // melody

// Cache one patch per role so twisting the encoder swaps between
// previously-heard sounds rather than rolling a fresh random patch
// every detent (which made the device feel chaotic — every twist
// produced a different sound). Click the encoder to re-roll the
// current role's patch with a new random variant.
const liveTimbreCache = {};
function ensureRolePatch(role) {
  if (!liveTimbreCache[role]) {
    const gen = TIMBRE_ROLES[role].generate();
    gen.role = role;
    liveTimbreCache[role] = gen;
  }
  return liveTimbreCache[role];
}

export let liveTimbre = ensureRolePatch(LIVE_TIMBRE_CYCLE[liveTimbreIdx]);

function paintActiveRole(role) {
  activeRole = role;
  document.querySelectorAll('.palette-item').forEach(el =>
    el.classList.toggle('active', el.dataset.role === role));
}

// Twist the encoder: scroll to the next/previous role in the cycle
// and swap to that role's cached patch. No new random generation —
// the same role gives the same sound every time you scroll back to it.
export function rollLiveTimbre(direction = 1) {
  liveTimbreIdx = (liveTimbreIdx + direction + LIVE_TIMBRE_CYCLE.length) % LIVE_TIMBRE_CYCLE.length;
  const role = LIVE_TIMBRE_CYCLE[liveTimbreIdx];
  liveTimbre = ensureRolePatch(role);
  paintActiveRole(role);
}

// Click the encoder (or any "commit" gesture): re-roll the current
// role's patch with a fresh random variant. Updates the cache so
// the new sound is what you hear next time you scroll back here.
export function regenerateLiveTimbre() {
  const role = LIVE_TIMBRE_CYCLE[liveTimbreIdx];
  const gen = TIMBRE_ROLES[role].generate();
  gen.role = role;
  liveTimbreCache[role] = gen;
  liveTimbre = gen;
  paintActiveRole(role);
}
