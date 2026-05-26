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

//
// =========================================================================
//  TEMPO (mutable). Options' `.ms` is recomputed via setBPM so existing
//  seeds reschedule musically correctly when tempo changes.
// =========================================================================
//
let BPM = 96;
let BEAT_MS = 60000 / BPM;
let BAR_MS = BEAT_MS * 4;

function recomputeOptionsMs() {
  for (const o of RHYTHM_OPTIONS) o.ms = o.frac * BAR_MS;
  for (const o of LENGTH_OPTIONS) o.ms = o.frac * BAR_MS;
  for (const o of RIPPLE_DELAY_OPTIONS) o.ms = o.frac * BAR_MS;
}
recomputeOptionsMs();

// Re-snap all seed intervals/decays to preserve musical relationships
function setBPM(newBPM) {
  newBPM = Math.max(40, Math.min(220, newBPM));
  const oldBar = BAR_MS;
  BPM = newBPM;
  BEAT_MS = 60000 / BPM;
  BAR_MS = BEAT_MS * 4;
  recomputeOptionsMs();
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
// Pack a generator's output into the legacy + patch shape. Used by every
// role generator so the call sites stay consistent.
function packRole({ patch, intervalMs, fundamentalHz, synthesisModel }) {
  const env = patch.envelope || { attackMs: 8, releaseMs: 400 };
  return {
    harmonics: harmonicsForPatch(patch),
    decay: env.releaseMs,
    attackMs: env.attackMs,
    intervalMs,
    fundamentalHz,
    synthesisModel,
    patch,
  };
}

function generateKick() {
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

function generateSnare() {
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

function generateHihat() {
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

function generateBass() {
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

function generateMelody() {
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

function generateVoice() {
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

const TIMBRE_ROLES = {
  kick:   { label: 'kick',  generate: generateKick,   color: '#e85a6f' },
  snare:  { label: 'snare', generate: generateSnare,  color: '#ffa94d' },
  hat:    { label: 'hat',   generate: generateHihat,  color: '#ffd166' },
  bass:   { label: 'bass',  generate: generateBass,   color: '#9474e8' },
  melody: { label: 'mel',   generate: generateMelody, color: '#5fd2e8' },
  voice:  { label: 'voi',   generate: generateVoice,  color: '#b393d6' },
};

let activeRole = 'melody';

// === Live keyboard timbre ===
// The keyboard (MIDI / QWERTY / on-screen) plays through one shared
// timbre defined by `liveTimbre`. Each turn of the hardware main
// encoder cycles the role and re-rolls a fresh variation so the
// player gets meaningfully different sounds without leaving the keys.
const LIVE_TIMBRE_CYCLE = ['bass', 'melody', 'voice'];
let liveTimbreIdx = 1;  // melody
let liveTimbre = TIMBRE_ROLES[LIVE_TIMBRE_CYCLE[liveTimbreIdx]].generate();
liveTimbre.role = LIVE_TIMBRE_CYCLE[liveTimbreIdx];

function rollLiveTimbre(direction = 1) {
  liveTimbreIdx = (liveTimbreIdx + direction + LIVE_TIMBRE_CYCLE.length) % LIVE_TIMBRE_CYCLE.length;
  const role = LIVE_TIMBRE_CYCLE[liveTimbreIdx];
  liveTimbre = TIMBRE_ROLES[role].generate();
  liveTimbre.role = role;
  activeRole = role;
  document.querySelectorAll('.palette-item').forEach(el =>
    el.classList.toggle('active', el.dataset.role === role));
}

//
// =========================================================================
//  STATE
// =========================================================================
//
let guardrails = true;
let isRecording = false;
let recordingBuffer = null;  // { startTime, notes: [{midi, t, velocity}], lastNoteTime }
const RECORD_AUTO_FINISH_MS = 1500;  // stop after this much silence

const seeds = [];
let nextSeedId = 1;
let selectedSeedId = null;
let plantMode = 'voice';

function seedById(id) { return seeds.find(s => s.id === id); }

//
// =========================================================================
//  AUDIO
// =========================================================================
//
let audioCtx = null;
let masterGain = null;
let isPlaying = false;
let playbackStartTime = 0;
let supportsPeriodicWave = false;

function showAudioStatus(text, kind = '') {
  const el = document.getElementById('audio-status');
  if (!el) return;
  el.textContent = 'audio: ' + text;
  el.classList.remove('error', 'ok');
  if (kind === 'error') el.classList.add('error');
  else if (kind === 'ok') el.classList.add('ok');
}

// Race a promise against a timer so a hung Promise can't freeze our flow.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise.then(v => ({ value: v }), e => ({ error: e })),
    new Promise(resolve => setTimeout(() => resolve({ timeout: true, label }), ms)),
  ]);
}

// Synchronously create the AudioContext. Safe to call multiple times.
// In some browsers/iframes this only succeeds inside a user-gesture handler,
// so we both try it at load time AND on the first interaction.
function tryCreateContext() {
  if (audioCtx) return true;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { showAudioStatus('no web audio api', 'error'); return false; }
    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.35;
    masterGain.connect(audioCtx.destination);
    // Detect PeriodicWave support (some older Android WebViews lack it)
    try {
      const w = audioCtx.createPeriodicWave(new Float32Array([0, 1, 0]), new Float32Array([0, 0, 0]));
      const tosc = audioCtx.createOscillator();
      tosc.setPeriodicWave(w);
      supportsPeriodicWave = true;
    } catch (e) {
      supportsPeriodicWave = false;
    }
    // Set up audio chains for any modifiers that were created before audio existed
    for (const s of seeds) {
      setupModifierChain(s);
    }
    showAudioStatus('ctx ' + audioCtx.state + (supportsPeriodicWave ? '' : ' · basic'));
    return true;
  } catch (e) {
    showAudioStatus('create: ' + (e.message || e), 'error');
    return false;
  }
}

// Ensure audio is created AND resumed. Resume is timeout-guarded so a
// non-resolving Promise can't lock up the UI. Safe to call from any handler.
async function ensureAudio() {
  if (!audioCtx && !tryCreateContext()) return null;
  if (audioCtx.state === 'suspended') {
    showAudioStatus('resuming...');
    const result = await withTimeout(audioCtx.resume(), 1500, 'resume');
    if (result.timeout) {
      showAudioStatus('resume timeout · state=' + audioCtx.state, 'error');
    } else if (result.error) {
      showAudioStatus('resume err · ' + (result.error.message || ''), 'error');
    } else {
      showAudioStatus(audioCtx.state + (supportsPeriodicWave ? '' : ' · basic'),
                      audioCtx.state === 'running' ? 'ok' : '');
    }
  } else {
    showAudioStatus(audioCtx.state + (supportsPeriodicWave ? '' : ' · basic'),
                    audioCtx.state === 'running' ? 'ok' : '');
  }
  return audioCtx;
}

// Back-compat alias for callers that still say initAudio
const initAudio = ensureAudio;

// Try once at script load — many browsers permit this and just create it
// in suspended state. Having the context exist early avoids gesture-timing
// issues during user interaction.
// (Called later, after seeds are populated, so the ripple chain can attach.)

// Also re-attempt on first user interaction in case load-time creation failed
let firstInteractionHandled = false;
function handleFirstInteraction() {
  if (firstInteractionHandled) return;
  firstInteractionHandled = true;
  ensureAudio();
}
document.addEventListener('pointerdown', handleFirstInteraction, { capture: true });
document.addEventListener('keydown', handleFirstInteraction, { capture: true });
document.addEventListener('touchstart', handleFirstInteraction, { capture: true });

function setMasterVol(v) {
  if (masterGain) masterGain.gain.setTargetAtTime(v, audioCtx.currentTime, 0.05);
}
function setupRippleChain(rippleSeed) {
  if (rippleSeed.delayInput) return;
  const input = audioCtx.createGain();
  const delay = audioCtx.createDelay(3.0);
  delay.delayTime.value = (rippleSeed.delayMs || 469) / 1000;
  const feedback = audioCtx.createGain(); feedback.gain.value = 0.42;
  const wet = audioCtx.createGain(); wet.gain.value = 0.55;
  input.connect(delay); delay.connect(wet); wet.connect(masterGain);
  delay.connect(feedback); feedback.connect(delay);
  rippleSeed.delayInput = input;
  rippleSeed.delayNode = delay;
}

// Cloud = reverb modifier. Uses ConvolverNode with a procedurally generated
// impulse response (exponentially decaying noise).
function createReverbIR(durationSec) {
  const sampleRate = audioCtx.sampleRate;
  const length = Math.floor(sampleRate * Math.max(0.1, durationSec));
  const ir = audioCtx.createBuffer(2, length, sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.0);
    }
  }
  return ir;
}

function setupCloudChain(cloudSeed) {
  if (cloudSeed.reverbInput) return;
  const input = audioCtx.createGain();
  const convolver = audioCtx.createConvolver();
  convolver.buffer = createReverbIR(cloudSeed.reverbSec || 2.0);
  const wet = audioCtx.createGain();
  wet.gain.value = 0.50;
  input.connect(convolver);
  convolver.connect(wet);
  wet.connect(masterGain);
  cloudSeed.reverbInput = input;
  cloudSeed.convolver = convolver;
}

function setupModifierChain(seed) {
  if (seed.kind !== 'modifier' || !audioCtx) return;
  if (seed.modifierKind === 'ripple') setupRippleChain(seed);
  if (seed.modifierKind === 'cloud') setupCloudChain(seed);
}

const NUM_HARMONICS = 12;
function buildPeriodicWave(harmonicAmps) {
  const len = NUM_HARMONICS + 2;
  const real = new Float32Array(len);
  const imag = new Float32Array(len);
  real[1] = 1.0;
  for (let i = 0; i < harmonicAmps.length; i++) real[i + 2] = harmonicAmps[i] || 0;
  return audioCtx.createPeriodicWave(real, imag);
}

// Apply a harmonic spectrum to an oscillator. If PeriodicWave isn't supported,
// approximate by picking a standard waveform type based on the harmonic content.
function setOscWave(osc, harmonicAmps) {
  if (supportsPeriodicWave) {
    try {
      osc.setPeriodicWave(buildPeriodicWave(harmonicAmps));
      return;
    } catch (e) { /* fall through */ }
  }
  const lower = (harmonicAmps[0] || 0) + (harmonicAmps[1] || 0) + (harmonicAmps[2] || 0);
  const upper = (harmonicAmps[6] || 0) + (harmonicAmps[7] || 0) + (harmonicAmps[8] || 0) + (harmonicAmps[9] || 0);
  if (upper > 0.15) osc.type = 'sawtooth';
  else if (lower > 0.3) osc.type = 'triangle';
  else osc.type = 'sine';
}

// =========================================================================
//  VOICES — atomic synthesis primitives
// =========================================================================
//
// Each voice is a small builder that returns:
//   { output: AudioNode, stop(when), detune(cents, when) | null }
//
// `output` carries the voice's raw signal (no envelope, no routing). The
// player (playPatch) wraps voices in a shared envelope and routes the
// summed signal to bombs/modifiers/master. `stop` schedules teardown.
// `detune` is null for noise/drum voices that don't track pitch bend.
//
// A "patch" is `{ layers: [{voice, params, gain}], envelope, category }`.
// Single-layer patches are the common case; multi-layer patches mix
// timbres in parallel (e.g. saw bass + FM bell + breath of noise).

const VOICES = {};

VOICES.additive = function(audioCtx, freq, when, params) {
  const harmonics = params.harmonics || [0.4, 0.2, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0];
  const osc = audioCtx.createOscillator();
  const out = audioCtx.createGain();
  setOscWave(osc, harmonics);
  osc.frequency.value = freq;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = Math.min(8000, freq * (params.filterMult || 16));
  filter.Q.value = params.Q != null ? params.Q : 0.7;
  osc.connect(filter); filter.connect(out);
  osc.start(when);
  return {
    output: out,
    stop: (whenStop) => { try { osc.stop(whenStop); } catch (e) {} },
    detune: (cents, t) => { try { osc.detune.setTargetAtTime(cents, t, 0.005); } catch (e) {} },
  };
};

VOICES.subtractive = function(audioCtx, freq, when, params) {
  const osc = audioCtx.createOscillator();
  const out = audioCtx.createGain();
  osc.type = params.wave || 'sawtooth';
  osc.frequency.value = freq;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = params.Q != null ? params.Q : 6;
  const startHz = Math.max(80, params.filterStartHz || Math.min(8000, freq * 12));
  const endHz = Math.max(80, params.filterEndHz || Math.min(2000, freq * 3));
  const decayMs = params.filterDecayMs || 350;
  filter.frequency.setValueAtTime(startHz, when);
  filter.frequency.exponentialRampToValueAtTime(endHz, when + decayMs / 1000);
  osc.connect(filter); filter.connect(out);
  osc.start(when);
  return {
    output: out,
    stop: (whenStop) => { try { osc.stop(whenStop); } catch (e) {} },
    detune: (cents, t) => { try { osc.detune.setTargetAtTime(cents, t, 0.005); } catch (e) {} },
  };
};

VOICES.fm = function(audioCtx, freq, when, params) {
  const ratio = params.ratio != null ? params.ratio : 2;
  const modIndexStart = params.modIndexStart != null ? params.modIndexStart : 2;
  const modIndexEnd = params.modIndexEnd != null ? params.modIndexEnd : 0.4;
  const decayMs = params.modDecayMs || 400;
  const carrier = audioCtx.createOscillator();
  const mod = audioCtx.createOscillator();
  const modGain = audioCtx.createGain();
  const out = audioCtx.createGain();
  carrier.type = 'sine';
  mod.type = 'sine';
  carrier.frequency.value = freq;
  mod.frequency.value = freq * ratio;
  modGain.gain.setValueAtTime(freq * modIndexStart, when);
  modGain.gain.exponentialRampToValueAtTime(Math.max(0.01, freq * modIndexEnd), when + decayMs / 1000);
  mod.connect(modGain);
  modGain.connect(carrier.frequency);
  carrier.connect(out);
  mod.start(when);
  carrier.start(when);
  return {
    output: out,
    stop: (whenStop) => {
      try { mod.stop(whenStop); } catch (e) {}
      try { carrier.stop(whenStop); } catch (e) {}
    },
    detune: (cents, t) => {
      try { carrier.detune.setTargetAtTime(cents, t, 0.005); } catch (e) {}
      try { mod.detune.setTargetAtTime(cents, t, 0.005); } catch (e) {}
    },
  };
};

VOICES.supersaw = function(audioCtx, freq, when, params) {
  const voiceCount = params.voices || 3;
  const spread = params.detuneCents != null ? params.detuneCents : 7;
  const sum = audioCtx.createGain();
  const oscs = [];
  for (let i = 0; i < voiceCount; i++) {
    const o = audioCtx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const baseDetune = (i - (voiceCount - 1) / 2) * spread;
    o.detune.value = baseDetune;
    const og = audioCtx.createGain();
    og.gain.value = 1 / voiceCount;
    o.connect(og); og.connect(sum);
    o.start(when);
    oscs.push({ osc: o, baseDetune });
  }
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = Math.min(8000, freq * (params.filterMult || 10));
  filter.Q.value = params.Q != null ? params.Q : 0.5;
  const out = audioCtx.createGain();
  sum.connect(filter); filter.connect(out);
  return {
    output: out,
    stop: (whenStop) => { for (const { osc } of oscs) { try { osc.stop(whenStop); } catch (e) {} } },
    detune: (cents, t) => {
      for (const { osc, baseDetune } of oscs) {
        try { osc.detune.setTargetAtTime(cents + baseDetune, t, 0.005); } catch (e) {}
      }
    },
  };
};

VOICES.noise = function(audioCtx, freq, when, params) {
  const noise = audioCtx.createBufferSource();
  noise.buffer = createNoiseBuffer(2.0);
  noise.loop = true;
  const filter = audioCtx.createBiquadFilter();
  filter.type = params.filterType || 'bandpass';
  filter.frequency.value = Math.max(80, params.bandHz || Math.min(6000, freq * (params.bandMult || 4)));
  filter.Q.value = params.Q != null ? params.Q : 1.5;
  const out = audioCtx.createGain();
  noise.connect(filter); filter.connect(out);
  noise.start(when);
  return {
    output: out,
    stop: (whenStop) => { try { noise.stop(whenStop); } catch (e) {} },
    detune: null,
  };
};

// Drum voices have internal envelopes baked in — the player treats them
// as one-shot and skips the shared attack/release ramp.

VOICES.kick = function(audioCtx, freq, when, params) {
  const osc = audioCtx.createOscillator();
  const out = audioCtx.createGain();
  osc.type = 'sine';
  const startFreq = Math.max(40, freq * 1.5);
  const endFreq = Math.max(35, freq * 0.5);
  osc.frequency.setValueAtTime(startFreq, when);
  osc.frequency.exponentialRampToValueAtTime(endFreq, when + 0.060);
  osc.connect(out);
  out.gain.setValueAtTime(0, when);
  out.gain.linearRampToValueAtTime(1.4, when + 0.002);
  out.gain.exponentialRampToValueAtTime(0.0008, when + 0.20);
  osc.start(when);
  return {
    output: out,
    stop: (whenStop) => { try { osc.stop(Math.max(whenStop, when + 0.25)); } catch (e) {} },
    detune: null,
  };
};

VOICES.snare = function(audioCtx, freq, when, params) {
  const out = audioCtx.createGain();
  const osc = audioCtx.createOscillator();
  const oscEnv = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = Math.max(140, freq * 0.8);
  osc.connect(oscEnv); oscEnv.connect(out);
  oscEnv.gain.setValueAtTime(0, when);
  oscEnv.gain.linearRampToValueAtTime(0.4, when + 0.001);
  oscEnv.gain.exponentialRampToValueAtTime(0.0008, when + 0.08);

  const noise = audioCtx.createBufferSource();
  noise.buffer = createNoiseBuffer(0.15);
  const nf = audioCtx.createBiquadFilter();
  nf.type = 'bandpass'; nf.frequency.value = 2200; nf.Q.value = 0.7;
  const noiseEnv = audioCtx.createGain();
  noise.connect(nf); nf.connect(noiseEnv); noiseEnv.connect(out);
  noiseEnv.gain.setValueAtTime(0, when);
  noiseEnv.gain.linearRampToValueAtTime(0.65, when + 0.001);
  noiseEnv.gain.exponentialRampToValueAtTime(0.0008, when + 0.12);

  osc.start(when); noise.start(when);
  return {
    output: out,
    stop: (whenStop) => {
      try { osc.stop(Math.max(whenStop, when + 0.15)); } catch (e) {}
      try { noise.stop(Math.max(whenStop, when + 0.15)); } catch (e) {}
    },
    detune: null,
  };
};

VOICES.hihat = function(audioCtx, freq, when, params) {
  const noise = audioCtx.createBufferSource();
  noise.buffer = createNoiseBuffer(0.1);
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 7000;
  const out = audioCtx.createGain();
  noise.connect(filter); filter.connect(out);
  out.gain.setValueAtTime(0, when);
  out.gain.linearRampToValueAtTime(0.55, when + 0.001);
  out.gain.exponentialRampToValueAtTime(0.0008, when + 0.045);
  noise.start(when);
  return {
    output: out,
    stop: (whenStop) => { try { noise.stop(Math.max(whenStop, when + 0.1)); } catch (e) {} },
    detune: null,
  };
};

// playPatch — single dispatcher for all note-making in murmur. Builds
// every voice in `patch.layers` in parallel, sums them through a shared
// envelope, hands the result to the routing function. Returns a handle
// with `release(when)` for the open-ended live case and `detune(cents)`
// for pitch-bend updates.
function playPatch(patch, when, freq, gain, sustainMs, routeFn) {
  if (!audioCtx) return null;
  if (!patch || !patch.layers || patch.layers.length === 0) {
    patch = { layers: [{ voice: 'additive', gain: 1, params: {} }] };
  }
  const summer = audioCtx.createGain();
  const env = audioCtx.createGain();
  summer.connect(env);
  routeFn(env);

  const voices = [];
  const detunes = [];
  for (const layer of patch.layers) {
    const fn = VOICES[layer.voice];
    if (!fn) continue;
    const params = layer.params || {};
    const v = fn(audioCtx, freq, when, params);
    const lg = audioCtx.createGain();
    lg.gain.value = layer.gain != null ? layer.gain : 1.0;
    v.output.connect(lg);
    lg.connect(summer);
    voices.push(v);
    if (v.detune) detunes.push(v.detune);
  }

  const isOneShot = patch.category === 'drum' || patch.isOneShot === true;
  const e = patch.envelope || { attackMs: 8, releaseMs: 200 };
  const a = Math.max(0.001, (e.attackMs || 8) / 1000);
  const r = Math.max(0.01, (e.releaseMs || 200) / 1000);

  if (isOneShot) {
    env.gain.value = gain;
    const stopAt = when + (sustainMs ? sustainMs / 1000 : 0.5);
    for (const v of voices) v.stop(stopAt + 0.1);
    return {
      release: () => {},
      detune: (cents, t) => { for (const d of detunes) d(cents, t); },
      output: env,
    };
  }

  if (sustainMs != null) {
    const sustainSec = Math.max(0, sustainMs / 1000 - a);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(gain, when + a);
    if (sustainSec > 0) env.gain.setValueAtTime(gain, when + a + sustainSec);
    env.gain.linearRampToValueAtTime(0, when + a + sustainSec + r);
    for (const v of voices) v.stop(when + a + sustainSec + r + 0.05);
    return {
      release: () => {},
      detune: (cents, t) => { for (const d of detunes) d(cents, t); },
      output: env,
    };
  }

  // Live mode: attack then sustain indefinitely; caller invokes release()
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(gain, when + a);
  return {
    release: (whenRelease) => {
      try {
        if (typeof env.gain.cancelAndHoldAtTime === 'function') {
          env.gain.cancelAndHoldAtTime(whenRelease);
        } else {
          env.gain.cancelScheduledValues(whenRelease);
          env.gain.setValueAtTime(env.gain.value, whenRelease);
        }
        env.gain.linearRampToValueAtTime(0, whenRelease + r);
        for (const v of voices) v.stop(whenRelease + r + 0.05);
      } catch (e) {}
    },
    detune: (cents, t) => { for (const d of detunes) d(cents, t); },
    output: env,
  };
}

// === DRUM SYNTHESIS ===
// Procedural drum sounds, not additive. Each uses the appropriate node graph:
// kick = sine with pitch sweep; snare = triangle + bandpass noise; hat = HP noise.
let _noiseBufferCache = null;
function createNoiseBuffer(durationSec) {
  durationSec = Math.max(0.05, durationSec);
  if (_noiseBufferCache && _noiseBufferCache.length / audioCtx.sampleRate >= durationSec - 0.001) {
    return _noiseBufferCache;
  }
  const length = Math.floor(audioCtx.sampleRate * Math.max(0.3, durationSec));
  const buf = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  _noiseBufferCache = buf;
  return buf;
}

// Route a node into any modifier audio chains capturing this seed.
// Centralized so kick/snare/hat/additive all participate in cloud/ripple effects.
// Voices can be captured by multiple modifiers — fan out to all relevant chains.
// === EVENTS (one-shot temporal effects) ===
// Bombs: expanding regions of "effect applied". On reaching max radius they
// pop — effect ceases instantly everywhere — and trigger an echo flash on
// affected seeds. New event kinds plug in via BOMB_KINDS below.
const activeEvents = [];
let nextEventId = 1;

const BOMB_KINDS = {
  drop:   { label: 'drop',   color: '#ff4d80', maxRadius: 320, durationBars: 1 },
  muffle: { label: 'muffle', color: '#5e7ad8', maxRadius: 360, durationBars: 1 },
  thin:   { label: 'thin',   color: '#ffd84d', maxRadius: 360, durationBars: 1 },
};

// Sweeps are directional lines that travel from start→end over a fixed musical duration.
// As the wavefront passes each voice, the voice's mute state is committed (persists
// after the sweep completes — unlike bombs which snap back at pop).
const SWEEP_KINDS = {
  rise: { label: 'rise', color: '#5af095', durationBars: 4, action: 'unmute' },
  fade: { label: 'fade', color: '#ff7a8c', durationBars: 4, action: 'mute' },
};

function bombCurrentRadius(ev) {
  if (ev.state !== 'expanding') return ev.maxRadius;
  const elapsedMs = performance.now() - ev.startTimeMs;
  const phase = Math.min(1, elapsedMs / ev.durationMs);
  return ev.maxRadius * phase;
}

// Return any bombs whose current radius contains this seed.
function activeBombsAffecting(seed) {
  const out = [];
  for (const ev of activeEvents) {
    if (ev.state !== 'expanding') continue;
    const r = bombCurrentRadius(ev);
    if (Math.hypot(seed.cx - ev.cx, seed.cy - ev.cy) <= r) out.push(ev);
  }
  return out;
}

// Centralized output routing. Replaces the previous masterGain+routeToModifiers
// dance. Handles bomb effects, mod sends, master output in one place.
function routeFinalOutput(seed, node) {
  const bombs = activeBombsAffecting(seed);
  // Mute (drop) bomb takes priority — silence the note entirely
  const muteBomb = bombs.find(b => b.kind === 'drop');
  if (!muteBomb) {
    // Filter bombs route the dry signal through their filter node
    const filterBomb = bombs.find(b => b.filterNode);
    if (filterBomb) node.connect(filterBomb.filterNode);
    else node.connect(masterGain);
    // Modifier sends are parallel — they still fire even if a filter bomb is active
    if (seed.capturedByIds && seed.capturedByIds.size > 0) {
      for (const id of seed.capturedByIds) {
        const m = seedById(id);
        if (!m) continue;
        if (m.modifierKind === 'ripple' && m.delayInput) node.connect(m.delayInput);
        if (m.modifierKind === 'cloud'  && m.reverbInput) node.connect(m.reverbInput);
      }
    }
  }
  // If muteBomb is active, we don't connect to anything. Note plays silently.
}

// Legacy alias kept for any callers that didn't get updated
function routeToModifiers(seed, node) {
  if (!seed.capturedByIds || seed.capturedByIds.size === 0) return;
  for (const id of seed.capturedByIds) {
    const m = seedById(id);
    if (!m) continue;
    if (m.modifierKind === 'ripple' && m.delayInput) node.connect(m.delayInput);
    if (m.modifierKind === 'cloud'  && m.reverbInput) node.connect(m.reverbInput);
  }
}

function spawnBomb(cx, cy, kindKey) {
  if (!audioCtx) initAudio();
  const def = BOMB_KINDS[kindKey];
  if (!def) return null;
  const ev = {
    id: nextEventId++,
    type: 'bomb',
    kind: kindKey,
    color: def.color,
    cx, cy,
    maxRadius: def.maxRadius,
    durationMs: def.durationBars * BAR_MS,
    startTimeMs: performance.now(),
    state: 'expanding',           // 'expanding' → 'popped' → 'done'
    popTimeMs: null,
    affectedSeedIds: new Set(),
    filterNode: null,
  };
  // Build audio effect chain for filter bombs
  if (audioCtx && masterGain) {
    if (kindKey === 'muffle') {
      const f = audioCtx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 380;  // heavy muffle
      f.Q.value = 0.9;
      f.connect(masterGain);
      ev.filterNode = f;
    } else if (kindKey === 'thin') {
      const f = audioCtx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 2400;  // bright thin
      f.Q.value = 0.9;
      f.connect(masterGain);
      ev.filterNode = f;
    }
  }
  activeEvents.push(ev);
  return ev;
}

function spawnSweep(x0, y0, x1, y1, kindKey) {
  const def = SWEEP_KINDS[kindKey];
  if (!def) return null;
  // Reject tiny sweeps that probably came from a stray click rather than a drag
  if (Math.hypot(x1 - x0, y1 - y0) < 30) return null;
  const ev = {
    id: nextEventId++,
    type: 'sweep',
    kind: kindKey,
    color: def.color,
    x0, y0, x1, y1,
    durationMs: def.durationBars * BAR_MS,
    startTimeMs: performance.now(),
    state: 'active',  // 'active' → 'done' (then removed after 500ms)
    affectedSeedIds: new Set(),
  };
  activeEvents.push(ev);
  return ev;
}

// Legacy seed → patch shim. Older seeds (and snapshots from before the
// voice/patch refactor) only carry the flat `harmonics + decay + attackMs
// + synthesisModel` fields. Build a one-layer patch from those so the
// new player can render them without us needing a database migration.
function patchFromLegacySeed(seed) {
  if (seed._cachedPatch) return seed._cachedPatch;
  const model = seed.synthesisModel || 'additive';
  let layers;
  if (model === 'kick')       layers = [{ voice: 'kick',   gain: 1, params: {} }];
  else if (model === 'snare') layers = [{ voice: 'snare',  gain: 1, params: {} }];
  else if (model === 'hihat') layers = [{ voice: 'hihat',  gain: 1, params: {} }];
  else                        layers = [{ voice: 'additive', gain: 1, params: { harmonics: seed.harmonics } }];
  const category = (model === 'kick' || model === 'snare' || model === 'hihat') ? 'drum' : 'tonal';
  const patch = {
    layers,
    envelope: { attackMs: seed.attackMs || 8, releaseMs: seed.decay || 400 },
    category,
  };
  seed._cachedPatch = patch;
  return patch;
}

// Build a representative 12-element harmonic profile from a patch for
// the visual blob shape. Reads the first additive layer if present,
// otherwise picks a tasteful default based on the dominant voice type.
function harmonicsForPatch(patch) {
  if (!patch || !patch.layers) return [0.4, 0.2, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const layer of patch.layers) {
    if (layer.voice === 'additive' && layer.params && layer.params.harmonics) {
      return layer.params.harmonics.slice();
    }
  }
  const first = patch.layers[0];
  if (!first) return [0.4, 0.2, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0];
  if (first.voice === 'subtractive') return [0.5, 0.25, 0.15, 0.10, 0.07, 0.05, 0.03, 0.02, 0.01, 0, 0, 0];
  if (first.voice === 'fm')          return [0.3, 0.18, 0.12, 0.08, 0.10, 0.06, 0.08, 0.04, 0.06, 0.03, 0, 0];
  if (first.voice === 'supersaw')    return [0.45, 0.22, 0.14, 0.09, 0.06, 0.04, 0.03, 0.02, 0.01, 0, 0, 0];
  if (first.voice === 'noise')       return [0.10, 0.08, 0.06, 0.06, 0.08, 0.10, 0.06, 0.05, 0.04, 0.03, 0.02, 0.01];
  if (first.voice === 'kick')        return [0.7, 0.15, 0.05, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  if (first.voice === 'snare')       return [0.15, 0.12, 0.10, 0.20, 0.15, 0.10, 0.08, 0.06, 0.04, 0, 0, 0];
  if (first.voice === 'hihat')       return [0.02, 0.03, 0.04, 0.05, 0.08, 0.12, 0.18, 0.20, 0.15, 0.10, 0.06, 0.04];
  return [0.4, 0.2, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0];
}

// === LIVE PLAY (sustained) ===
// noteOn creates an oscillator + envelope and stores them in activeLiveNotes
// keyed by INPUT midi (the raw key the user pressed). noteOff fires the
// release ramp and stops the oscillator after release. Holding a key produces
// a sustained note; releasing it produces a release tail.
const activeLiveNotes = new Map();

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
  if (handle && handle.detune) handle.detune(pitchBendCents, audioCtx.currentTime);
  activeLiveNotes.set(midi, { handle, targetMidi });
  showFloatingNote(targetMidi);
  return targetMidi;
}

// Notes that have been released but are still ringing out. We keep these
// reachable so pitch-bend updates during the decay tail continue to take
// effect — otherwise bending the strip stops working the moment you lift
// your finger off the key, which feels broken on a real keyboard.
const releasingNotes = new Set();

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

function playNoteAt(seed, when, freq, gain, sustainMs) {
  // All seeds dispatch through the patch player now. Drums (category:'drum')
  // are handled as one-shot inside playPatch; the supplied sustainMs is
  // honoured for the routing window but their internal envelopes are
  // already baked into the voice. Tonal patches get attack → sustain →
  // release shaped by `patch.envelope`.
  const patch = seed.patch || patchFromLegacySeed(seed);
  // If a tonal seed has a legacy `decay` that differs from the patch's
  // releaseMs (e.g. user adjusted the length knob), prefer the live seed
  // value so inspector tweaks keep working post-refactor.
  if (patch.category !== 'drum' && seed.decay) {
    patch.envelope = patch.envelope || {};
    if (patch.envelope.releaseMs !== seed.decay) {
      patch.envelope = { ...patch.envelope, releaseMs: seed.decay };
      seed._cachedPatch = patch;
    }
  }
  playPatch(patch, when, freq, gain, sustainMs, (n) => routeFinalOutput(seed, n));
  seed.lastPulseAt = when;
}

function playSeedStep(seed, when) {
  if (!seed.pattern || seed.pattern.length === 0) {
    playNoteAt(seed, when, seed.fundamental, seed.gain || 0.35);
    return;
  }
  const stepIdx = seed.patternIdx % seed.pattern.length;
  const step = seed.pattern[stepIdx];
  seed.patternIdx = stepIdx + 1;
  const delayMs = Math.max(0, (when - audioCtx.currentTime) * 1000);
  setTimeout(() => {
    seed.currentStep = stepIdx;
    if (selectedSeedId === seed.id) highlightCurrentStep(seed);
  }, delayMs);
  if (step.velocity < 0.05) return;
  const baseMidi = midiFromFreq(seed.fundamental);
  const baseGain = seed.gain || 0.35;
  // Play primary
  const targetMidi = baseMidi + (step.offset || 0);
  const finalMidi = seed.quantize ? snapToScale(targetMidi) : targetMidi;
  const freq = freqFromMidi(finalMidi);
  const sustainMs = step.duration !== undefined ? step.duration * seed.intervalMs : undefined;
  playNoteAt(seed, when, freq, baseGain * step.velocity, sustainMs);
  // Play extras (chord tones) simultaneously
  if (step.extras && step.extras.length > 0) {
    for (const ex of step.extras) {
      const exMidi = baseMidi + (ex.offset || 0);
      const exFinalMidi = seed.quantize ? snapToScale(exMidi) : exMidi;
      const exFreq = freqFromMidi(exFinalMidi);
      const exSustainMs = ex.duration !== undefined ? ex.duration * seed.intervalMs : sustainMs;
      playNoteAt(seed, when, exFreq, baseGain * (ex.velocity !== undefined ? ex.velocity : step.velocity), exSustainMs);
    }
    // Record this chord step for blob visualization. Only chord steps trigger
    // outlines — single-note steps stay represented by the seed body alone.
    if (!seed._chordVoices) seed._chordVoices = [];
    const sustainSec = (sustainMs !== undefined ? sustainMs : seed.decay) / 1000;
    const releaseSec = seed.decay / 1000;
    seed._chordVoices.push({
      offset: step.offset || 0,
      startedAt: when,
      sustainSec,
      releaseSec,
    });
    for (const ex of step.extras) {
      const exSusSec = (ex.duration !== undefined ? ex.duration * seed.intervalMs : sustainMs) / 1000;
      seed._chordVoices.push({
        offset: ex.offset || 0,
        startedAt: when,
        sustainSec: exSusSec || sustainSec,
        releaseSec,
      });
    }
    // Cap to prevent runaway accumulation on long loops
    if (seed._chordVoices.length > 30) {
      seed._chordVoices = seed._chordVoices.slice(-30);
    }
  }
}

//
// =========================================================================
//  KEYBOARD INPUT (MIDI + QWERTY + on-screen piano)
//  All three sources end at noteOn(midi, velocity) → noteOff(midi).
// =========================================================================
//
function noteOn(midi, velocity, source = 'qwerty') {
  // If recording, push this note into the buffer.
  if (isRecording) {
    if (!recordingBuffer) {
      recordingBuffer = { startTime: performance.now(), notes: [], lastActivityMs: performance.now() };
    }
    recordingBuffer.notes.push({
      midi,
      t: performance.now() - recordingBuffer.startTime,
      velocity,
      noteOnMs: performance.now(),
      duration: null,  // filled in on noteOff
    });
    recordingBuffer.lastActivityMs = performance.now();
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
  if (isRecording && recordingBuffer) {
    for (let i = recordingBuffer.notes.length - 1; i >= 0; i--) {
      const note = recordingBuffer.notes[i];
      if (note.midi === midi && note.duration === null) {
        note.duration = performance.now() - note.noteOnMs;
        break;
      }
    }
    recordingBuffer.lastActivityMs = performance.now();
    rescheduleRecordingAutoFinish();
  }
  // Sustain pedal: defer audible release until the pedal lifts. The
  // recording timestamps above already captured the finger-release
  // time, so the recorded duration reflects the keypress, not the
  // sustained tail — matching standard MIDI-piano convention.
  highlightPianoKey(midi, false);
  if (sustainPedalDown && activeLiveNotes.has(midi)) {
    sustainedMidis.add(midi);
    return;
  }
  liveNoteOff(midi);
}

// Auto-finish recording when there's been no activity AND no keys held.
// Without the held-keys check, holding a long note would falsely auto-finish.
function rescheduleRecordingAutoFinish() {
  if (!recordingBuffer) return;
  clearTimeout(recordingBuffer.silenceTimer);
  recordingBuffer.silenceTimer = setTimeout(checkAutoFinishRecording, RECORD_AUTO_FINISH_MS);
}
function checkAutoFinishRecording() {
  if (!isRecording || !recordingBuffer) return;
  if (activeLiveNotes.size > 0) {
    // Keys still held — recheck in 100ms
    recordingBuffer.silenceTimer = setTimeout(checkAutoFinishRecording, 100);
    return;
  }
  const sinceActivity = performance.now() - recordingBuffer.lastActivityMs;
  if (sinceActivity < RECORD_AUTO_FINISH_MS) {
    recordingBuffer.silenceTimer = setTimeout(checkAutoFinishRecording, RECORD_AUTO_FINISH_MS - sinceActivity + 50);
    return;
  }
  finishRecording();
}

// === Web MIDI ===
let midiAccess = null;
const midiOutputs = [];  // populated by refreshMIDIInputs; reserved for SysEx light/screen control

// === Expressive controls (pitch bend, sustain) ===
const PITCH_BEND_RANGE_SEMITONES = 2;   // standard default
let pitchBendCents = 0;
function applyPitchBend(normalised) {
  // normalised in [-1, +1]. Convert to cents and push to every held and
  // releasing note so the bend follows through into the decay tail.
  pitchBendCents = normalised * PITCH_BEND_RANGE_SEMITONES * 100;
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  for (const note of activeLiveNotes.values()) {
    try { note.handle.detune(pitchBendCents, now); } catch (e) {}
  }
  for (const note of releasingNotes) {
    try { note.handle.detune(pitchBendCents, now); } catch (e) {}
  }
}

let sustainPedalDown = false;
const sustainedMidis = new Set();
function setSustainPedal(down) {
  if (down === sustainPedalDown) return;
  sustainPedalDown = down;
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
  if (typeof isPlaying !== 'undefined' && isPlaying) {
    document.getElementById('play-btn').click();
  }
}
function transportPlay() {
  if (typeof isPlaying !== 'undefined' && !isPlaying) {
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
  if (isRecording) return;
  isRecording = true;
  recordingBuffer = null;
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
  if (!isRecording) return;
  isRecording = false;
  document.getElementById('rec-btn').classList.remove('recording');
  document.getElementById('rec-btn').textContent = '● record';
  const ov = document.getElementById('rec-overlay');
  if (ov) ov.remove();

  if (!recordingBuffer || recordingBuffer.notes.length === 0) {
    return;
  }
  const result = phraseFromRecording(recordingBuffer);
  recordingBuffer = null;

  if (!result) return;

  // If a voice seed is selected, overwrite its pattern; otherwise plant new.
  const sel = seedById(selectedSeedId);
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

  const stepMs = guardrails ? (BAR_MS / 16) : (BAR_MS / 32);
  const maxSteps = guardrails ? 16 : 32;
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
      const useMidi = guardrails ? snapToScale(nn.midi) : nn.midi;
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
  if (isRecording) finishRecording();
  else startRecording();
});

//
// =========================================================================
//  SEED MODEL & RENDERING (mostly unchanged from v3)
// =========================================================================
//
function makeSeed(opts) {
  const seed = {
    id: nextSeedId++,
    kind: opts.kind || 'voice',
    modifierKind: opts.modifierKind,
    cx: opts.cx, cy: opts.cy,
    r: opts.r || 40,
    color: opts.color,
    fundamental: opts.fundamental || 220,
    decay: opts.decay || 500,
    intervalMs: opts.intervalMs || BEAT_MS,
    harmonics: opts.harmonics ? opts.harmonics.slice() : new Array(NUM_HARMONICS).fill(0),
    gain: opts.gain || 0.32,
    label: opts.label || (opts.kind === 'modifier' ? opts.modifierKind : 'seed'),
    pattern: opts.pattern
      ? opts.pattern.map(s => {
          const copy = {
            offset: s.offset || 0,
            velocity: s.velocity !== undefined ? s.velocity : 1.0,
          };
          if (s.duration !== undefined) copy.duration = s.duration;
          if (s.extras && s.extras.length > 0) {
            copy.extras = s.extras.map(e => ({
              offset: e.offset || 0,
              velocity: e.velocity !== undefined ? e.velocity : 1.0,
              duration: e.duration,
            }));
          }
          return copy;
        })
      : [{ offset: 0, velocity: 1.0 }],
    patternIdx: 0,
    currentStep: -1,
    nextTrigger: 0,
    lastPulseAt: 0,
    quantize: opts.quantize !== undefined ? opts.quantize : true,
    capturedByIds: new Set(),
    capturedSeedIds: new Set(),
    sphereR: opts.sphereR || 0,
    delayMs: opts.delayMs || 469,
    reverbSec: opts.reverbSec || 2.0,
    delayInput: null,
    delayNode: null,
    reverbInput: null,
    convolver: null,
    role: opts.role || null,
    swing: opts.swing !== undefined ? opts.swing : 0.5,
    synthesisModel: opts.synthesisModel || 'additive',
    attackMs: opts.attackMs !== undefined ? opts.attackMs : 8,
    polyFactor: opts.polyFactor !== undefined ? opts.polyFactor : 2/3,
    muted: opts.muted || false,
    patch: opts.patch || null,
  };
  if (!seed.color) {
    if (seed.kind === 'modifier') {
      if (seed.modifierKind === 'weave') seed.color = WEAVE_COLOR;
      else if (seed.modifierKind === 'ripple') seed.color = RIPPLE_COLOR;
      else if (seed.modifierKind === 'cloud') seed.color = CLOUD_COLOR;
      else if (seed.modifierKind === 'poly') seed.color = POLY_COLOR;
    } else {
      seed.color = (seed.role && TIMBRE_ROLES[seed.role])
        ? TIMBRE_ROLES[seed.role].color
        : SEED_COLORS[seeds.length % SEED_COLORS.length];
    }
  }
  setupModifierChain(seed);
  seeds.push(seed);
  return seed;
}

function removeSeed(id) {
  const seed = seedById(id);
  if (!seed) return;
  if (seed.kind === 'modifier') {
    for (const vid of seed.capturedSeedIds) {
      const v = seedById(vid);
      if (v) v.capturedByIds.delete(id);
    }
  }
  if (seed.kind === 'voice' && seed.capturedByIds) {
    for (const modId of seed.capturedByIds) {
      const m = seedById(modId);
      if (m) m.capturedSeedIds.delete(id);
    }
  }
  const i = seeds.findIndex(s => s.id === id);
  if (i >= 0) seeds.splice(i, 1);
  if (selectedSeedId === id) {
    selectedSeedId = null;
    document.getElementById('inspector').classList.remove('open');
  }
}

function radiusForFundamental(hz) {
  return Math.max(18, Math.min(80, 50 + (220 - hz) / 8));
}

function blobPath(cx, cy, baseR, harmonicAmps, attachments) {
  const N = 128;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const theta = (i / N) * Math.PI * 2;
    let r = baseR;
    for (let h = 0; h < harmonicAmps.length; h++) {
      const amp = harmonicAmps[h];
      if (amp) r += baseR * amp * 0.55 * Math.cos((h + 2) * theta);
    }
    if (attachments) {
      for (const a of attachments) {
        let d = Math.abs(((theta - a.angle + Math.PI) % (Math.PI * 2)) - Math.PI);
        r += baseR * a.strength * Math.exp(-(d * d) / (2 * a.width * a.width));
      }
    }
    pts.push([cx + r * Math.cos(theta), cy + r * Math.sin(theta)]);
  }
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N], p1 = pts[i], p2 = pts[(i + 1) % N], p3 = pts[(i + 2) % N];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d + ' Z';
}

