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

// === Drum voices ===
// One-shot voices whose internal envelopes are baked in — the patch
// player skips its shared attack/release ramp for these (see
// `patch.category === 'drum'`).
//
// Design notes: the original versions were single-layer (one osc OR
// one noise burst). Real drum sounds are layered transient + body +
// tail with light saturation, which is what gives them the "thump"
// that moves a room. These rebuilds keep the same call signature so
// the rest of the engine doesn't change.

// Shared soft-clip curve for drum bus saturation. tanh-like shape
// gives gentle harmonic distortion at peak without clamping the
// transient hard. Generated once at module load and reused.
const SOFT_CLIP_CURVE = (() => {
  const N = 1024;
  const arr = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;   // -1..1
    arr[i] = Math.tanh(x * 1.6);        // mild saturation
  }
  return arr;
})();

function softClip(audioCtx) {
  const ws = audioCtx.createWaveShaper();
  ws.curve = SOFT_CLIP_CURVE;
  ws.oversample = '2x';
  return ws;
}

// === KICK ===
// Three stacked layers:
//   1. Body — pitched sine sweep (e.g. 85→40 Hz over 70ms exponential).
//      This is what carries the THUMP.
//   2. Click — short highpassed noise burst at the very start (4ms
//      decay). Defines the transient so the kick reads on small
//      speakers.
//   3. Sub — fixed-pitch sine at ~38 Hz that rises quickly and decays
//      slower than the body, giving the speakers a chance to actually
//      reproduce the low-end weight.
// Routed through a soft-clip waveshaper for harmonic warmth.
VOICES.kick = function(audioCtx, freq, when, params) {
  const out = audioCtx.createGain();
  const clip = softClip(audioCtx);
  const preClip = audioCtx.createGain();
  preClip.gain.value = 1.0;
  preClip.connect(clip);
  clip.connect(out);

  // Body — pitched sine sweep
  const bodyOsc = audioCtx.createOscillator();
  const bodyEnv = audioCtx.createGain();
  bodyOsc.type = 'sine';
  const bodyStart = Math.max(55, freq * 1.5);
  const bodyEnd = Math.max(32, freq * 0.55);
  bodyOsc.frequency.setValueAtTime(bodyStart, when);
  bodyOsc.frequency.exponentialRampToValueAtTime(bodyEnd, when + 0.07);
  bodyOsc.connect(bodyEnv); bodyEnv.connect(preClip);
  bodyEnv.gain.setValueAtTime(0, when);
  bodyEnv.gain.linearRampToValueAtTime(1.9, when + 0.003);     // hard transient hit
  bodyEnv.gain.exponentialRampToValueAtTime(0.0008, when + 0.30);
  bodyOsc.start(when);

  // Click — short HPF'd noise pop
  const click = audioCtx.createBufferSource();
  click.buffer = createNoiseBuffer(0.05);
  const clickHpf = audioCtx.createBiquadFilter();
  clickHpf.type = 'highpass'; clickHpf.frequency.value = 1500; clickHpf.Q.value = 0.7;
  const clickEnv = audioCtx.createGain();
  click.connect(clickHpf); clickHpf.connect(clickEnv); clickEnv.connect(preClip);
  clickEnv.gain.setValueAtTime(0, when);
  clickEnv.gain.linearRampToValueAtTime(0.55, when + 0.001);
  clickEnv.gain.exponentialRampToValueAtTime(0.0008, when + 0.012);
  click.start(when);

  // Sub — slower fixed-pitch low sine. This is what your subwoofer feels.
  const subOsc = audioCtx.createOscillator();
  const subEnv = audioCtx.createGain();
  subOsc.type = 'sine';
  subOsc.frequency.value = Math.max(28, freq * 0.55);
  subOsc.connect(subEnv); subEnv.connect(preClip);
  subEnv.gain.setValueAtTime(0, when);
  subEnv.gain.linearRampToValueAtTime(0.85, when + 0.008);
  subEnv.gain.exponentialRampToValueAtTime(0.0008, when + 0.40);
  subOsc.start(when);

  return {
    output: out,
    stop: (whenStop) => {
      const t = Math.max(whenStop, when + 0.45);
      try { bodyOsc.stop(t); } catch (e) {}
      try { subOsc.stop(t); } catch (e) {}
      try { click.stop(t); } catch (e) {}
    },
    detune: null,
  };
};

