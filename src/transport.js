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
// seed's bar-fraction-derived timings so music stays musically aligned.
//
// Phase preservation: we used to set `s.nextTrigger = 0` here, which
// forced the scheduler to re-quantize to the next grid slot at the
// new tempo. That produced an audible step on every BPM tick — when
// the slider fires `input` 30 times during a drag, you hear 30
// re-quantizations. Now we *rescale* nextTrigger by the same ratio
// the interval changed by, so each seed continues from exactly its
// current rhythmic position. No re-phase, no jump.
//
// Audio params: when `seed.delayMs` is changed, the delayNode's
// `delayTime` AudioParam is also ramped via `setTargetAtTime` so the
// audible delay tail follows smoothly instead of waiting for the
// next encoder turn.
export function setBPM(newBPM) {
  const oldBar = setTempo(newBPM);
  const ratio = BAR_MS / oldBar;
  const ctx = audioCtx;
  const now = ctx ? ctx.currentTime : 0;
  for (const s of seeds) {
    if (s.intervalMs) s.intervalMs = s.intervalMs * ratio;
    if (s.decay)      s.decay      = s.decay      * ratio;
    if (s.attackMs)   s.attackMs   = s.attackMs   * ratio;
    if (s.delayMs) {
      s.delayMs = s.delayMs * ratio;
      // Live audio: ramp the delay-time param so the tail tracks
      // tempo instead of jumping when the user next touches it.
      if (s.delayNode && ctx) {
        s.delayNode.delayTime.setTargetAtTime(s.delayMs / 1000, now, 0.05);
      }
    }
    // Phase-preserve: rescale the time-until-next-trigger by the same
    // ratio. Seeds keep playing through tempo changes without dropping
    // or doubling notes.
    if (s.nextTrigger && ctx) {
      const remaining = s.nextTrigger - now;
      if (remaining > 0) s.nextTrigger = now + remaining * ratio;
    }
  }
  // Rescale playback start so quantize-from-start (used when nextTrigger
  // is stale, e.g. just after a stop/play) lands on the right grid slot.
  if (ctx && state.playbackStartTime) {
    const since = now - state.playbackStartTime;
    if (since > 0) state.playbackStartTime = now - since * ratio;
  }
  const el = document.getElementById('tempo-val');
  if (el) el.textContent = Math.round(BPM) + ' bpm';
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

// Slider 'input' fires ~30Hz while dragging. Each fire used to run
// setBPM(), which loops every seed and ramps audio params — at 30Hz
// that's enough work to feel jittery. Coalesce into one update per
// animation frame so the slider can fire freely but we only do real
// work at the display refresh rate.
let pendingBpm = null;
let bpmRaf = 0;
document.getElementById('tempo-slider').addEventListener('input', (e) => {
  pendingBpm = parseInt(e.target.value);
  disengageFader('tempo-slider');
  if (!bpmRaf) {
    bpmRaf = requestAnimationFrame(() => {
      bpmRaf = 0;
      if (pendingBpm != null) {
        setBPM(pendingBpm);
        pendingBpm = null;
      }
    });
  }
});

// Guardrails toggle. Emits a `guardrails-changed` event so other
// modules (input.js paints in-scale piano keys) can react without
// importing back into transport.js.
document.getElementById('guard-toggle').addEventListener('click', () => {
  state.guardrails = !state.guardrails;
  document.getElementById('guard-pill').classList.toggle('on', state.guardrails);
  window.dispatchEvent(new CustomEvent('guardrails-changed', { detail: state.guardrails }));
});
