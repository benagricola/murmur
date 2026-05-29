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

// === VOICE REGISTRY ===
//
// Each voice is a `{ params, build }` pair:
//   - `params`: declarative schema describing every tunable parameter
//     this voice accepts, with type / range / default. The future
//     spatial-design controller introspects this to render appropriate
//     controls automatically; role generators in timbres.js consult it
//     to constrain random rolls. Schema types:
//       'enum'     — values: [...], default: 'x'
//       'linear'   — min, max, default (linear scale)
//       'log'      — min, max, default (logarithmic — for frequencies)
//   - `build(audioCtx, freq, when, params)`: constructs the audio graph
//     and returns a handle:
//       { output, stop, detune, liveParams? }
//     `output` is the voice's raw signal (no envelope).
//     `stop(when)` schedules teardown.
//     `detune(cents, t)` ramps pitch bend (null if the voice ignores it).
//     `liveParams` (optional) is a flat map of AudioParam refs the
//     caller can modulate via setTargetAtTime DURING the note. Voices
//     that have no live-modulatable surface (drums) return undefined.
//
// Build functions can be called as `VOICES[name].build(...)`. The
// existing `VOICES[name]` indirection in playPatch reads the .build
// member.

export const VOICES = {};

VOICES.additive = {
  params: {
    harmonics: { type: 'array', size: 12, min: 0, max: 1, default: [0.4, 0.2, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0] },
    filterMult: { type: 'log', min: 2, max: 32, default: 16 },
    Q: { type: 'linear', min: 0.1, max: 8, default: 0.7 },
  },
  build: function(audioCtx, freq, when, params) {
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
      liveParams: { cutoff: filter.frequency, Q: filter.Q },
    };
  },
};

VOICES.subtractive = {
  params: {
    wave: { type: 'enum', values: ['sawtooth', 'square', 'triangle', 'sine'], default: 'sawtooth' },
    filterStartHz: { type: 'log', min: 200, max: 8000, default: 2000 },
    filterEndHz: { type: 'log', min: 80, max: 4000, default: 600 },
    filterDecayMs: { type: 'log', min: 50, max: 2000, default: 350 },
    Q: { type: 'linear', min: 0.5, max: 18, default: 6 },
  },
  build: function(audioCtx, freq, when, params) {
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
      // cutoff and Q are live-modulatable. Note: cutoff has scheduled
      // automation from setValueAtTime/exponentialRampToValueAtTime
      // for the filter sweep; live modulation should use
      // cancelScheduledValues + setTargetAtTime to override cleanly.
      liveParams: { cutoff: filter.frequency, Q: filter.Q },
    };
  },
};

VOICES.fm = {
  params: {
    ratio: { type: 'log', min: 0.25, max: 8, default: 2 },
    modIndexStart: { type: 'linear', min: 0.1, max: 12, default: 2 },
    modIndexEnd: { type: 'linear', min: 0.05, max: 4, default: 0.4 },
    modDecayMs: { type: 'log', min: 50, max: 2000, default: 400 },
  },
  build: function(audioCtx, freq, when, params) {
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
      // modIndex (modGain.gain) is the most musically expressive live
      // param — it controls FM brightness / harmonic content. modFreq
      // (mod.frequency) controls the ratio; ramping it produces a
      // sweep through ratios. Both exposed for spatial control.
      liveParams: { modIndex: modGain.gain, modFreq: mod.frequency },
    };
  },
};

VOICES.supersaw = {
  params: {
    voices: { type: 'integer', min: 1, max: 7, default: 3 },
    detuneCents: { type: 'linear', min: 0, max: 35, default: 7 },
    filterMult: { type: 'log', min: 2, max: 32, default: 10 },
    Q: { type: 'linear', min: 0.1, max: 8, default: 0.5 },
  },
  build: function(audioCtx, freq, when, params) {
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
      // Filter live-modulatable. Detune-cents would require ramping
      // every osc; expose as a function rather than an AudioParam.
      liveParams: {
        cutoff: filter.frequency,
        Q: filter.Q,
        setDetune: (cents, t) => {
          for (const { osc, baseDetune } of oscs) {
            try { osc.detune.setTargetAtTime(baseDetune * (cents / 7), t, 0.005); } catch (e) {}
          }
        },
      },
    };
  },
};