// === SNARE ===
// Three layers:
//   1. Tonal ping — brief triangle around 200 Hz, ~30ms (the "thwap")
//   2. Body — bandpassed noise centred ~400-600 Hz (the wood/shell)
//   3. Crack — highpassed noise above 4kHz (the snare wires)
// Light saturation through soft clip for cohesion.
VOICES.snare = function(audioCtx, freq, when, params) {
  const out = audioCtx.createGain();
  const clip = softClip(audioCtx);
  const preClip = audioCtx.createGain();
  preClip.connect(clip); clip.connect(out);

  // Tonal ping
  const ping = audioCtx.createOscillator();
  const pingEnv = audioCtx.createGain();
  ping.type = 'triangle';
  const pingFreq = Math.max(160, freq * 0.9);
  ping.frequency.setValueAtTime(pingFreq * 1.6, when);
  ping.frequency.exponentialRampToValueAtTime(pingFreq, when + 0.012);
  ping.connect(pingEnv); pingEnv.connect(preClip);
  pingEnv.gain.setValueAtTime(0, when);
  pingEnv.gain.linearRampToValueAtTime(0.65, when + 0.001);
  pingEnv.gain.exponentialRampToValueAtTime(0.0008, when + 0.045);
  ping.start(when);

  // Body — mid noise
  const body = audioCtx.createBufferSource();
  body.buffer = createNoiseBuffer(0.20);
  const bodyBpf = audioCtx.createBiquadFilter();
  bodyBpf.type = 'bandpass';
  bodyBpf.frequency.value = 480;
  bodyBpf.Q.value = 0.9;
  const bodyEnv = audioCtx.createGain();
  body.connect(bodyBpf); bodyBpf.connect(bodyEnv); bodyEnv.connect(preClip);
  bodyEnv.gain.setValueAtTime(0, when);
  bodyEnv.gain.linearRampToValueAtTime(0.55, when + 0.002);
  bodyEnv.gain.exponentialRampToValueAtTime(0.0008, when + 0.080);
  body.start(when);

  // Crack — high noise
  const crack = audioCtx.createBufferSource();
  crack.buffer = createNoiseBuffer(0.20);
  const crackHpf = audioCtx.createBiquadFilter();
  crackHpf.type = 'highpass';
  crackHpf.frequency.value = 3800;
  crackHpf.Q.value = 0.7;
  const crackEnv = audioCtx.createGain();
  crack.connect(crackHpf); crackHpf.connect(crackEnv); crackEnv.connect(preClip);
  crackEnv.gain.setValueAtTime(0, when);
  crackEnv.gain.linearRampToValueAtTime(0.85, when + 0.001);
  crackEnv.gain.exponentialRampToValueAtTime(0.0008, when + 0.140);
  crack.start(when);

  return {
    output: out,
    stop: (whenStop) => {
      const t = Math.max(whenStop, when + 0.20);
      try { ping.stop(t); } catch (e) {}
      try { body.stop(t); } catch (e) {}
      try { crack.stop(t); } catch (e) {}
    },
    detune: null,
  };
};

// === HIHAT ===
// 808-style metallic shimmer built from 6 square-wave oscillators at
// non-harmonic frequencies (the classic 808 hat ratios), mixed and
// passed through two filters and a sharp envelope. Plus a noise layer
// for the airy "tss" component.
//
// params.open: true → longer decay (open hat ~250ms), false → snappy
// closed hat ~50ms. Generators in timbres.js can roll either.
const HAT_RATIOS = [2.0, 3.0, 4.16, 5.43, 6.79, 8.21];   // 808-style
VOICES.hihat = function(audioCtx, freq, when, params) {
  const open = params.open === true;
  const decayMs = open ? 250 : 50;
  const out = audioCtx.createGain();

  // Metallic component — sum of 6 squares at non-harmonic ratios.
  const base = 320;
  const summer = audioCtx.createGain();
  summer.gain.value = 1 / HAT_RATIOS.length;
  const oscs = [];
  for (const r of HAT_RATIOS) {
    const o = audioCtx.createOscillator();
    o.type = 'square';
    o.frequency.value = base * r;
    o.connect(summer);
    o.start(when);
    oscs.push(o);
  }
  // Two filters in series: bandpass to isolate the ringy mid-highs,
  // then highpass to thin it out.
  const bpf = audioCtx.createBiquadFilter();
  bpf.type = 'bandpass'; bpf.frequency.value = 7000; bpf.Q.value = 1.5;
  const hpf = audioCtx.createBiquadFilter();
  hpf.type = 'highpass'; hpf.frequency.value = 6000;
  const metalEnv = audioCtx.createGain();
  summer.connect(bpf); bpf.connect(hpf); hpf.connect(metalEnv); metalEnv.connect(out);
  metalEnv.gain.setValueAtTime(0, when);
  metalEnv.gain.linearRampToValueAtTime(0.55, when + 0.001);
  metalEnv.gain.exponentialRampToValueAtTime(0.0008, when + decayMs / 1000);

  // Airy "tss" — highpassed noise for the breath component.
  const noise = audioCtx.createBufferSource();
  noise.buffer = createNoiseBuffer(0.30);
  const noiseHpf = audioCtx.createBiquadFilter();
  noiseHpf.type = 'highpass'; noiseHpf.frequency.value = 7500;
  const noiseEnv = audioCtx.createGain();
  noise.connect(noiseHpf); noiseHpf.connect(noiseEnv); noiseEnv.connect(out);
  noiseEnv.gain.setValueAtTime(0, when);
  noiseEnv.gain.linearRampToValueAtTime(0.35, when + 0.001);
  noiseEnv.gain.exponentialRampToValueAtTime(0.0008, when + (decayMs * 0.6) / 1000);
  noise.start(when);

  return {
    output: out,
    stop: (whenStop) => {
      const t = Math.max(whenStop, when + (decayMs + 50) / 1000);
      for (const o of oscs) { try { o.stop(t); } catch (e) {} }
      try { noise.stop(t); } catch (e) {}
    },
    detune: null,
  };
};

