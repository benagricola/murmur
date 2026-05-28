// Modifier audio chains. Each modifier kind (ripple/cloud/poly/weave)
// gets one persistent audio graph attached to its seed; voices captured
// by the modifier route their output into the chain's input. poly and
// weave don't have audio graphs — they only affect scheduling.

import { audioCtx, masterGain, onContextCreated } from './context.js';
import { seeds } from '../state.js';

export function setupRippleChain(rippleSeed) {
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

// Cloud = reverb modifier. Uses ConvolverNode with a procedurally
// generated impulse response (exponentially decaying noise).
export function createReverbIR(durationSec) {
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

export function setupCloudChain(cloudSeed) {
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

// Drive = real overdrive aura. The previous implementation was a
// symmetric tanh saturator which mostly added odd harmonics and read
// as "slightly louder, slightly thicker" — exactly the volume-boost
// feel the user complained about.
//
// This rewrite chases a guitar-pedal style overdrive:
//   * Heavy pre-gain so signal slams into the clipper instead of
//     gently kissing it.
//   * Asymmetric soft-clip → even AND odd harmonics. Even harmonics
//     are the "tube grunge" character that single-coil/germanium
//     pedals produce.
//   * Hard-clip stage for upper drive amounts so it can go full
//     fuzz, not just warm overdrive.
//   * Output-normalised so the curve doesn't read as louder, only
//     dirtier — the user can blend with the wet mix to taste.
//   * Tone-shaping filters in the chain: highpass to kill mud,
//     peaking mid-boost for presence, lowpass to tame fizz.
//
// driveAmount maps 0..3 from the inspector. 0 = clean,
// ~1 = warm tube break-up, ~2 = full overdrive, 3 = fuzz.
export function makeDriveCurve(amount) {
  const N = 4096;
  const arr = new Float32Array(N);
  const drive = Math.max(0, amount);
  // Pre-gain ramps hard so even small drive amounts push into
  // saturation. amount 1 → 8x pre-gain, 2 → 21x, 3 → 40x.
  const preGain = 1 + drive * drive * 4 + drive * 4;
  // Asymmetry bias — small DC offset before the clipper produces
  // even harmonics. Stronger at higher drive amounts.
  const bias = 0.12 + drive * 0.08;
  // Hard-clip threshold collapses as drive grows so the fuzz stage
  // kicks in. At drive=3 the signal is essentially square-wave.
  const hardClip = Math.max(0.45, 1.05 - drive * 0.20);
  // Pre-compute the peak so we can normalise to ±1. Without this,
  // higher drive amounts just produce a louder signal and the user
  // experiences "volume knob, not character knob".
  let peak = 0;
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    // Stage 1: asymmetric soft-clip via biased tanh. Adds even
    // harmonics — the "warm" component.
    let y = Math.tanh((x + bias) * preGain) - Math.tanh(bias * preGain);
    // Stage 2: hard-clip at a threshold that drops with drive.
    // This is what turns warmth into grunge into fuzz.
    if (y >  hardClip) y =  hardClip + (y - hardClip) * 0.05;
    if (y < -hardClip) y = -hardClip + (y + hardClip) * 0.05;
    raw[i] = y;
    if (Math.abs(y) > peak) peak = Math.abs(y);
  }
  const norm = peak > 0 ? 0.92 / peak : 1;
  for (let i = 0; i < N; i++) arr[i] = raw[i] * norm;
  return arr;
}

export function setupDriveChain(driveSeed) {
  if (driveSeed.driveInput) return;
  const amount = driveSeed.driveAmount != null ? driveSeed.driveAmount : 1.6;
  const input = audioCtx.createGain();
  // Pre-shape highpass — kill subsonic content so the clipper doesn't
  // waste headroom turning DC into farts. ~80Hz feels right for
  // tonal voices; the dry signal still gets the lows.
  const preHP = audioCtx.createBiquadFilter();
  preHP.type = 'highpass';
  preHP.frequency.value = 80;
  preHP.Q.value = 0.5;
  const shaper = audioCtx.createWaveShaper();
  shaper.curve = makeDriveCurve(amount);
  shaper.oversample = '4x';   // 4x — aliasing on hard-clip is brutal at 2x
  // Post-shape: a peaking EQ around 2.4kHz for presence/bite (the
  // "ehh" formant that makes overdrive sound aggressive), then a
  // lowpass to roll off the brittle fizz harmonics. This is the
  // single biggest difference between "loud" and "punchy".
  const presence = audioCtx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 2400;
  presence.Q.value = 0.9;
  presence.gain.value = 5;
  const postLP = audioCtx.createBiquadFilter();
  postLP.type = 'lowpass';
  postLP.frequency.value = 6500;
  postLP.Q.value = 0.7;
  const wet = audioCtx.createGain();
  wet.gain.value = 0.65;
  input.connect(preHP);
  preHP.connect(shaper);
  shaper.connect(presence);
  presence.connect(postLP);
  postLP.connect(wet);
  wet.connect(masterGain);
  driveSeed.driveInput = input;
  driveSeed.driveShaper = shaper;
  driveSeed.drivePresence = presence;
  driveSeed.driveLP = postLP;
}

// Squash = compressor aura. Heavy-handed dynamics control with a
// makeup gain so transients SLAM. The dry signal still routes to
// master so the compressor is additive at the edge of the aura and
// dominates near the centre (proximity send gain controls the
// blend). Uses DynamicsCompressor with aggressive settings — fast
// attack, fast-ish release, low threshold, hard ratio.
export function setupSquashChain(squashSeed) {
  if (squashSeed.squashInput) return;
  const amount = squashSeed.squashAmount != null ? squashSeed.squashAmount : 1.5;
  const input = audioCtx.createGain();
  // Pre-gain pushes signal into compression range so even softer
  // voices get pumped. amount 1 ≈ moderate, 2 ≈ slammed.
  input.gain.value = 1 + amount * 0.5;
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = -30 - amount * 4;   // -30..-42 dB
  comp.knee.value = 8;
  comp.ratio.value = 6 + amount * 4;          // 6..18:1
  comp.attack.value = 0.003;                  // 3ms — catches transients
  comp.release.value = 0.12;
  // Makeup gain — compressors lose perceived loudness; this puts
  // some of it back so the user hears "punch" not "quiet".
  const makeup = audioCtx.createGain();
  makeup.gain.value = 1 + amount * 0.8;
  const wet = audioCtx.createGain();
  wet.gain.value = 0.7;
  input.connect(comp);
  comp.connect(makeup);
  makeup.connect(wet);
  wet.connect(masterGain);
  squashSeed.squashInput = input;
  squashSeed.squashComp = comp;
  squashSeed.squashMakeup = makeup;
}

// Wobble = LFO modulation aura. A single LFO modulates both an
// amplitude tremolo AND a lowpass filter cutoff so the effect reads
// as movement, not just volume waver. Filter sweeps add a synth-
// y vocal "wow-wow" character.
export function setupWobbleChain(wobbleSeed) {
  if (wobbleSeed.wobbleInput) return;
  const rate = wobbleSeed.wobbleRate != null ? wobbleSeed.wobbleRate : 4.5;
  const depth = wobbleSeed.wobbleDepth != null ? wobbleSeed.wobbleDepth : 0.6;
  const input = audioCtx.createGain();
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1200;
  filter.Q.value = 4;
  // Tremolo gain — LFO swings this between (1-depth) and 1.
  const trem = audioCtx.createGain();
  trem.gain.value = 1 - depth * 0.5;
  // Shared LFO. Sine wave at `rate` Hz, ±1. Drives:
  //   - trem.gain via a depth/2 amp scaler (centred at 1-depth/2)
  //   - filter.frequency via a 1200Hz peak swing (sweep)
  const lfo = audioCtx.createOscillator();
  lfo.frequency.value = rate;
  const tremScale = audioCtx.createGain();
  tremScale.gain.value = depth * 0.5;
  lfo.connect(tremScale);
  tremScale.connect(trem.gain);
  const filterScale = audioCtx.createGain();
  filterScale.gain.value = 1500 * depth;     // up to ±1500Hz sweep
  lfo.connect(filterScale);
  filterScale.connect(filter.frequency);
  lfo.start();
  const wet = audioCtx.createGain();
  wet.gain.value = 0.7;
  input.connect(filter);
  filter.connect(trem);
  trem.connect(wet);
  wet.connect(masterGain);
  wobbleSeed.wobbleInput = input;
  wobbleSeed.wobbleFilter = filter;
  wobbleSeed.wobbleTrem = trem;
  wobbleSeed.wobbleLFO = lfo;
  wobbleSeed.wobbleTremScale = tremScale;
  wobbleSeed.wobbleFilterScale = filterScale;
}

// Crush = bitcrusher aura. WaveShaper-based bit-depth reduction
// followed by a downsampling-style smoothing — gives a lo-fi,
// digital-grit character. We avoid AudioWorklet to keep the engine
// single-file; the curve quantises sample values into 2^bits steps.
export function setupCrushChain(crushSeed) {
  if (crushSeed.crushInput) return;
  const bits = crushSeed.crushBits != null ? crushSeed.crushBits : 5;
  const rate = crushSeed.crushRate != null ? crushSeed.crushRate : 0.35;
  const input = audioCtx.createGain();
  const shaper = audioCtx.createWaveShaper();
  shaper.curve = makeBitCrushCurve(bits);
  shaper.oversample = 'none';   // crushed signal should NOT be smoothed
  // Lowpass-style smoothing simulates sample-rate reduction. Lower
  // `rate` → more aliasing artefacts come through.
  const sampleHold = audioCtx.createBiquadFilter();
  sampleHold.type = 'lowpass';
  sampleHold.frequency.value = 800 + rate * 6000;   // 800Hz..6.8kHz
  sampleHold.Q.value = 0.7;
  const wet = audioCtx.createGain();
  wet.gain.value = 0.7;
  input.connect(shaper);
  shaper.connect(sampleHold);
  sampleHold.connect(wet);
  wet.connect(masterGain);
  crushSeed.crushInput = input;
  crushSeed.crushShaper = shaper;
  crushSeed.crushProcessor = sampleHold;
}

export function makeBitCrushCurve(bits) {
  const N = 4096;
  const arr = new Float32Array(N);
  const levels = Math.pow(2, Math.max(1, Math.min(16, bits)));
  const step = 2 / levels;
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    arr[i] = Math.round(x / step) * step;
  }
  return arr;
}

export function setupModifierChain(seed) {
  if (seed.kind !== 'modifier' || !audioCtx) return;
  if (seed.modifierKind === 'ripple') setupRippleChain(seed);
  if (seed.modifierKind === 'cloud') setupCloudChain(seed);
  if (seed.modifierKind === 'drive') setupDriveChain(seed);
  if (seed.modifierKind === 'squash') setupSquashChain(seed);
  if (seed.modifierKind === 'wobble') setupWobbleChain(seed);
  if (seed.modifierKind === 'crush') setupCrushChain(seed);
  // gain / mute don't need their own chain — they modulate
  // seed.auraGain on every captured voice each tick (see scheduler
  // updateAuraModulation).
}

// Attach chains for any modifier seeds planted before audio existed.
// Registered against the context-created hook so this runs once when
// the AudioContext first comes online.
onContextCreated(() => {
  for (const s of seeds) setupModifierChain(s);
});