// Compute deformation peaks for a voice seed based on what's capturing it.
// Strength chosen to be larger than any natural harmonic variation so peaks
// are clearly visible as tendrils growing toward the capturing modifier.
const PEAK_STRENGTH = 0.30;
const PEAK_WIDTH = 0.08;
const PEAK_TIP_FACTOR = 1 + PEAK_STRENGTH + 0.02;

function attachmentsForSeed(seed) {
  if (!seed || seed.kind !== 'voice' || !seed.capturedByIds || seed.capturedByIds.size === 0) return null;
  const atts = [];
  for (const id of seed.capturedByIds) {
    const m = seedById(id);
    if (!m) continue;
    atts.push({
      angle: Math.atan2(m.cy - seed.cy, m.cx - seed.cx),
      strength: PEAK_STRENGTH,
      width: PEAK_WIDTH,
    });
  }
  return atts;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const canvasEl = document.getElementById('canvas');
const canvasWrap = document.getElementById('canvas-wrap');
const spheresLayer = document.getElementById('spheres-layer');
const tethersLayer = document.getElementById('tethers-layer');
const seedsLayer = document.getElementById('seeds-layer');
const tapMarkersLayer = document.getElementById('tap-markers');
const seedNodes = new Map();

function renderSeed(seed) {
  let node = seedNodes.get(seed.id);
  if (!node) {
    const wrap = document.createElementNS(SVGNS, 'g');
    wrap.setAttribute('class', 'seed-wrap');
    wrap.dataset.seedId = seed.id;
    const halo = document.createElementNS(SVGNS, 'path');
    halo.setAttribute('class', 'seed-halo');
    halo.setAttribute('opacity', '0.45');
    wrap.appendChild(halo);
    const core = document.createElementNS(SVGNS, 'path');
    core.setAttribute('class', 'seed-core');
    wrap.appendChild(core);
    const ghosts = document.createElementNS(SVGNS, 'g');
    wrap.appendChild(ghosts);
    // Layer for chord outlines — sits above core so the outlines are visible on top
    const chordLayer = document.createElementNS(SVGNS, 'g');
    chordLayer.setAttribute('pointer-events', 'none');
    wrap.appendChild(chordLayer);
    const label = document.createElementNS(SVGNS, 'text');
    label.setAttribute('class', 'seed-label');
    wrap.appendChild(label);
    seedsLayer.appendChild(wrap);
    node = { wrap, halo, core, ghosts, chordLayer, label };
    seedNodes.set(seed.id, node);
  }
  node.halo.setAttribute('fill', seed.color);
  node.core.setAttribute('fill', seed.color);
  const atts = attachmentsForSeed(seed);
  if (seed.kind === 'modifier') {
    node.halo.setAttribute('filter', 'url(#halo-blur-small)');
    if (seed.modifierKind === 'weave') {
      node.core.setAttribute('class', 'seed-core weave-pulse');
    } else if (seed.modifierKind === 'cloud') {
      node.core.setAttribute('class', 'seed-core cloud-pulse');
    } else if (seed.modifierKind === 'poly') {
      node.core.setAttribute('class', 'seed-core poly-pulse');
    } else {
      node.core.setAttribute('class', 'seed-core');
    }
    if (seed.modifierKind === 'ripple' && node.ghosts.children.length === 0) {
      const drifts = [
        { gx: 14, gy: 6, delay: 0 },
        { gx: 16, gy: -4, delay: 500 },
        { gx: 10, gy: 12, delay: 1000 },
      ];
      drifts.forEach(d => {
        const ghost = document.createElementNS(SVGNS, 'path');
        ghost.setAttribute('fill', seed.color);
        ghost.setAttribute('class', 'ripple-ghost');
        ghost.style.setProperty('--gx', d.gx + 'px');
        ghost.style.setProperty('--gy', d.gy + 'px');
        ghost.style.animationDelay = d.delay + 'ms';
        node.ghosts.appendChild(ghost);
      });
    }
    if (seed.modifierKind === 'ripple') {
      for (const g of node.ghosts.children) {
        g.setAttribute('d', blobPath(seed.cx, seed.cy, seed.r, seed.harmonics));
      }
    }
  } else {
    node.halo.setAttribute('filter', 'url(#halo-blur)');
    node.core.setAttribute('class', 'seed-core');
  }
  node.halo.setAttribute('d', blobPath(seed.cx, seed.cy, seed.r * 1.3, seed.harmonics, atts));
  node.core.setAttribute('d', blobPath(seed.cx, seed.cy, seed.r, seed.harmonics, atts));
  node.label.setAttribute('x', seed.cx);
  node.label.setAttribute('y', seed.cy + seed.r + 22);
  node.label.textContent = seed.label;
  if (selectedSeedId === seed.id) node.wrap.classList.add('seed-selected');
  else node.wrap.classList.remove('seed-selected');
  node.wrap.classList.toggle('muted', !!seed.muted);
}

function renderSpheres() {
  spheresLayer.innerHTML = '';
  for (const s of seeds) {
    if (s.kind !== 'modifier' || !s.sphereR) continue;
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', s.cx); c.setAttribute('cy', s.cy);
    c.setAttribute('r', s.sphereR);
    c.setAttribute('class', 'sphere');
    c.setAttribute('fill', `url(#sphere-${s.modifierKind}-grad)`);
    spheresLayer.appendChild(c);
  }
}

function renderTethers() {
  tethersLayer.innerHTML = '';
  for (const v of seeds) {
    if (v.kind !== 'voice' || !v.capturedByIds || v.capturedByIds.size === 0) continue;
    for (const modId of v.capturedByIds) {
      const m = seedById(modId);
      if (!m) continue;
      const path = document.createElementNS(SVGNS, 'path');
      const ang = Math.atan2(m.cy - v.cy, m.cx - v.cx);
      const ax = v.cx + v.r * PEAK_TIP_FACTOR * Math.cos(ang);
      const ay = v.cy + v.r * PEAK_TIP_FACTOR * Math.sin(ang);
      const bx = m.cx, by = m.cy;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      const perpX = len ? -dy / len : 0, perpY = len ? dx / len : 0;
      const sag = Math.min(len * 0.10, 24);
      const ctrlX = mx + perpX * sag, ctrlY = my + perpY * sag;
      path.setAttribute('d', `M ${ax.toFixed(1)} ${ay.toFixed(1)} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`);
      path.setAttribute('class', 'tether-' + m.modifierKind);
      path.setAttribute('stroke', m.color);
      tethersLayer.appendChild(path);
    }
  }
}

function syncRenderedSeeds() {
  const liveIds = new Set(seeds.map(s => s.id));
  for (const [id, node] of seedNodes) {
    if (!liveIds.has(id)) { node.wrap.remove(); seedNodes.delete(id); }
  }
  const ordered = [...seeds].sort((a, b) =>
    (a.kind === 'modifier' ? 0 : 1) - (b.kind === 'modifier' ? 0 : 1));
  for (const s of ordered) {
    renderSeed(s);
    seedsLayer.appendChild(seedNodes.get(s.id).wrap);
  }
  renderSpheres();
  renderTethers();
}

//
// =========================================================================
//  SCHEDULER
// =========================================================================
//
// Weave used to impose its interval on captured voices, which was redundant
// with per-seed rhythm controls. Weave now applies swing (timing skew) instead:
// odd-indexed pattern steps are delayed by a swing amount, even-indexed steps
// catch up. This produces groove that's musically distinctive and impossible
// to dial in per-seed by hand.
function effectiveIntervalForVoice(seed) {
  return seed.intervalMs;
}

function scheduleAhead() {
  if (!audioCtx || !isPlaying) return;
  const now = audioCtx.currentTime;
  const lookahead = 0.10;
  for (const seed of seeds) {
    if (seed.kind !== 'voice') continue;
    let baseInterval = seed.intervalMs / 1000;
    let swing = 0.5;
    // Iterate ALL capturing modifiers. Polyrhythm scales interval, weave sets swing.
    // Multiple polys multiply factors; last weave wins (overlapping weaves rare).
    if (seed.capturedByIds && seed.capturedByIds.size > 0) {
      for (const id of seed.capturedByIds) {
        const m = seedById(id);
        if (!m) continue;
        if (m.modifierKind === 'poly' && m.polyFactor) baseInterval *= m.polyFactor;
        if (m.modifierKind === 'weave' && m.swing) swing = m.swing;
      }
    }
    if (!seed.nextTrigger || seed.nextTrigger < now - 1) {
      if (seed.quantize) {
        const sincePlaybackStart = now - playbackStartTime;
        const nextSlot = Math.ceil(sincePlaybackStart / baseInterval) * baseInterval;
        seed.nextTrigger = playbackStartTime + nextSlot;
      } else {
        seed.nextTrigger = now + 0.04;
      }
    }
    while (seed.nextTrigger < now + lookahead) {
      const stepBeforePlay = seed.patternIdx % seed.pattern.length;
      if (!seed.muted) {
        playSeedStep(seed, seed.nextTrigger);
      } else {
        // Advance pattern index even when muted so position stays sensible on unmute
        seed.patternIdx = (seed.patternIdx + 1) % Math.max(1, seed.pattern.length);
      }
      let intervalToNext;
      if (Math.abs(swing - 0.5) < 0.01) {
        intervalToNext = baseInterval;
      } else if (stepBeforePlay % 2 === 0) {
        intervalToNext = swing * 2 * baseInterval;
      } else {
        intervalToNext = (1 - swing) * 2 * baseInterval;
      }
      seed.nextTrigger += intervalToNext;
    }
  }
}
setInterval(scheduleAhead, 25);

function visualTick() {
  const now = audioCtx ? audioCtx.currentTime : 0;
  for (const seed of seeds) {
    const node = seedNodes.get(seed.id);
    if (!node) continue;
    if (seed.kind === 'modifier') continue;
    let pulseScale = 1;
    if (seed.lastPulseAt) {
      const since = now - seed.lastPulseAt;
      const pulse = Math.max(0, Math.exp(-since * 6) - 0.05);
      pulseScale = 1 + 0.14 * pulse;
    }
    node.core.style.transform = `scale(${pulseScale})`;
    node.halo.style.transform = `scale(${pulseScale * 1.05})`;
    node.halo.style.opacity = (0.35 + 0.3 * (pulseScale - 1) / 0.14).toFixed(2);
    renderChordOutlines(seed, node, now);
  }
  updateEvents();
  renderEvents();
  requestAnimationFrame(visualTick);
}
requestAnimationFrame(visualTick);

// Render one stroked-blob outline per active chord voice.
// Higher-pitched voices = smaller scale (shorter wavelength metaphor).
// Each voice fades through attack → sustain (full opacity) → release (fade out).
function renderChordOutlines(seed, node, audioNow) {
  if (!node.chordLayer) return;
  // Drum-synth seeds ignore pitch — chord outlines would be visually misleading
  const isDrum = seed.synthesisModel === 'kick' || seed.synthesisModel === 'snare' || seed.synthesisModel === 'hihat';
  if (isDrum) {
    if (node.chordLayer.childNodes.length > 0) node.chordLayer.innerHTML = '';
    return;
  }
  if (!seed._chordVoices || seed._chordVoices.length === 0) {
    if (node.chordLayer.childNodes.length > 0) node.chordLayer.innerHTML = '';
    return;
  }
  // Filter out fully-faded voices
  seed._chordVoices = seed._chordVoices.filter(v => {
    const elapsed = audioNow - v.startedAt;
    return elapsed < v.sustainSec + v.releaseSec + 0.05;
  });
  // Clear and rebuild outlines this frame. Chord visuals are short-lived enough
  // that full-redraw is cheaper than diffing.
  node.chordLayer.innerHTML = '';
  for (const v of seed._chordVoices) {
    const elapsed = audioNow - v.startedAt;
    if (elapsed < 0) continue;  // not yet started (scheduled in future)
    let opacity;
    if (elapsed < 0.04) {
      // Attack ramp 0 → full over 40ms
      opacity = elapsed / 0.04;
    } else if (elapsed < v.sustainSec) {
      opacity = 1;
    } else {
      const releasePhase = (elapsed - v.sustainSec) / v.releaseSec;
      opacity = Math.max(0, 1 - releasePhase);
    }
    if (opacity <= 0.01) continue;
    // Pitch-correlated scale: each semitone above primary shrinks by 4%.
    // Negative offsets (rare — only if chord has notes below primary) expand.
    const scale = Math.max(0.35, Math.min(1.4, 1 - v.offset * 0.04));
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', blobPath(seed.cx, seed.cy, seed.r * scale, seed.harmonics));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', seed.color);
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-opacity', (opacity * 0.85).toFixed(2));
    node.chordLayer.appendChild(path);
  }
}

