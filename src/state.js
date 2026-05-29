// Cross-cutting mutable state. Arrays/maps/sets export directly (their
// contents mutate naturally); scalars live as properties on `state` so
// importers can both read and write them — ES module `let` exports are
// read-only from outside the owning module, but object properties have
// no such restriction.
//
// Because any module CAN write any field, the contract is by
// convention. To keep that legible, here is the writer-of-record for
// each `state` field (everyone else should treat it as read-only — a
// write from a module not listed is a smell worth questioning):
//
//   nextSeedId        seeds.js (++ on create), snapshots.js (restore)
//   nextEventId       audio/events.js (++ on spawn)
//   selectedSeedId    inspector.js owns selection; snapshots/demo clear
//                     it on revert/wipe; controls/scheduler/seeds read-
//                     mostly + clear on delete. The one genuinely
//                     shared-write field — change with care.
//   plantMode         pointer.js (palette), output/minilab3.js (pads)
//   guardrails        transport.js (toggle)
//   isRecording       recording.js
//   recordingBuffer   recording.js + input.js (note capture)
//   isPlaying         transport.js
//   playbackStartTime transport.js (play), scheduler.js (re-anchor)
//   pitchBendCents    input.js
//   sustainPedalDown  input.js
//   sweepDrag         pointer.js
//   bloomSettings     bloom-wind-config.js (read by audio/events.js)
//   windSettings      bloom-wind-config.js (read by audio/events.js)

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
