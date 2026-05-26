// Cross-cutting mutable state. Arrays/maps/sets export directly (their
// contents mutate naturally); scalars live as properties on `state` so
// importers can both read and write them — ES module `let` exports are
// read-only from outside the owning module, but object properties have
// no such restriction.

export const seeds = [];
export const activeEvents = [];
export const snapshots = [];
export const activeLiveNotes = new Map();
export const releasingNotes = new Set();
export const sustainedMidis = new Set();

export const state = {
  nextSeedId: 1,
  nextEventId: 1,
  selectedSeedId: null,
  plantMode: 'voice',
  guardrails: true,
  isRecording: false,
  recordingBuffer: null,
  isPlaying: false,
  playbackStartTime: 0,
  pitchBendCents: 0,
  sustainPedalDown: false,
  // Pointer drag state — populated by input/pointer.js, read by the
  // tick loop so the live sweep-line preview can render mid-drag.
  sweepDrag: null,
};

export function seedById(id) { return seeds.find(s => s.id === id); }