// Drive bomb lifecycle: expand → detect pop → echo fade → remove.
const ECHO_MS = 500;
function updateEvents() {
  const tnow = performance.now();
  for (let i = activeEvents.length - 1; i >= 0; i--) {
    const ev = activeEvents[i];

    if (ev.type === 'bomb') {
      if (ev.state === 'expanding') {
        const elapsed = tnow - ev.startTimeMs;
        const r = bombCurrentRadius(ev);
        for (const seed of seeds) {
          if (seed.kind !== 'voice') continue;
          if (Math.hypot(seed.cx - ev.cx, seed.cy - ev.cy) <= r) {
            ev.affectedSeedIds.add(seed.id);
          }
        }
        if (elapsed >= ev.durationMs) {
          ev.state = 'popped';
          ev.popTimeMs = tnow;
          if (ev.filterNode) {
            try { ev.filterNode.disconnect(); } catch (e) {}
          }
          for (const id of ev.affectedSeedIds) {
            const s = seedById(id);
            if (s) {
              s._echoUntil = tnow + ECHO_MS;
              s._echoColor = ev.color;
            }
          }
        }
      } else if (ev.state === 'popped') {
        if (tnow - ev.popTimeMs > ECHO_MS + 50) {
          activeEvents.splice(i, 1);
        }
      }
    } else if (ev.type === 'sweep') {
      if (ev.state === 'active') {
        const elapsed = tnow - ev.startTimeMs;
        const phase = Math.min(1, elapsed / ev.durationMs);
        const dx = ev.x1 - ev.x0;
        const dy = ev.y1 - ev.y0;
        const lenSq = dx*dx + dy*dy || 1;
        // The wavefront is at parameter `phase` along AB.
        // A voice at V is "passed" once its projection onto AB ≤ phase.
        // Projection t = ((V - A) . direction) / |AB|^2
        const def = SWEEP_KINDS[ev.kind];
        for (const seed of seeds) {
          if (seed.kind !== 'voice') continue;
          if (ev.affectedSeedIds.has(seed.id)) continue;
          const t = ((seed.cx - ev.x0) * dx + (seed.cy - ev.y0) * dy) / lenSq;
          // Voices with t < 0 (behind start) get caught at t=0 (immediately)
          // Voices with t > 1 (beyond end) never get caught
          if (t <= phase && t <= 1) {
            ev.affectedSeedIds.add(seed.id);
            if (def.action === 'mute') seed.muted = true;
            else if (def.action === 'unmute') seed.muted = false;
            seed._echoUntil = tnow + ECHO_MS;
            seed._echoColor = ev.color;
            renderSeed(seed);  // update dim state immediately
          }
        }
        if (elapsed >= ev.durationMs) {
          ev.state = 'done';
          ev.doneTimeMs = tnow;
        }
      } else if (ev.state === 'done') {
        if (tnow - ev.doneTimeMs > 400) {
          activeEvents.splice(i, 1);
        }
      }
    }
  }
}

