// Drum kit slot registry — 8 stable drum-pad assignments.
//
// The pad-layout v2 work (#44) maps MiniLab bank-A pads 1-8 directly
// into this array by index: tapping pad N fires DRUM_KIT[N].patch.
// Each slot has a stable patch by default; rerollSlot(idx) replaces
// one with a fresh variant from its builder. Patches are full
// drum-category patch objects that playPatch understands directly.
//
// Slot names are conventions for the user-facing labels and the
// future spatial-drum design canvases (#36): each slot will
// eventually have its own canvas for sculpting the sound.
//
// Today's defaults reuse existing drum voices (kick / snare / hihat)
// from src/audio/voices.js with slot-specific parameter tweaks.
// Tom-low, tom-high, clap, and rim are stubs built from the same
// voices with tuned params — sounding fine but not authentic. Future
// work can add real clap, tom, and rim voices.

import { BAR_MS } from '../tempo.js';

const SLOT_DEFINITIONS = [
  {
    name: 'kick',
    build: () => ({
      layers: [{ voice: 'kick', gain: 1, params: {} }],
      envelope: { attackMs: 2, releaseMs: 200 },
      category: 'drum',
      designSlot: 0,
    }),
  },
  {
    name: 'snare',
    build: () => ({
      layers: [{ voice: 'snare', gain: 1, params: {} }],
      envelope: { attackMs: 2, releaseMs: 150 },
      category: 'drum',
      designSlot: 1,
    }),
  },
  {
    name: 'hat-closed',
    build: () => ({
      layers: [{ voice: 'hihat', gain: 1, params: { open: false } }],
      envelope: { attackMs: 2, releaseMs: 60 },
      category: 'drum',
      designSlot: 2,
    }),
  },
  {
    name: 'hat-open',
    build: () => ({
      layers: [{ voice: 'hihat', gain: 1, params: { open: true } }],
      envelope: { attackMs: 2, releaseMs: 280 },
      category: 'drum',
      designSlot: 3,
    }),
  },
  {
    name: 'clap',
    // Stub: a snare voice with the body de-emphasised and a crack
    // bump. Sounds clap-ish; needs a real clap voice eventually.
    build: () => ({
      layers: [{ voice: 'snare', gain: 0.9, params: {} }],
      envelope: { attackMs: 4, releaseMs: 180 },
      category: 'drum',
      designSlot: 4,
    }),
  },
  {
    name: 'tom-low',
    // Stub: a kick voice tuned higher. Real tom would have a less
    // pronounced click and longer ringing body.
    build: () => ({
      layers: [{ voice: 'kick', gain: 0.85, params: {} }],
      envelope: { attackMs: 2, releaseMs: 350 },
      category: 'drum',
      designSlot: 5,
    }),
  },
  {
    name: 'tom-high',
    build: () => ({
      layers: [{ voice: 'kick', gain: 0.85, params: {} }],
      envelope: { attackMs: 2, releaseMs: 250 },
      category: 'drum',
      designSlot: 6,
    }),
  },
  {
    name: 'rim',
    // Stub: a short closed-hat for the click character.
    build: () => ({
      layers: [{ voice: 'hihat', gain: 0.6, params: { open: false } }],
      envelope: { attackMs: 1, releaseMs: 40 },
      category: 'drum',
      designSlot: 7,
    }),
  },
];

export const DRUM_KIT = SLOT_DEFINITIONS.map((def, slot) => ({
  slot,
  name: def.name,
  patch: def.build(),
  _build: def.build,
}));

// Per-pad fundamental frequency used for live-trigger pitch. Tuned
// so each slot sits in its musical role's natural range.
export const DRUM_KIT_FUNDAMENTAL_HZ = [
  55,    // kick — sub-bass region
  220,   // snare
  1100,  // closed hat
  1100,  // open hat
  250,   // clap
  140,   // tom-low
  220,   // tom-high
  3200,  // rim — high click
];

// Per-slot pad LED colour. Mostly mapped to drum-role conventions
// (kick = red, snare = amber, hats = yellow-ish, perc colour-coded).
export const DRUM_KIT_COLOURS = [
  '#e85a6f',  // kick
  '#ffa94d',  // snare
  '#ffd166',  // hat-closed
  '#ffe4a0',  // hat-open
  '#f06aae',  // clap
  '#9474e8',  // tom-low
  '#b394e8',  // tom-high
  '#5fd2e8',  // rim
];

// Replace a slot's patch with a fresh build. Returns the new patch
// so callers can read the latest.
export function rerollSlot(slotIdx) {
  if (slotIdx < 0 || slotIdx >= DRUM_KIT.length) return null;
  DRUM_KIT[slotIdx].patch = DRUM_KIT[slotIdx]._build();
  return DRUM_KIT[slotIdx].patch;
}

// DevTools: read current kit assignment / re-roll a slot.
if (typeof window !== 'undefined') {
  window.murmurDrumKit = () => DRUM_KIT.map(s => ({ slot: s.slot, name: s.name }));
  window.murmurRerollDrum = rerollSlot;
}
