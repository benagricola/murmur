// Top-bar transport + global controls: BPM slider, master volume,
// play/pause button, guardrails toggle. Also the pad-driven transport
// helpers (transportStop / Play / Record / Tap) called from input.js
// when the MiniLab 3 bank A pads 5-8 fire.

import { BPM, BAR_MS, setTempo } from './tempo.js';
import { seeds, state } from './state.js';
import {
  ensureAudio, audioCtx, supportsPeriodicWave,
  setMasterVol, showAudioStatus, withTimeout,
} from './audio/context.js';

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
export function transportRecord() {
  document.getElementById('rec-btn').click();
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
    state.isPlaying = false;
    try { await ctx.suspend(); } catch (e) {}
    playBtn.textContent = '▶ start';
    playBtn.classList.add('primary');
    showAudioStatus(ctx.state + ' · stopped');
  } else {
    state.isPlaying = true;
    if (ctx.state === 'suspended') {
      const result = await withTimeout(ctx.resume(), 1500, 'resume');
      if (result.timeout || result.error) {
        showAudioStatus('cannot resume · state=' + ctx.state, 'error');
        state.isPlaying = false;
        return;
      }
    }
    playBtn.textContent = '■ stop';
    playBtn.classList.remove('primary');
    state.playbackStartTime = ctx.currentTime + 0.04;
    for (const s of seeds) {
      s.nextTrigger = 0; s.patternIdx = 0;
    }
    showAudioStatus(ctx.state + ' · playing' + (supportsPeriodicWave ? '' : ' · basic'),
                    ctx.state === 'running' ? 'ok' : '');
  }
});

document.getElementById('vol').addEventListener('input', (e) => {
  setMasterVol(parseFloat(e.target.value) / 100);
});

document.getElementById('tempo-slider').addEventListener('input', (e) => {
  setBPM(parseInt(e.target.value));
});

// Guardrails toggle. Emits a `guardrails-changed` event so other
// modules (input.js paints in-scale piano keys) can react without
// importing back into transport.js.
document.getElementById('guard-toggle').addEventListener('click', () => {
  state.guardrails = !state.guardrails;
  document.getElementById('guard-pill').classList.toggle('on', state.guardrails);
  window.dispatchEvent(new CustomEvent('guardrails-changed', { detail: state.guardrails }));
});