const eventsLayer = document.getElementById('events-layer');
function renderEvents() {
  eventsLayer.innerHTML = '';
  const tnow = performance.now();
  for (const ev of activeEvents) {
    if (ev.type === 'bomb') {
      if (ev.state === 'expanding') {
        const r = bombCurrentRadius(ev);
        const fill = document.createElementNS(SVGNS, 'circle');
        fill.setAttribute('cx', ev.cx);
        fill.setAttribute('cy', ev.cy);
        fill.setAttribute('r', r);
        fill.setAttribute('fill', ev.color);
        fill.setAttribute('fill-opacity', 0.12);
        eventsLayer.appendChild(fill);
        const ring = document.createElementNS(SVGNS, 'circle');
        ring.setAttribute('cx', ev.cx);
        ring.setAttribute('cy', ev.cy);
        ring.setAttribute('r', r);
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke', ev.color);
        ring.setAttribute('stroke-width', 3);
        ring.setAttribute('stroke-opacity', 0.85);
        eventsLayer.appendChild(ring);
      } else if (ev.state === 'popped') {
        const since = tnow - ev.popTimeMs;
        const popPhase = Math.min(1, since / 250);
        if (popPhase < 1) {
          const burst = document.createElementNS(SVGNS, 'circle');
          burst.setAttribute('cx', ev.cx);
          burst.setAttribute('cy', ev.cy);
          burst.setAttribute('r', ev.maxRadius * (1 + popPhase * 0.15));
          burst.setAttribute('fill', 'none');
          burst.setAttribute('stroke', ev.color);
          burst.setAttribute('stroke-width', 4 * (1 - popPhase));
          burst.setAttribute('stroke-opacity', 1 - popPhase);
          eventsLayer.appendChild(burst);
        }
      }
    } else if (ev.type === 'sweep') {
      // Compute geometry: wavefront perpendicular to AB direction
      const dx = ev.x1 - ev.x0;
      const dy = ev.y1 - ev.y0;
      const len = Math.hypot(dx, dy) || 1;
      const dxn = dx / len, dyn = dy / len;
      const perpX = -dyn, perpY = dxn;
      let phase;
      if (ev.state === 'active') {
        phase = Math.min(1, (tnow - ev.startTimeMs) / ev.durationMs);
      } else {
        // 'done' state: keep showing trail briefly, no wavefront
        phase = 1;
      }
      const wfX = ev.x0 + dx * phase;
      const wfY = ev.y0 + dy * phase;
      const EXT = 2000;  // line extends well past canvas edges
      // Filled trail polygon (the swept region behind the wavefront)
      const a0x = ev.x0 + perpX * EXT, a0y = ev.y0 + perpY * EXT;
      const a1x = ev.x0 - perpX * EXT, a1y = ev.y0 - perpY * EXT;
      const w0x = wfX + perpX * EXT,   w0y = wfY + perpY * EXT;
      const w1x = wfX - perpX * EXT,   w1y = wfY - perpY * EXT;
      const trail = document.createElementNS(SVGNS, 'polygon');
      trail.setAttribute('points',
        `${a0x.toFixed(1)},${a0y.toFixed(1)} ${a1x.toFixed(1)},${a1y.toFixed(1)} ${w1x.toFixed(1)},${w1y.toFixed(1)} ${w0x.toFixed(1)},${w0y.toFixed(1)}`);
      trail.setAttribute('fill', ev.color);
      trail.setAttribute('fill-opacity', ev.state === 'active' ? 0.10 : 0.05);
      eventsLayer.appendChild(trail);
      if (ev.state === 'active') {
        // Bright wavefront line
        const line = document.createElementNS(SVGNS, 'line');
        line.setAttribute('x1', w0x.toFixed(1));
        line.setAttribute('y1', w0y.toFixed(1));
        line.setAttribute('x2', w1x.toFixed(1));
        line.setAttribute('y2', w1y.toFixed(1));
        line.setAttribute('stroke', ev.color);
        line.setAttribute('stroke-width', 3);
        line.setAttribute('stroke-opacity', 0.85);
        eventsLayer.appendChild(line);
      }
    }
  }

  // Live preview during sweep drag
  if (sweepDrag) {
    const def = SWEEP_KINDS[sweepDrag.kind];
    const color = def ? def.color : '#ffffff';
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', sweepDrag.x0);
    line.setAttribute('y1', sweepDrag.y0);
    line.setAttribute('x2', sweepDrag.x1);
    line.setAttribute('y2', sweepDrag.y1);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', 2);
    line.setAttribute('stroke-dasharray', '6 4');
    line.setAttribute('stroke-opacity', 0.7);
    eventsLayer.appendChild(line);
    // Mark endpoints
    for (const pt of [[sweepDrag.x0, sweepDrag.y0], [sweepDrag.x1, sweepDrag.y1]]) {
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('cx', pt[0]);
      dot.setAttribute('cy', pt[1]);
      dot.setAttribute('r', 5);
      dot.setAttribute('fill', color);
      dot.setAttribute('fill-opacity', 0.8);
      eventsLayer.appendChild(dot);
    }
  }

  // Echo halos on seeds (shared between bomb and sweep effects)
  for (const seed of seeds) {
    if (seed.kind !== 'voice') continue;
    if (!seed._echoUntil || tnow > seed._echoUntil) continue;
    const remaining = seed._echoUntil - tnow;
    const phase = 1 - (remaining / ECHO_MS);
    const haloR = seed.r * 1.5 + phase * 40;
    const halo = document.createElementNS(SVGNS, 'circle');
    halo.setAttribute('cx', seed.cx);
    halo.setAttribute('cy', seed.cy);
    halo.setAttribute('r', haloR);
    halo.setAttribute('fill', 'none');
    halo.setAttribute('stroke', seed._echoColor || '#ffffff');
    halo.setAttribute('stroke-width', 3 * (1 - phase));
    halo.setAttribute('stroke-opacity', (1 - phase) * 0.9);
    eventsLayer.appendChild(halo);
  }
}

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
  if (BOMB_KINDS[plantMode]) {
    spawnBomb(c.x, c.y, plantMode);
    takeSnapshot('fired ' + plantMode);
    return;
  }
  // Sweep modes start a drag: user defines start and end with one gesture
  if (SWEEP_KINDS[plantMode]) {
    if (!audioCtx) initAudio();
    sweepDrag = {
      x0: c.x, y0: c.y,
      x1: c.x, y1: c.y,
      kind: plantMode,
    };
    return;
  }
  if (plantMode !== 'voice') {
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
  const modKind = plantMode;
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
let sweepDrag = null;
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
  if (!sweepDrag) return;
  const c = canvasCoords(evt);
  sweepDrag.x1 = c.x;
  sweepDrag.y1 = c.y;
}
function endSweepDrag() {
  if (!sweepDrag) return;
  spawnSweep(sweepDrag.x0, sweepDrag.y0, sweepDrag.x1, sweepDrag.y1, sweepDrag.kind);
  takeSnapshot('fired ' + sweepDrag.kind);
  sweepDrag = null;
}