VOICES.noise = {
  params: {
    bandHz: { type: 'log', min: 80, max: 12000, default: 2000 },
    Q: { type: 'linear', min: 0.3, max: 8, default: 1.5 },
    filterType: { type: 'enum', values: ['lowpass', 'bandpass', 'highpass'], default: 'bandpass' },
  },
  build: function(audioCtx, freq, when, params) {
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
      liveParams: { cutoff: filter.frequency, Q: filter.Q },
    };
  },
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
VOICES.kick = {
  params: {
    // Drum voices' params currently don't drive externally — values
    // are mostly hard-coded inside the builder for the punchy stack.
    // Documented here so future spatial-drum work has the surface to
    // hook into. Each region of the future kick design canvas would
    // map to one of these.
    bodyStartHz:    { type: 'log',    min: 40,  max: 200, default: 85 },
    bodyEndHz:      { type: 'log',    min: 25,  max: 100, default: 40 },
    bodyDecayMs:    { type: 'log',    min: 30,  max: 500, default: 70 },
    clickAmount:    { type: 'linear', min: 0,   max: 1.5, default: 0.55 },
    subAmount:      { type: 'linear', min: 0,   max: 1.5, default: 0.85 },
    subHz:          { type: 'log',    min: 20,  max: 60,  default: 38 },
    subDecayMs:     { type: 'log',    min: 100, max: 800, default: 400 },
  },
  build: function(audioCtx, freq, when, params) {
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
  },
};

