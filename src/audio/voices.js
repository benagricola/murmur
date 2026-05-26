// Voices and the patch player.
//
// Each voice is a small builder that returns:
//   { output: AudioNode, stop(when), detune(cents, when) | null }
//
// `output` carries the voice's raw signal (no envelope, no routing). The
// player (playPatch) wraps voices in a shared envelope and routes the
// summed signal to the caller via the `routeFn` callback. `stop`
// schedules teardown. `detune` is null for noise/drum voices that
// don't track pitch bend.
//
// A "patch" is `{ layers: [{voice, params, gain}], envelope, category }`.
// Single-layer patches are the common case; multi-layer patches mix
// timbres in parallel (e.g. saw bass + FM bell + breath of noise).

import { audioCtx, setOscWave, createNoiseBuffer } from './context.js';

export const VOICES = {};

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
export function playPatch(patch, when, freq, gain, sustainMs, routeFn) {
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
      // Each step is independently best-effort. The old single
      // try/catch would skip the voice.stop() calls if the envelope
      // manipulation threw — leaving oscillators running forever. We
      // ALWAYS schedule the stops, even if envelope shaping fails.
      const g = env.gain;
      try {
        if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(whenRelease);
        else { g.cancelScheduledValues(whenRelease); g.setValueAtTime(g.value, whenRelease); }
      } catch (e) {}
      try { g.linearRampToValueAtTime(0, whenRelease + r); } catch (e) {}
      const stopAt = whenRelease + r + 0.05;
      for (const v of voices) {
        try { v.stop(stopAt); } catch (e) {}
      }
    },
    detune: (cents, t) => { for (const d of detunes) d(cents, t); },
    output: env,
  };
}