window.addEventListener('pointermove', continueDrag);
window.addEventListener('pointermove', continueSweepDrag);
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointerup', endSweepDrag);

function setPlantMode(kind) {
  const opt = document.querySelector(`.plant-opt[data-kind="${kind}"]`);
  if (!opt) return;
  plantMode = kind;
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
      activeRole = roleKey;
      document.querySelectorAll('.palette-item').forEach(x => x.classList.remove('active'));
      item.classList.add('active');
    });
    el.appendChild(item);
  }
}
buildPalette();

//
// =========================================================================
//  INSPECTOR (same as v3)
// =========================================================================
//
const inspectorEl = document.getElementById('inspector');
const harmonicEditorEl = document.getElementById('harmonic-editor');
const hNumbersEl = document.getElementById('h-numbers');
const patternEditorEl = document.getElementById('pattern-editor');

for (let i = 0; i < NUM_HARMONICS; i++) {
  const bar = document.createElement('div');
  bar.className = 'h-bar';
  bar.dataset.idx = i;
  bar.style.height = '2px';
  harmonicEditorEl.appendChild(bar);
  const num = document.createElement('div');
  num.className = 'h-num';
  num.textContent = i + 2;
  hNumbersEl.appendChild(num);
}

function buildPicker(el, options, onSelect, getCurrent) {
  el.innerHTML = '';
  options.forEach((opt, i) => {
    const o = document.createElement('div');
    o.className = 'picker-opt';
    o.textContent = opt.label;
    o.dataset.idx = i;
    if (i === getCurrent()) o.classList.add('active');
    o.addEventListener('click', () => {
      el.querySelectorAll('.picker-opt').forEach(x => x.classList.remove('active'));
      o.classList.add('active');
      onSelect(opt, i);
    });
    el.appendChild(o);
  });
}