// === SNARE ===
// Three layers:
//   1. Tonal ping — brief triangle around 200 Hz, ~30ms (the "thwap")
//   2. Body — bandpassed noise centred ~400-600 Hz (the wood/shell)
//   3. Crack — highpassed noise above 4kHz (the snare wires)
// Light saturation through soft clip for cohesion.
VOICES.snare = {
  params: {
    pingHz:       { type: 'log',    min: 100, max: 400, default: 200 },
    pingAmount:   { type: 'linear', min: 0,   max: 1.5, default: 0.65 },
    bodyCutHz:    { type: 'log',    min: 200, max: 1500, default: 480 },
    bodyDecayMs:  { type: 'log',    min: 20,  max: 300, default: 80 },
    crackHpHz:    { type: 'log',    min: 1500, max: 8000, default: 3800 },
    crackDecayMs: { type: 'log',    min: 30,  max: 400, default: 140 },
  },
  build: function(audioCtx, freq, when, params) {
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
  },
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
VOICES.hihat = {
  params: {
    open:        { type: 'boolean', default: false },
    metalBaseHz: { type: 'log',     min: 200, max: 500, default: 320 },
    bpfHz:       { type: 'log',     min: 4000, max: 12000, default: 7000 },
    bpfQ:        { type: 'linear',  min: 0.5,  max: 4,    default: 1.5 },
    hpfHz:       { type: 'log',     min: 4000, max: 10000, default: 6000 },
    noiseHpfHz:  { type: 'log',     min: 4000, max: 12000, default: 7500 },
  },
  build: function(audioCtx, freq, when, params) {
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
  },
};

// === CLAP ===
// The defining feature of a clap is the BURST TRAIN — three or four
// short noise spikes a few ms apart (many hands / room reflections)
// followed by a longer diffuse tail. A single noise burst sounds like
// a weak snare; the stutter is what reads as "clap". One noise source
// through a bandpass (~1.2 kHz, the hand-smack formant), with the gain
// envelope drawing the spikes + tail.
VOICES.clap = {
  params: {
    bpfHz:      { type: 'log',    min: 600,  max: 2500, default: 1200 },
    bpfQ:       { type: 'linear', min: 0.5,  max: 4,    default: 1.3 },
    spreadMs:   { type: 'linear', min: 5,    max: 16,   default: 9 },
    tailMs:     { type: 'log',    min: 60,   max: 300,  default: 130 },
  },
  build: function(audioCtx, freq, when, params) {
    const out = audioCtx.createGain();
    const clip = softClip(audioCtx);
    const noise = audioCtx.createBufferSource();
    noise.buffer = createNoiseBuffer(0.4);
    const bpf = audioCtx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.value = params.bpfHz || 1200;
    bpf.Q.value = params.bpfQ != null ? params.bpfQ : 1.3;
    const env = audioCtx.createGain();
    noise.connect(bpf); bpf.connect(env); env.connect(clip); clip.connect(out);

    // Three tight spikes, then a fuller spike that decays into the tail.
    const gap = (params.spreadMs || 9) / 1000;
    const tail = (params.tailMs || 130) / 1000;
    env.gain.setValueAtTime(0.0001, when);
    for (let i = 0; i < 3; i++) {
      const t0 = when + i * gap;
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(0.75, t0 + 0.0008);
      env.gain.exponentialRampToValueAtTime(0.04, t0 + gap * 0.85);
    }
    const tStart = when + 3 * gap;
    env.gain.setValueAtTime(0.04, tStart);
    env.gain.linearRampToValueAtTime(0.95, tStart + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0008, tStart + tail);
    noise.start(when);
    return {
      output: out,
      stop: (whenStop) => {
        const t = Math.max(whenStop, tStart + tail + 0.05);
        try { noise.stop(t); } catch (e) {}
      },
      detune: null,
    };
  },
};

// === TOM ===
// A pitched membrane — and deliberately NOT a tuned kick. The kick is a
// big octave+ pitch drop into a sub thump with no tonal ring; a tom is
// the opposite: a SMALL pitch bend (a head bends a semitone or two, not
// an octave) over a clear, sustained pitch whose colour comes from
// INHARMONIC membrane modes (a circular drumhead resonates at ~1.59x,
// 2.14x, 2.30x the fundamental — not clean musical intervals). That
// woody, slightly-detuned ring is what separates a tom from "a higher
// kick". No sub layer, gentle attack. `freq` sets the tuning.
const TOM_MODES = [1.0, 1.59, 2.14, 2.30];   // circular-membrane mode ratios
const TOM_MODE_GAINS = [1.0, 0.30, 0.16, 0.09];
const TOM_MODE_DECAY = [1.0, 0.55, 0.40, 0.30];   // higher modes ring shorter
VOICES.tom = {
  params: {
    glideRatio:  { type: 'linear', min: 1.0, max: 1.4, default: 1.18 },
    decayMs:     { type: 'log',    min: 120, max: 700, default: 320 },
    clickAmount: { type: 'linear', min: 0,   max: 0.6, default: 0.16 },
  },
  build: function(audioCtx, freq, when, params) {
    const out = audioCtx.createGain();
    const clip = softClip(audioCtx);
    const preClip = audioCtx.createGain();
    preClip.connect(clip); clip.connect(out);
    const decay = (params.decayMs || 320) / 1000;
    const glide = params.glideRatio != null ? params.glideRatio : 1.18;

    // Stack the membrane modes. Each is a sine at an inharmonic ratio,
    // sharing the same gentle downward glide, with progressively
    // shorter decays so the sound darkens as it rings — exactly how a
    // real tom's overtones die away faster than its fundamental.
    const oscs = [];
    for (let i = 0; i < TOM_MODES.length; i++) {
      const osc = audioCtx.createOscillator();
      const env = audioCtx.createGain();
      osc.type = 'sine';
      const ratio = TOM_MODES[i];
      osc.frequency.setValueAtTime(freq * ratio * glide, when);
      osc.frequency.exponentialRampToValueAtTime(freq * ratio, when + 0.06);
      osc.connect(env); env.connect(preClip);
      env.gain.setValueAtTime(0, when);
      env.gain.linearRampToValueAtTime(1.3 * TOM_MODE_GAINS[i], when + 0.003);
      env.gain.exponentialRampToValueAtTime(0.0008, when + decay * TOM_MODE_DECAY[i]);
      osc.start(when);
      oscs.push(osc);
    }

    // Soft stick contact — quieter and lower than a kick's click so the
    // attack reads as a mallet on a head, not a beater on a port.
    const click = audioCtx.createBufferSource();
    click.buffer = createNoiseBuffer(0.05);
    const clickBpf = audioCtx.createBiquadFilter();
    clickBpf.type = 'bandpass'; clickBpf.frequency.value = 1200; clickBpf.Q.value = 0.6;
    const clickEnv = audioCtx.createGain();
    click.connect(clickBpf); clickBpf.connect(clickEnv); clickEnv.connect(preClip);
    const clickAmt = params.clickAmount != null ? params.clickAmount : 0.16;
    clickEnv.gain.setValueAtTime(0, when);
    clickEnv.gain.linearRampToValueAtTime(clickAmt, when + 0.001);
    clickEnv.gain.exponentialRampToValueAtTime(0.0008, when + 0.018);
    click.start(when);

    return {
      output: out,
      stop: (whenStop) => {
        const t = Math.max(whenStop, when + decay + 0.05);
        for (const o of oscs) { try { o.stop(t); } catch (e) {} }
        try { click.stop(t); } catch (e) {}
      },
      detune: null,
    };
  },
};

// === RIM (rim click / rimshot) ===
// Very short, bright, woody. Two resonant high pulses (~1.7 kHz) give
// the characteristic "tok", plus a brief bandpassed noise tick for the
// stick contact. Almost no tail — it's a transient, not a tone.
VOICES.rim = {
  params: {
    toneHz:    { type: 'log',    min: 800,  max: 2500, default: 1700 },
    decayMs:   { type: 'log',    min: 15,   max: 80,   default: 32 },
    noiseAmt:  { type: 'linear', min: 0,    max: 1,    default: 0.5 },
  },
  build: function(audioCtx, freq, when, params) {
    const out = audioCtx.createGain();
    const tone = params.toneHz || 1700;
    const decay = (params.decayMs || 32) / 1000;

    // Woody pulse — a triangle blip with fast decay.
    const osc = audioCtx.createOscillator();
    const oscEnv = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = tone;
    osc.connect(oscEnv); oscEnv.connect(out);
    oscEnv.gain.setValueAtTime(0, when);
    oscEnv.gain.linearRampToValueAtTime(0.7, when + 0.0006);
    oscEnv.gain.exponentialRampToValueAtTime(0.0008, when + decay);
    osc.start(when);

    // Stick tick — short bandpassed noise around the tone.
    const noise = audioCtx.createBufferSource();
    noise.buffer = createNoiseBuffer(0.05);
    const bpf = audioCtx.createBiquadFilter();
    bpf.type = 'bandpass'; bpf.frequency.value = tone * 1.2; bpf.Q.value = 1.2;
    const nEnv = audioCtx.createGain();
    noise.connect(bpf); bpf.connect(nEnv); nEnv.connect(out);
    const nAmt = params.noiseAmt != null ? params.noiseAmt : 0.5;
    nEnv.gain.setValueAtTime(0, when);
    nEnv.gain.linearRampToValueAtTime(nAmt, when + 0.0005);
    nEnv.gain.exponentialRampToValueAtTime(0.0008, when + decay * 0.7);
    noise.start(when);

    return {
      output: out,
      stop: (whenStop) => {
        const t = Math.max(whenStop, when + decay + 0.04);
        try { osc.stop(t); } catch (e) {}
        try { noise.stop(t); } catch (e) {}
      },
      detune: null,
    };
  },
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

// === Note registry + safety sweep ===
//
// Every playPatch call registers an entry here with an expected
// stop time. A 200ms timer sweeps for entries whose expected stop
// is now in the past plus a grace period, and force-disconnects the
// output node to silence them. This catches the entire "stuck note"
// class:
//   - live notes whose release() was never called (sustain stuck on)
//   - voices whose internal v.stop() failed silently
//   - long release envelopes that overstay their welcome
//
// The grace period (1.5 s past expected stop) lets legit release
// tails finish naturally; after that we delete the entry. Most
// entries get cleaned up this way — that's routine, not a problem.
// We only LOG when an entry is MUCH later than expected (genuine
// stuck-note territory) because the routine cleanup was producing
// dozens of warnings per second on busy patterns and drowned out
// real issues.
//
// Live mode entries use a 30s expected stop initially; release()
// updates that to the actual ramp end time.
const activeNotes = new Set();
const SAFETY_GRACE_SEC = 1.5;
const SAFETY_LOG_THRESHOLD_SEC = 8;   // only warn for genuinely stuck notes
const SAFETY_SWEEP_MS = 200;
const LIVE_NOTE_MAX_LIFETIME_SEC = 30;

function registerNote(entry) {
  activeNotes.add(entry);
  return entry;
}

// Force-stop every active note whose `tag` matches the given value.
// Used by removeSeed to silence a deleted seed's in-flight audio
// instantly instead of letting it ring out its release tail.
export function forceStopByTag(tag) {
  if (tag === undefined || tag === null) return 0;
  let n = 0;
  for (const entry of activeNotes) {
    if (entry.tag !== tag) continue;
    try { if (entry.output) entry.output.disconnect(); } catch (e) {}
    try {
      if (entry.voices) {
        const now = audioCtx ? audioCtx.currentTime : 0;
        for (const v of entry.voices) { try { v.stop(now); } catch (e) {} }
      }
    } catch (e) {}
    activeNotes.delete(entry);
    n++;
  }
  return n;
}

if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    for (const entry of activeNotes) {
      const overdue = now - entry.expectedStopTime;
      if (overdue <= SAFETY_GRACE_SEC) continue;
      // Only log if the note is REALLY stuck — past the warn threshold
      // means release() likely never fired or a voice didn't stop.
      // Routine cleanup of finished one-shots/scheduled notes happens
      // silently below.
      if (overdue >= SAFETY_LOG_THRESHOLD_SEC) {
        console.warn(`[safety] force-stopping ${entry.source} note overdue by ${overdue.toFixed(2)}s`);
      }
      try {
        if (entry.output) entry.output.disconnect();
      } catch (e) {}
      try {
        if (entry.voices) for (const v of entry.voices) { try { v.stop(now); } catch (e) {} }
      } catch (e) {}
      activeNotes.delete(entry);
    }
  }, SAFETY_SWEEP_MS);
}

