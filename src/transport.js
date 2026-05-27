// Top-bar transport + global controls: BPM slider, master volume,
// play/pause button, guardrails toggle. Also the pad-driven transport
// helpers (transportStop / Play / Record / Tap) called from input.js
// when the MiniLab 3 bank A pads 5-8 fire.

import { BPM, BAR_MS, setTempo } from './tempo.js';
import { seeds, state } from './state.js';
import {
  ensureAudio, audioCtx, supportsPeriodicWave,
  setMasterVol, showAudioStatus, onContextCreated,
} from './audio/context.js';
import {
  refreshPadLights, paintScreen, startClockOut, stopClockOut,
} from './output/minilab3.js';
import { disengageFader } from './controls.js';

// High-level tempo change — updates tempo state, then rescales every
// seed's bar-fraction-derived timings (intervalMs, decay, attack, delay)
// so the music stays musically aligned across tempo changes, and
// refreshes the on-screen BPM readout.
export function setBPM(newBPM) {
  const oldBar = setTempo(newBPM);
  for (const s of seeds) {
    if (s.intervalMs) s.intervalMs = (s.intervalMs / oldBar) * BAR_MS;
    if (s.decay)      s.decay      = (s.decay      / oldBar) * BAR_MS;
    if (s.attackMs)   s.attackMs   = (s.attackMs   / oldBar) * BAR_MS;
    if (s.delayMs)    s.delayMs    = (s.delayMs    / oldBar) * BAR_MS;
    s.nextTrigger = 0;  // re-phase on next schedule pass
  }
  const el = document.getElementById('tempo-val');
  if (el) el.textContent = BPM + ' bpm';
}

// === Transport (pad-driven) ===
export function transportStop() {
  if (state.isPlaying) document.getElementById('play-btn').click();
}
export function transportPlay() {
  if (!state.isPlaying) document.getElementById('play-btn').click();
}
// MIDI Continue (0xFB) vs Start (0xFA): Continue should resume
// without resetting playback position. We toggle isPlaying directly
// rather than clicking the play button (whose handler resets
// nextTrigger / patternIdx).
export function transportContinue() {
  if (state.isPlaying) return;
  state.isPlaying = true;
  const btn = document.getElementById('play-btn');
  btn.textContent = '■ stop';
  btn.classList.remove('primary');
}
export function transportRecord() {
  document.getElementById('rec-btn').click();
}

// === MIDI Clock (0xF8) → tempo sync ===
// 24 ticks per quarter note is the MIDI spec. We keep a sliding
// window of recent tick timestamps and derive BPM from their average
// interval. Setting BPM every tick would be wasteful, so we update
// only when the derived value moves by ≥1 BPM and at most every
// quarter note (24 ticks).
const CLOCK_TICKS_PER_BEAT = 24;
const clockTicks = [];
let lastAppliedBpm = 0;

export function transportClockTick() {
  const now = performance.now();
  clockTicks.push(now);
  // Keep at most 2 beats' worth (48 ticks) for averaging — long
  // enough to smooth, short enough to follow tempo changes quickly.
  if (clockTicks.length > CLOCK_TICKS_PER_BEAT * 2) clockTicks.shift();
  if (clockTicks.length % CLOCK_TICKS_PER_BEAT !== 0) return;  // only act per quarter
  if (clockTicks.length < CLOCK_TICKS_PER_BEAT) return;
  const span = clockTicks[clockTicks.length - 1] - clockTicks[0];
  const beats = (clockTicks.length - 1) / CLOCK_TICKS_PER_BEAT;
  const bpm = Math.round(60000 * beats / span);
  if (bpm < 40 || bpm > 240) return;
  if (Math.abs(bpm - lastAppliedBpm) < 1) return;
  lastAppliedBpm = bpm;
  setBPM(bpm);
  const slider = document.getElementById('tempo-slider');
  if (slider) slider.value = bpm;
}

// Called by external MIDI Start so the clock-tick averager doesn't
// carry stale timestamps across a stop / restart.
export function transportClockReset() {
  clockTicks.length = 0;
  lastAppliedBpm = 0;
}