function selectSeed(id) {
  const seed = seedById(id);
  if (!seed) return;
  selectedSeedId = id;
  syncRenderedSeeds();
  document.getElementById('insp-title').textContent = seed.label;
  document.getElementById('insp-sub').textContent =
    seed.kind === 'modifier' ? `modifier · ${seed.modifierKind}` : `voice${seed.role ? ' · ' + seed.role : ''}`;

  // Preset picker + regenerate (voice seeds only)
  const presetRow = document.getElementById('preset-row');
  const regenBtn = document.getElementById('regen-btn');
  if (seed.kind === 'voice') {
    presetRow.style.display = '';
    regenBtn.style.display = '';
    const roleKeys = Object.keys(TIMBRE_ROLES);
    buildPicker(
      document.getElementById('preset-picker'),
      roleKeys.map(k => ({ label: TIMBRE_ROLES[k].label, key: k })),
      (opt) => {
        const gen = TIMBRE_ROLES[opt.key].generate();
        seed.harmonics = gen.harmonics;
        seed.decay = gen.decay;
        seed.attackMs = gen.attackMs;
        seed.synthesisModel = gen.synthesisModel;
        seed.patch = gen.patch;
        seed._cachedPatch = null;
        seed.role = opt.key;
        seed.color = TIMBRE_ROLES[opt.key].color;
        syncRenderedSeeds();
        selectSeed(seed.id);
        takeSnapshot('switched to ' + opt.label);
      },
      () => Math.max(0, roleKeys.indexOf(seed.role || 'melody'))
    );
  } else {
    presetRow.style.display = 'none';
    regenBtn.style.display = 'none';
  }
  const pitchRow = document.getElementById('pitch-row');
  if (seed.kind === 'voice') {
    pitchRow.style.display = '';
    const midi = midiFromFreq(seed.fundamental);
    document.getElementById('pitch-slider').value = midi;
    document.getElementById('pitch-val').textContent = noteName(snapToScale(midi));
  } else {
    pitchRow.style.display = 'none';
  }
  const rhythmRow = document.getElementById('rhythm-row');
  rhythmRow.style.display = '';
  if (seed.kind === 'modifier' && seed.modifierKind === 'weave') {
    document.querySelector('#rhythm-row label').textContent = 'swing';
    buildPicker(
      document.getElementById('rhythm-picker'),
      SWING_OPTIONS,
      (opt) => {
        seed.swing = opt.val;
        // Trigger captured voices to re-phase on the next schedule pass
        for (const v of seeds) {
          if (v.capturedByIds && v.capturedByIds.has(seed.id)) v.nextTrigger = 0;
        }
        takeSnapshot('swing: ' + opt.label);
      },
      () => {
        const sw = seed.swing || 0.5;
        let best = 0, bestDiff = Infinity;
        for (let i = 0; i < SWING_OPTIONS.length; i++) {
          const d = Math.abs(SWING_OPTIONS[i].val - sw);
          if (d < bestDiff) { bestDiff = d; best = i; }
        }
        return best;
      }
    );
  } else if (seed.kind === 'modifier' && seed.modifierKind === 'ripple') {
    document.querySelector('#rhythm-row label').textContent = 'delay';
    buildPicker(
      document.getElementById('rhythm-picker'),
      RIPPLE_DELAY_OPTIONS,
      (opt) => {
        seed.delayMs = opt.ms;
        if (seed.delayNode) seed.delayNode.delayTime.setTargetAtTime(opt.ms / 1000, audioCtx.currentTime, 0.02);
        takeSnapshot('tweaked delay');
      },
      () => nearestOptionIdx(RIPPLE_DELAY_OPTIONS, seed.delayMs)
    );
  } else if (seed.kind === 'modifier' && seed.modifierKind === 'cloud') {
    document.querySelector('#rhythm-row label').textContent = 'size';
    buildPicker(
      document.getElementById('rhythm-picker'),
      CLOUD_SIZE_OPTIONS.map(o => ({ label: o.label, ms: o.sec })),
      (opt) => {
        seed.reverbSec = opt.ms; // opt.ms is actually seconds here
        if (seed.convolver && audioCtx) {
          seed.convolver.buffer = createReverbIR(opt.ms);
        }
        takeSnapshot('tweaked size');
      },
      () => nearestOptionIdx(CLOUD_SIZE_OPTIONS.map(o => ({ms: o.sec})), seed.reverbSec || 2.0)
    );
  } else if (seed.kind === 'modifier' && seed.modifierKind === 'poly') {
    document.querySelector('#rhythm-row label').textContent = 'ratio';
    buildPicker(
      document.getElementById('rhythm-picker'),
      POLY_RATIOS.map(r => ({ label: r.label, val: r.factor })),
      (opt) => {
        seed.polyFactor = opt.val;
        for (const v of seeds) {
          if (v.capturedByIds && v.capturedByIds.has(seed.id)) v.nextTrigger = 0;
        }
        takeSnapshot('ratio: ' + opt.label);
      },
      () => {
        const pf = seed.polyFactor || 2/3;
        let best = 0, bestDiff = Infinity;
        for (let i = 0; i < POLY_RATIOS.length; i++) {
          const d = Math.abs(POLY_RATIOS[i].factor - pf);
          if (d < bestDiff) { bestDiff = d; best = i; }
        }
        return best;
      }
    );
  } else {
    document.querySelector('#rhythm-row label').textContent = 'rhythm';
    buildPicker(
      document.getElementById('rhythm-picker'),
      RHYTHM_OPTIONS,
      (opt) => {
        seed.intervalMs = opt.ms;
        updatePatternLoopInfo(seed);
        takeSnapshot('tweaked rhythm');
      },
      () => nearestOptionIdx(RHYTHM_OPTIONS, seed.intervalMs)
    );
  }
  const lengthRow = document.getElementById('length-row');
  if (seed.kind === 'voice') {
    lengthRow.style.display = '';
    buildPicker(
      document.getElementById('length-picker'),
      LENGTH_OPTIONS,
      (opt) => { seed.decay = opt.ms; takeSnapshot('tweaked length'); },
      () => nearestOptionIdx(LENGTH_OPTIONS, seed.decay)
    );
  } else {
    lengthRow.style.display = 'none';
  }
  const qRow = document.getElementById('quantize-row');
  if (seed.kind === 'voice') {
    qRow.style.display = '';
    document.getElementById('quantize-toggle').classList.toggle('on', seed.quantize);
  } else {
    qRow.style.display = 'none';
  }
  const mRow = document.getElementById('mute-row');
  if (seed.kind === 'voice') {
    mRow.style.display = '';
    document.getElementById('mute-toggle').classList.toggle('on', !!seed.muted);
  } else {
    mRow.style.display = 'none';
  }
  document.getElementById('harmonic-section').style.display = seed.kind === 'voice' ? '' : 'none';
  document.getElementById('pattern-section').style.display = seed.kind === 'voice' ? '' : 'none';
  if (seed.kind === 'voice') {
    const bars = harmonicEditorEl.querySelectorAll('.h-bar');
    bars.forEach((bar, i) => {
      const amp = seed.harmonics[i] || 0;
      bar.style.height = Math.max(2, amp * 80) + 'px';
      bar.style.background = amp > 0.05 ? seed.color : '';
    });
    renderPatternEditor(seed);
    updatePatternLoopInfo(seed);
  }
  const sphereRow = document.getElementById('sphere-row');
  if (seed.kind === 'modifier') {
    sphereRow.style.display = '';
    buildPicker(
      document.getElementById('sphere-picker'),
      SPHERE_OPTIONS,
      (opt) => {
        seed.sphereR = opt.r;
        reevaluateAllCaptures();
        syncRenderedSeeds();
        takeSnapshot('tweaked reach');
      },
      () => nearestOptionIdx(SPHERE_OPTIONS.map(o => ({ms: o.r})), seed.sphereR)
    );
  } else {
    sphereRow.style.display = 'none';
  }
  const capInfo = document.getElementById('captured-info');
  if (seed.kind === 'voice' && seed.capturedByIds && seed.capturedByIds.size > 0) {
    const ms = [...seed.capturedByIds].map(id => seedById(id)).filter(Boolean);
    capInfo.style.display = '';
    capInfo.textContent = `held by ${ms.map(m => m.label).join(' + ')}`;
  } else if (seed.kind === 'modifier' && seed.capturedSeedIds.size > 0) {
    capInfo.style.display = '';
    capInfo.textContent = `holding ${seed.capturedSeedIds.size} voice${seed.capturedSeedIds.size === 1 ? '' : 's'}`;
  } else {
    capInfo.style.display = 'none';
  }
  inspectorEl.classList.add('open');
}