// playPatch — single dispatcher for all note-making in murmur. Builds
// every voice in `patch.layers` in parallel, sums them through a shared
// envelope, hands the result to the routing function. Returns a handle
// with `release(when)` for the open-ended live case and `detune(cents)`
// for pitch-bend updates.
// Set window.murmurAudioDebug = true in DevTools to log every
// playPatch call (which mode it ran, sustain, layer count) — useful
// when audio is sticking or behaving unexpectedly.
function audioDebugEnabled() {
  return typeof window !== 'undefined' && window.murmurAudioDebug;
}

export function playPatch(patch, when, freq, gain, sustainMs, routeFn) {
  if (!audioCtx) return null;
  if (!patch || !patch.layers || patch.layers.length === 0) {
    patch = { layers: [{ voice: 'additive', gain: 1, params: {} }] };
  }
  const debug = audioDebugEnabled();
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
    if (debug) console.log('[playPatch] one-shot', { layers: voices.length, sustainMs, stopAt: stopAt - when });
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
    if (debug) console.log('[playPatch] scheduled', { layers: voices.length, sustainMs, attack: a*1000, release: r*1000, totalMs: (a+sustainSec+r)*1000 });
    return {
      release: () => {},
      detune: (cents, t) => { for (const d of detunes) d(cents, t); },
      output: env,
    };
  }
  if (debug) console.log('[playPatch] LIVE mode (no sustainMs) — caller must invoke release()', { layers: voices.length });

  // Live mode: attack then sustain indefinitely; caller invokes release()
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(gain, when + a);

  // OscillatorNode.stop() is documented as "if called previously,
  // has no effect" — so the FIRST call to stop wins. Guard with a
  // flag so the safety-net timer doesn't pre-empt a legitimate
  // release call.
  let stopFired = false;
  const tryStop = (at) => {
    if (stopFired) return;
    stopFired = true;
    for (const v of voices) {
      try { v.stop(at); } catch (e) {}
    }
  };

  // Safety net: even if the caller forgets to call release (or there's
  // a bug upstream), force-stop every voice after 30 seconds. No
  // legitimate live-keyboard note should be held that long, and the
  // alternative is oscillators that linger forever.
  const SAFETY_STOP_SECONDS = 30;
  const safetyTimer = setTimeout(() => {
    if (!stopFired) {
      console.warn('[playPatch] safety-net stop firing after 30s — release() was never called');
      tryStop(audioCtx.currentTime + 0.05);
    }
  }, SAFETY_STOP_SECONDS * 1000);

  return {
    release: (whenRelease) => {
      clearTimeout(safetyTimer);
      const g = env.gain;
      try {
        if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(whenRelease);
        else { g.cancelScheduledValues(whenRelease); g.setValueAtTime(g.value, whenRelease); }
      } catch (e) {}
      try { g.linearRampToValueAtTime(0, whenRelease + r); } catch (e) {}
      tryStop(whenRelease + r + 0.05);
    },
    detune: (cents, t) => { for (const d of detunes) d(cents, t); },
    output: env,
  };
}
