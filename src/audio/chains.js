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

export function setupModifierChain(seed) {
  if (seed.kind !== 'modifier' || !audioCtx) return;
  if (seed.modifierKind === 'ripple') setupRippleChain(seed);
  if (seed.modifierKind === 'cloud') setupCloudChain(seed);
}

// Attach chains for any modifier seeds planted before audio existed.
// Registered against the context-created hook so this runs once when
// the AudioContext first comes online.
onContextCreated(() => {
  for (const s of seeds) setupModifierChain(s);
});
