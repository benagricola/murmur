// Metronome — togglable click track to help time recording.
//
// Schedules a short sine "tick" every beat while playback is running
// and the metronome is toggled on. Uses the same master-beat-clock
// formula as the seed scheduler so it's phase-locked with everything
// else: tick N fires at playbackStartTime + N × beatInterval.
//
// Beat 1 of each 4-beat bar gets a higher-pitched accent so the user
// can hear the bar boundary.

import { audioCtx, masterGain } from './audio/context.js';
import { BEAT_MS } from './tempo.js';
import { state } from './state.js';

const CLICK_HZ = 1000;     // off-beat tick
const ACCENT_HZ = 1500;    // downbeat tick (beat 1 of bar)
const CLICK_GAIN = 0.18;
const ACCENT_GAIN = 0.26;

let metronomeOn = false;
let metronomeTick = 0;
let timer = null;

export function isMetronomeOn() { return metronomeOn; }

export function setMetronome(on) {
  metronomeOn = !!on;
  if (metronomeOn) startTimer();
  else stopTimer();
  const btn = document.getElementById('metro-btn');
  if (btn) btn.classList.toggle('on', metronomeOn);
}

function startTimer() {
  if (timer) return;
  reanchorTick();
  timer = setInterval(scheduleAhead, 25);
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

// Snap metronomeTick to the next beat boundary at "now". Called on
// toggle-on, on play start, and on tempo change.
function reanchorTick() {
  if (!audioCtx) { metronomeTick = 0; return; }
  const start = state.playbackStartTime || audioCtx.currentTime;
  const since = audioCtx.currentTime - start;
  const beat = BEAT_MS / 1000;
  metronomeTick = Math.max(0, Math.ceil(since / beat));
}

function scheduleAhead() {
  if (!state.isPlaying || !metronomeOn || !audioCtx) return;
  const now = audioCtx.currentTime;
  const beat = BEAT_MS / 1000;
  const lookahead = 0.10;
  while (true) {
    const fireTime = state.playbackStartTime + metronomeTick * beat;
    if (fireTime >= now + lookahead) break;
    if (fireTime < now - 0.5) { metronomeTick++; continue; }
    const accent = metronomeTick % 4 === 0;
    fireClick(fireTime, accent);
    metronomeTick++;
  }
}

function fireClick(when, accent) {
  if (!audioCtx || !masterGain) return;
  const osc = audioCtx.createOscillator();
  const env = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = accent ? ACCENT_HZ : CLICK_HZ;
  osc.connect(env);
  env.connect(masterGain);
  const peak = accent ? ACCENT_GAIN : CLICK_GAIN;
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(peak, when + 0.001);
  env.gain.exponentialRampToValueAtTime(0.0008, when + 0.04);
  osc.start(when);
  osc.stop(when + 0.06);
}

// Re-anchor when transport restarts so the metronome doesn't drift.
// transport.js dispatches `play-anchor-changed` on start + tempo
// re-anchor; we listen.
window.addEventListener('play-anchor-changed', () => {
  if (metronomeOn) reanchorTick();
});

// Top-bar toggle button is wired by the index.html element id.
const btn = document.getElementById('metro-btn');
if (btn) {
  btn.addEventListener('click', () => setMetronome(!metronomeOn));
}

// DevTools handle.
if (typeof window !== 'undefined') {
  window.murmurMetronome = (on) => setMetronome(on !== undefined ? on : !metronomeOn);
}
