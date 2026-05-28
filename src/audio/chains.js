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

// Drive = saturation / soft-clip aura. One per-aura WaveShaper that
// captured voices send through. Send gain is set per-pair at note
// time from proximity intensity. Dry signal continues straight to
// master so the drive is *additive*, not destructive — close to the
// aura sounds warm, deep inside sounds proper-dirty.
function makeDriveCurve(amount) {
  const N = 2048;
  const arr = new Float32Array(N);
  const k = 1 + amount * 4;   // amount 0..2 → k 1..9
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    arr[i] = Math.tanh(x * k);
  }
  return arr;
}
export function setupDriveChain(driveSeed) {
  if (driveSeed.driveInput) return;
  const input = audioCtx.createGain();
  const shaper = audioCtx.createWaveShaper();
  shaper.curve = makeDriveCurve(driveSeed.driveAmount != null ? driveSeed.driveAmount : 1.6);
  shaper.oversample = '2x';
  const wet = audioCtx.createGain();
  wet.gain.value = 0.55;
  input.connect(shaper); shaper.connect(wet); wet.connect(masterGain);
  driveSeed.driveInput = input;
  driveSeed.driveShaper = shaper;
}

export function setupModifierChain(seed) {
  if (seed.kind !== 'modifier' || !audioCtx) return;
  if (seed.modifierKind === 'ripple') setupRippleChain(seed);
  if (seed.modifierKind === 'cloud') setupCloudChain(seed);
  if (seed.modifierKind === 'drive') setupDriveChain(seed);
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
