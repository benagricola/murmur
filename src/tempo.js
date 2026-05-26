// Tempo state. Owned here so any module can import live bindings of
// BPM / BEAT_MS / BAR_MS and pick up changes when tempo updates. The
// high-level `setBPM` that also rescales seeds and refreshes the DOM
// stays in main.js — this module is the raw state and option-sync.

import { RHYTHM_OPTIONS, LENGTH_OPTIONS, RIPPLE_DELAY_OPTIONS } from './constants.js';

export let BPM = 96;
export let BEAT_MS = 60000 / BPM;
export let BAR_MS = BEAT_MS * 4;

export function recomputeOptionsMs() {
  for (const o of RHYTHM_OPTIONS) o.ms = o.frac * BAR_MS;
  for (const o of LENGTH_OPTIONS) o.ms = o.frac * BAR_MS;
  for (const o of RIPPLE_DELAY_OPTIONS) o.ms = o.frac * BAR_MS;
}
recomputeOptionsMs();

// Raw tempo set. Returns the previous BAR_MS so callers can rescale
// other timings against it (e.g. seed intervalMs).
export function setTempo(newBPM) {
  const oldBar = BAR_MS;
  BPM = Math.max(40, Math.min(220, newBPM));
  BEAT_MS = 60000 / BPM;
  BAR_MS = BEAT_MS * 4;
  recomputeOptionsMs();
  return oldBar;
}