function updatePatternLoopInfo(seed) {
  if (seed.kind !== 'voice') return;
  const chordCount = seed.pattern.filter(s => s.extras && s.extras.length > 0).length;
  const stepLabel = seed.pattern.length + ' step' + (seed.pattern.length > 1 ? 's' : '');
  document.getElementById('pattern-len-info').textContent =
    chordCount > 0 ? `${stepLabel} · ${chordCount} chord${chordCount > 1 ? 's' : ''}` : stepLabel;
  const interval = effectiveIntervalForVoice(seed);
  document.getElementById('pattern-loop-info').textContent =
    ((seed.pattern.length * interval) / 1000).toFixed(1) + 's loop';
}

function renderPatternEditor(seed) {
  patternEditorEl.innerHTML = '';
  const W = 276, H = 100, pad = 14;
  const usableH = H - pad * 2;
  const stepW = (W - pad * 2) / Math.max(1, seed.pattern.length);
  const offsetRange = 14;
  const offsetToY = o => pad + usableH / 2 - (o / offsetRange) * (usableH / 2 - 4);
  const refLine = document.createElementNS(SVGNS, 'line');
  refLine.setAttribute('x1', pad); refLine.setAttribute('x2', W - pad);
  refLine.setAttribute('y1', pad + usableH / 2); refLine.setAttribute('y2', pad + usableH / 2);
  refLine.setAttribute('stroke', 'rgba(255,255,255,0.06)');
  refLine.setAttribute('stroke-width', '1');
  refLine.setAttribute('stroke-dasharray', '2 4');
  patternEditorEl.appendChild(refLine);
  // Connect primary notes with a contour line
  if (seed.pattern.length > 1) {
    let d = '';
    seed.pattern.forEach((step, i) => {
      const x = pad + stepW * (i + 0.5);
      const y = offsetToY(step.offset);
      d += (i === 0 ? 'M' : 'L') + ` ${x.toFixed(1)} ${y.toFixed(1)} `;
    });
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', seed.color);
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('opacity', '0.4');
    patternEditorEl.appendChild(path);
  }
  // Each step: render extras first (smaller, behind), then primary on top
  seed.pattern.forEach((step, i) => {
    const x = pad + stepW * (i + 0.5);
    const isRest = step.velocity < 0.1;
    const hasChord = step.extras && step.extras.length > 0;
    // Chord extras as smaller dots
    if (hasChord && !isRest) {
      for (const ex of step.extras) {
        const exY = offsetToY(ex.offset);
        const exDot = document.createElementNS(SVGNS, 'circle');
        exDot.setAttribute('cx', x); exDot.setAttribute('cy', exY);
        exDot.setAttribute('r', 3.5);
        exDot.setAttribute('fill', seed.color);
        exDot.setAttribute('fill-opacity', 0.65);
        exDot.setAttribute('class', 'pattern-extra');
        patternEditorEl.appendChild(exDot);
      }
      // Faint vertical bar tying chord notes together visually
      const offsets = [step.offset, ...step.extras.map(e => e.offset)];
      const minO = Math.min(...offsets), maxO = Math.max(...offsets);
      const bar = document.createElementNS(SVGNS, 'line');
      bar.setAttribute('x1', x); bar.setAttribute('x2', x);
      bar.setAttribute('y1', offsetToY(minO));
      bar.setAttribute('y2', offsetToY(maxO));
      bar.setAttribute('stroke', seed.color);
      bar.setAttribute('stroke-width', '1');
      bar.setAttribute('stroke-opacity', 0.35);
      patternEditorEl.appendChild(bar);
    }
    // Primary dot (slightly larger when chord present, to read as "the root")
    const y = offsetToY(step.offset);
    const dot = document.createElementNS(SVGNS, 'circle');
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    dot.setAttribute('r', hasChord ? 7 : 6);
    dot.setAttribute('fill', isRest ? 'rgba(80, 70, 100, 0.6)' : seed.color);
    dot.setAttribute('class', 'pattern-dot');
    dot.dataset.idx = i;
    dot.style.cursor = 'ns-resize';
    if (i === seed.currentStep) {
      dot.setAttribute('stroke', '#fff8c8');
      dot.setAttribute('stroke-width', '2');
    }
    patternEditorEl.appendChild(dot);
  });
}

function highlightCurrentStep(seed) {
  const dots = patternEditorEl.querySelectorAll('.pattern-dot');
  dots.forEach((d, i) => {
    if (i === seed.currentStep) {
      d.setAttribute('stroke', '#fff8c8'); d.setAttribute('stroke-width', '2');
    } else {
      d.setAttribute('stroke', 'none');
    }
  });
}