// DevTools handle for inspecting / clearing the registry.
if (typeof window !== 'undefined') {
  window.murmurActiveNotes = () => {
    if (!audioCtx) return [];
    const now = audioCtx.currentTime;
    return [...activeNotes].map(e => ({
      source: e.source,
      ageSec: +(now - e.startedAt).toFixed(2),
      expectedStopInSec: +(e.expectedStopTime - now).toFixed(2),
    }));
  };
  window.murmurForceClearNotes = () => {
    const n = activeNotes.size;
    for (const entry of activeNotes) {
      try { if (entry.output) entry.output.disconnect(); } catch (e) {}
      try {
        if (entry.voices) for (const v of entry.voices) { try { v.stop(audioCtx.currentTime); } catch (e) {} }
      } catch (e) {}
    }
    activeNotes.clear();
    console.log(`[safety] force-cleared ${n} active notes`);
  };
}

// `tag` (optional) is an opaque marker the caller can attach to each
// note. Used by removeSeed to find and force-stop a deleted seed's
// in-flight audio — tag = seed.id.
export function playPatch(patch, when, freq, gain, sustainMs, routeFn, tag) {
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
    const entry = VOICES[layer.voice];
    if (!entry || !entry.build) continue;
    const params = layer.params || {};
    const v = entry.build(audioCtx, freq, when, params);
    const lg = audioCtx.createGain();
    lg.gain.value = layer.gain != null ? layer.gain : 1.0;
    v.output.connect(lg);
    lg.connect(summer);
    // Annotate the voice handle with the layer config so spatial
    // controllers can find params by layer name. `layerGain` is the
    // gain node between voice.output and summer — modulating it
    // changes that layer's contribution to the mix (region distance
    // ↔ mix weight in the spatial design model).
    v.layerVoice = layer.voice;
    v.layerGain = lg.gain;
    v.layerParams = params;
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
    const entry = registerNote({
      source: 'one-shot',
      startedAt: when,
      expectedStopTime: stopAt + 0.5,    // drum tail
      output: env,
      voices,
      tag,
    });
    return {
      release: () => { activeNotes.delete(entry); },
      detune: (cents, t) => { for (const d of detunes) d(cents, t); },
      output: env,
      voices,         // expose for spatial-design live modulation
      env: env.gain,  // patch-level envelope param
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
    const entry = registerNote({
      source: 'scheduled',
      startedAt: when,
      expectedStopTime: when + a + sustainSec + r + 0.05,
      output: env,
      voices,
      tag,
    });
    return {
      release: () => { activeNotes.delete(entry); },
      detune: (cents, t) => { for (const d of detunes) d(cents, t); },
      output: env,
      voices,         // expose for spatial-design live modulation
      env: env.gain,  // patch-level envelope param
    };
  }
  if (debug) console.log('[playPatch] LIVE mode (no sustainMs) — caller must invoke release()', { layers: voices.length });

  // Live mode: attack then sustain indefinitely; caller invokes release().
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(gain, when + a);

  // OscillatorNode.stop() is "first call wins" per spec — guard so
  // the registry sweep can't double-stop a legitimately released voice.
  let stopFired = false;
  const tryStop = (at) => {
    if (stopFired) return;
    stopFired = true;
    for (const v of voices) {
      try { v.stop(at); } catch (e) {}
    }
  };

  // Live notes register with a generous initial expectedStopTime
  // (now + LIVE_NOTE_MAX_LIFETIME_SEC). The release() call below
  // updates that to the actual ramp-end time. The shared sweep timer
  // catches anything still alive past expectedStopTime + grace —
  // replaces the per-call setTimeout safety net.
  const liveEntry = registerNote({
    source: 'live',
    startedAt: when,
    expectedStopTime: audioCtx.currentTime + LIVE_NOTE_MAX_LIFETIME_SEC,
    output: env,
    voices,
    tag,
  });

  return {
    release: (whenRelease) => {
      const g = env.gain;
      try {
        if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(whenRelease);
        else { g.cancelScheduledValues(whenRelease); g.setValueAtTime(g.value, whenRelease); }
      } catch (e) {}
      try { g.linearRampToValueAtTime(0, whenRelease + r); } catch (e) {}
      tryStop(whenRelease + r + 0.05);
      // Shorten the safety deadline so the sweep cleans this entry up
      // as soon as the release tail completes, not 30s later.
      liveEntry.expectedStopTime = whenRelease + r + 0.05;
    },
    detune: (cents, t) => { for (const d of detunes) d(cents, t); },
    output: env,
    voices,         // expose for spatial-design live modulation
    env: env.gain,  // patch-level envelope param
  };
}
