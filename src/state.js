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
  // Per-kind tunables for blooms (pulses) and winds (sweeps). Read by
  // audio/events.js spawnPulse / spawnSweep on every firing so live
  // edits take effect immediately. Edited via the bloom/wind config
  // window in src/bloom-wind-config.js.
  // Blooms have two independent timings:
  //   expandBars — how fast the shockwave reaches maxRadius
  //   durationBars — total lifetime; the EFFECT FADES over the hold
  //                  remainder (durationBars - expandBars) before the
  //                  bloom pops. Earlier this was one knob; users
  //                  asked for separate velocity vs persistence
  //                  control so they could fire fast-expanding,
  //                  long-fading drops or slow-creeping muffles.
  bloomSettings: {
    drop:   { maxRadius: 320, expandBars: 0.25, durationBars: 1.5 },
    muffle: { maxRadius: 360, expandBars: 0.5,  durationBars: 2.0 },
    thin:   { maxRadius: 360, expandBars: 0.5,  durationBars: 2.0 },
  },
  windSettings: {
    rise: { durationBars: 4 },
    fade: { durationBars: 4 },
  },
};

export function seedById(id) { return seeds.find(s => s.id === id); }