let patternDrag = null;
patternEditorEl.addEventListener('pointerdown', (e) => {
  if (e.target.tagName !== 'circle') return;
  const seed = seedById(selectedSeedId);
  if (!seed) return;
  const idx = parseInt(e.target.dataset.idx);
  patternDrag = { seed, idx, rect: patternEditorEl.getBoundingClientRect() };
  updatePatternFromMouse(e);
  e.preventDefault();
});
window.addEventListener('pointermove', (e) => { if (patternDrag) updatePatternFromMouse(e); });
window.addEventListener('pointerup', () => {
  if (patternDrag) { takeSnapshot('tweaked melody'); patternDrag = null; }
});
function updatePatternFromMouse(e) {
  const rect = patternDrag.rect;
  const pad = 14, usableH = 100 - pad * 2;
  const yInSvg = (e.clientY - rect.top) / rect.height * 100;
  const offsetRange = 14;
  let offset = (pad + usableH / 2 - yInSvg) * offsetRange / (usableH / 2 - 4);
  offset = Math.max(-14, Math.min(14, Math.round(offset)));
  const step = patternDrag.seed.pattern[patternDrag.idx];
  const delta = offset - step.offset;
  step.offset = offset;
  // Chord: move all extras by the same delta so the voicing is preserved
  if (step.extras && step.extras.length > 0 && delta !== 0) {
    for (const ex of step.extras) {
      ex.offset = Math.max(-14, Math.min(14, ex.offset + delta));
    }
  }
  renderPatternEditor(patternDrag.seed);
}

document.getElementById('insp-close').addEventListener('click', () => {
  inspectorEl.classList.remove('open');
  selectedSeedId = null;
  syncRenderedSeeds();
});
document.getElementById('pitch-slider').addEventListener('input', (e) => {
  const s = seedById(selectedSeedId);
  if (!s) return;
  const midi = parseInt(e.target.value);
  s.fundamental = freqFromMidi(midi);
  s.r = radiusForFundamental(s.fundamental);
  document.getElementById('pitch-val').textContent = noteName(snapToScale(midi));
  renderSeed(s);
});
document.getElementById('pitch-slider').addEventListener('change', () => takeSnapshot('tweaked pitch'));
document.getElementById('quantize-toggle').addEventListener('click', () => {
  const s = seedById(selectedSeedId);
  if (!s) return;
  s.quantize = !s.quantize;
  document.getElementById('quantize-toggle').classList.toggle('on', s.quantize);
  s.nextTrigger = 0;
  takeSnapshot(s.quantize ? 'quantize on' : 'quantize off');
});

document.getElementById('mute-toggle').addEventListener('click', () => {
  const s = seedById(selectedSeedId);
  if (!s) return;
  s.muted = !s.muted;
  document.getElementById('mute-toggle').classList.toggle('on', !!s.muted);
  renderSeed(s);
  takeSnapshot(s.muted ? 'muted' : 'unmuted');
});

document.getElementById('regen-btn').addEventListener('click', () => {
  const s = seedById(selectedSeedId);
  if (!s || s.kind !== 'voice') return;
  const roleKey = s.role || 'melody';
  const role = TIMBRE_ROLES[roleKey];
  if (!role) return;
  const gen = role.generate();
  s.harmonics = gen.harmonics;
  s.decay = gen.decay;
  s.attackMs = gen.attackMs;
  s.synthesisModel = gen.synthesisModel;
  s.patch = gen.patch;
  s._cachedPatch = null;
  syncRenderedSeeds();
  selectSeed(s.id);
  takeSnapshot('rerolled ' + s.label);
});
document.getElementById('delete-btn').addEventListener('click', () => {
  if (!selectedSeedId) return;
  const s = seedById(selectedSeedId);
  if (!s) return;
  const label = s.label;
  removeSeed(selectedSeedId);
  syncRenderedSeeds();
  takeSnapshot('removed ' + label);
});

let barDrag = null;
harmonicEditorEl.addEventListener('pointerdown', (e) => {
  const bar = e.target.closest('.h-bar');
  if (!bar) return;
  const seed = seedById(selectedSeedId);
  if (!seed) return;
  const idx = parseInt(bar.dataset.idx);
  barDrag = { bar, idx, seed, rect: harmonicEditorEl.getBoundingClientRect() };
  updateBarFromMouse(e);
  e.preventDefault();
});
window.addEventListener('pointermove', (e) => { if (barDrag) updateBarFromMouse(e); });
window.addEventListener('pointerup', () => {
  if (barDrag) { takeSnapshot('tweaked harmonics'); barDrag = null; }
});
function updateBarFromMouse(e) {
  const rect = barDrag.rect;
  const relY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
  const amp = 1 - (relY / rect.height);
  barDrag.seed.harmonics[barDrag.idx] = Math.max(0, Math.min(1, amp));
  barDrag.bar.style.height = Math.max(2, amp * rect.height) + 'px';
  barDrag.bar.style.background = amp > 0.05 ? barDrag.seed.color : '';
  renderSeed(barDrag.seed);
}

//
// =========================================================================
//  GUARDRAILS TOGGLE
// =========================================================================
//
document.getElementById('guard-toggle').addEventListener('click', () => {
  guardrails = !guardrails;
  document.getElementById('guard-pill').classList.toggle('on', guardrails);
  // Re-paint piano in-scale highlights
  for (const k of PIANO_KEYS) {
    if (k.kind === 'white') k.el.classList.toggle('in-scale', guardrails && inScale(k.midi));
  }
});

//
// =========================================================================
//  SNAPSHOTS
// =========================================================================
//
const snapshots = [];
const MAX_SNAPSHOTS = 16;
let snapAutoTimer = null;
function takeSnapshot(label, immediate = false) {
  clearTimeout(snapAutoTimer);
  const capture = () => {
    const snap = {
      label, ts: new Date(),
      seeds: seeds.map(s => ({
        id: s.id, kind: s.kind, modifierKind: s.modifierKind,
        cx: s.cx, cy: s.cy, r: s.r, color: s.color,
        fundamental: s.fundamental, decay: s.decay, intervalMs: s.intervalMs,
        harmonics: s.harmonics.slice(), gain: s.gain, label: s.label,
        pattern: s.pattern.map(p => ({
          offset: p.offset, velocity: p.velocity,
          duration: p.duration,
          extras: p.extras ? p.extras.map(e => ({ offset: e.offset, velocity: e.velocity, duration: e.duration })) : undefined,
        })),
        quantize: s.quantize,
        capturedByIds: [...(s.capturedByIds || [])],
        capturedSeedIds: [...s.capturedSeedIds],
        sphereR: s.sphereR,
        delayMs: s.delayMs,
        reverbSec: s.reverbSec,
        role: s.role,
        swing: s.swing,
        synthesisModel: s.synthesisModel,
        attackMs: s.attackMs,
        polyFactor: s.polyFactor,
        patch: s.patch ? JSON.parse(JSON.stringify(s.patch)) : null,
      })),
      nextSeedId,
    };
    snapshots.push(snap);
    if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
    renderTimeline();
  };
  if (immediate) capture();
  else snapAutoTimer = setTimeout(capture, 200);
}
document.getElementById('snap-btn').addEventListener('click', () => takeSnapshot('manual'));

function clearCanvas() {
  takeSnapshot('before clear', true);
  // Release any held live notes so their oscillators don't sustain forever.
  for (const m of [...activeLiveNotes.keys()]) liveNoteOff(m);
  // Disconnect modifier-chain inputs so dangling delay/reverb graphs go quiet.
  // (The rest of each chain has no input source and will be GC'd.)
  for (const s of seeds) {
    if (s.delayInput)  { try { s.delayInput.disconnect();  } catch (e) {} }
    if (s.reverbInput) { try { s.reverbInput.disconnect(); } catch (e) {} }
  }
  seeds.length = 0;
  activeEvents.length = 0;
  selectedSeedId = null;
  inspectorEl.classList.remove('open');
  syncRenderedSeeds();
  takeSnapshot('cleared');
}

const clearBtn = document.getElementById('clear-btn');
let clearConfirmTimer = null;
clearBtn.addEventListener('click', () => {
  if (clearBtn.dataset.armed === '1') {
    clearTimeout(clearConfirmTimer);
    clearBtn.dataset.armed = '0';
    clearBtn.textContent = 'clear';
    clearBtn.classList.remove('danger');
    clearCanvas();
    return;
  }
  clearBtn.dataset.armed = '1';
  clearBtn.textContent = 'confirm?';
  clearBtn.classList.add('danger');
  clearConfirmTimer = setTimeout(() => {
    clearBtn.dataset.armed = '0';
    clearBtn.textContent = 'clear';
    clearBtn.classList.remove('danger');
  }, 2000);
});

function revertToSnapshot(i) {
  const snap = snapshots[i];
  if (!snap) return;
  seeds.length = 0;
  for (const s of snap.seeds) {
    const newSeed = {
      ...s,
      harmonics: s.harmonics.slice(),
      pattern: s.pattern.map(p => ({
          offset: p.offset, velocity: p.velocity,
          duration: p.duration,
          extras: p.extras ? p.extras.map(e => ({ offset: e.offset, velocity: e.velocity, duration: e.duration })) : undefined,
        })),
      capturedByIds: new Set(s.capturedByIds || []),
      capturedSeedIds: new Set(s.capturedSeedIds || []),
      patternIdx: 0, currentStep: -1, nextTrigger: 0, lastPulseAt: 0,
      delayInput: null, delayNode: null,
    };
    seeds.push(newSeed);
    setupModifierChain(newSeed);
  }
  nextSeedId = snap.nextSeedId;
  if (!seedById(selectedSeedId)) {
    selectedSeedId = null;
    inspectorEl.classList.remove('open');
  }
  syncRenderedSeeds();
  if (selectedSeedId) selectSeed(selectedSeedId);
  renderTimeline(i);
}

function renderTimeline(currentIdx = -1) {
  const strip = document.getElementById('tl-strip');
  strip.innerHTML = '';
  snapshots.forEach((snap, i) => {
    const el = document.createElement('div');
    el.className = 'snap';
    if (i === currentIdx) el.classList.add('current');
    el.title = snap.label + ' · ' + snap.ts.toLocaleTimeString();
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 1400 800');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    for (const s of snap.seeds) {
      if (s.kind === 'modifier' && s.sphereR) {
        const c = document.createElementNS(SVGNS, 'circle');
        c.setAttribute('cx', s.cx); c.setAttribute('cy', s.cy);
        c.setAttribute('r', s.sphereR); c.setAttribute('fill', s.color);
        c.setAttribute('opacity', '0.06');
        svg.appendChild(c);
      }
    }
    for (const s of snap.seeds) {
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('cx', s.cx); c.setAttribute('cy', s.cy);
      c.setAttribute('r', s.r); c.setAttribute('fill', s.color);
      c.setAttribute('opacity', '0.7');
      svg.appendChild(c);
    }
    el.appendChild(svg);
    const lbl = document.createElement('div');
    lbl.className = 'snap-label';
    lbl.textContent = snap.label;
    el.appendChild(lbl);
    el.addEventListener('click', () => revertToSnapshot(i));
    strip.appendChild(el);
  });
  strip.scrollLeft = strip.scrollWidth;
}

//
// =========================================================================
//  PLAY / VOL
// =========================================================================
//
const playBtn = document.getElementById('play-btn');
playBtn.addEventListener('click', async () => {
  const ctx = await ensureAudio();
  if (!ctx) return;
  if (isPlaying) {
    isPlaying = false;
    try { await ctx.suspend(); } catch (e) {}
    playBtn.textContent = '▶ start';
    playBtn.classList.add('primary');
    showAudioStatus(ctx.state + ' · stopped');
  } else {
    isPlaying = true;
    if (ctx.state === 'suspended') {
      const result = await withTimeout(ctx.resume(), 1500, 'resume');
      if (result.timeout || result.error) {
        showAudioStatus('cannot resume · state=' + ctx.state, 'error');
        isPlaying = false;
        return;
      }
    }
    playBtn.textContent = '■ stop';
    playBtn.classList.remove('primary');
    playbackStartTime = ctx.currentTime + 0.04;
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