// Tap tempo — average the last few inter-tap intervals and apply to
// BPM. Stale taps drop after 4 seconds so a fresh series doesn't get
// poisoned by an earlier abandoned attempt.
const tapTempoTaps = [];
export function transportTap() {
  const now = performance.now();
  while (tapTempoTaps.length && now - tapTempoTaps[0] > 4000) tapTempoTaps.shift();
  tapTempoTaps.push(now);
  if (tapTempoTaps.length < 2) return;
  let total = 0;
  for (let i = 1; i < tapTempoTaps.length; i++) total += tapTempoTaps[i] - tapTempoTaps[i - 1];
  const avgMs = total / (tapTempoTaps.length - 1);
  const bpm = Math.round(60000 / avgMs);
  if (bpm < 40 || bpm > 240) return;
  setBPM(bpm);
  const slider = document.getElementById('tempo-slider');
  if (slider) slider.value = bpm;
  const tempoVal = document.getElementById('tempo-val');
  if (tempoVal) tempoVal.textContent = bpm + ' bpm';
}

// === Top-bar UI handlers ===

const playBtn = document.getElementById('play-btn');
playBtn.addEventListener('click', async () => {
  const ctx = await ensureAudio();
  if (!ctx) return;
  if (state.isPlaying) {
    // STOP: only tell the scheduler to stop creating new voices.
    // DON'T suspend the AudioContext — that freezes in-flight
    // oscillators mid-flight, so a subsequent START resumes them
    // exactly where they were, producing the "ghost chord on start"
    // bug. Letting state.isPlaying flip without touching the context
    // lets existing voices play out their envelopes naturally over
    // 1-2s and self-terminate via their scheduled osc.stop() calls.
    state.isPlaying = false;
    playBtn.textContent = '▶ start';
    playBtn.classList.add('primary');
    showAudioStatus(ctx.state + ' · stopped');
    stopClockOut();  // halt the MiniLab arpeggiator
    refreshPadLights(); paintScreen();
  } else {
    // START: ensure the context is running, then enable the
    // scheduler. ensureAudio (called above) already handles a
    // suspended context, so we don't need a second resume here.
    state.isPlaying = true;
    playBtn.textContent = '■ stop';
    playBtn.classList.remove('primary');
    state.playbackStartTime = ctx.currentTime + 0.04;
    for (const s of seeds) {
      s.nextTrigger = 0; s.patternIdx = 0;
    }
    showAudioStatus(ctx.state + ' · playing' + (supportsPeriodicWave ? '' : ' · basic'),
                    ctx.state === 'running' ? 'ok' : '');
    startClockOut();  // sync the MiniLab arpeggiator to murmur's tempo
    refreshPadLights(); paintScreen();
  }
});

document.getElementById('vol').addEventListener('input', (e) => {
  setMasterVol(parseFloat(e.target.value) / 100);
  // Web slider was just moved — disengage the matching physical
  // fader so it has to catch the new value before taking over.
  disengageFader('vol');
});

// Browsers restore slider values across reloads, but the AudioContext
// is recreated each load and the master gain defaults to 0.35. Re-sync
// gain from the slider as soon as audio comes online, so the audible
// volume always matches what the slider visibly shows.
onContextCreated(() => {
  const slider = document.getElementById('vol');
  if (slider) setMasterVol(parseFloat(slider.value) / 100);
});

document.getElementById('tempo-slider').addEventListener('input', (e) => {
  setBPM(parseInt(e.target.value));
  disengageFader('tempo-slider');
});

// Guardrails toggle. Emits a `guardrails-changed` event so other
// modules (input.js paints in-scale piano keys) can react without
// importing back into transport.js.
document.getElementById('guard-toggle').addEventListener('click', () => {
  state.guardrails = !state.guardrails;
  document.getElementById('guard-pill').classList.toggle('on', state.guardrails);
  window.dispatchEvent(new CustomEvent('guardrails-changed', { detail: state.guardrails }));
});
