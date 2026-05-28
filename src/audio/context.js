// Audio context + base synthesis helpers.
//
// Owns the AudioContext lifecycle, master gain, capability detection
// (PeriodicWave), and the small helpers every other audio module
// needs (setOscWave, createNoiseBuffer, status reporting). Other
// modules import the live bindings `audioCtx` / `masterGain` —
// they're null until `tryCreateContext()` succeeds.
//
// `onContextCreated(fn)` registers a one-time hook fired the first
// time the context is successfully created — used by callers that
// need to attach modifier audio chains for seeds planted pre-audio.

export let audioCtx = null;
export let masterGain = null;
// Drum bus — drum-category voices route here instead of straight to
// masterGain. Path: drumBus → drumCompressor → masterGain. The
// compressor gives the kit unified "glue": a kick transient lightly
// ducks the snare/hat tails so the whole rhythm punches as one
// instrument rather than three stacked. Settings tuned for "tight,
// not squashed" — 4:1 ratio, fast attack, medium release, low knee.
export let drumBus = null;
export let drumCompressor = null;
export let supportsPeriodicWave = false;
export const NUM_HARMONICS = 12;

const onCreatedHooks = [];
export function onContextCreated(fn) { onCreatedHooks.push(fn); }

// The status pill answers exactly one question: "can the audio
// engine make sound at all?" — separate from the composition
// transport (which the play button shows). Possible top words:
//   ready   — audioCtx.state === 'running'. Pressing keys, planting
//             seeds, all sound is operational.
//   blocked — audioCtx.state === 'suspended'. Browsers start contexts
//             suspended until a user gesture; the next click anywhere
//             resumes it. Live notes / patterns produce no audio while
//             this is on screen.
//   closed  — audioCtx.state === 'closed'. Hard failure; reload.
//   error   — context creation or resume threw. Detail comes via the
//             optional override below.
//
// Latency numbers append as a suffix when known.
let overrideText = null;
let overrideKind = '';
let lastAudioLatencyMs = null;
let lastMidiLatencyMs = null;

function stateWord() {
  if (!audioCtx) return 'not started';
  if (audioCtx.state === 'running') return 'ready';
  if (audioCtx.state === 'suspended') return 'blocked (click to enable)';
  if (audioCtx.state === 'closed') return 'closed';
  return audioCtx.state || 'unknown';
}

function repaintAudioStatus() {
  const el = document.getElementById('audio-status');
  if (!el) return;
  const text = overrideText != null ? overrideText : stateWord();
  let suffix = '';
  if (lastAudioLatencyMs != null && lastAudioLatencyMs > 0) {
    suffix += ` · audio ${lastAudioLatencyMs.toFixed(0)}ms`;
  }
  if (lastMidiLatencyMs != null) {
    suffix += ` · midi ${lastMidiLatencyMs.toFixed(0)}ms`;
  }
  el.textContent = 'audio: ' + text + suffix;
  el.classList.remove('error', 'ok');
  if (overrideKind === 'error') el.classList.add('error');
  else if (audioCtx && audioCtx.state === 'running' && overrideKind !== 'error') el.classList.add('ok');
}

// Internal callers (resume timeouts, create failures, etc.) push
// transient text that wins over the derived state word. Pass null
// to clear and return to the derived word.
export function showAudioStatus(text, kind = '') {
  overrideText = text;
  overrideKind = kind;
  repaintAudioStatus();
}

// Poll the live context state so the pill never goes stale — the
// browser can flip suspended → running on a user gesture without
// notifying us, and we want the readout to track that immediately.
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    // If an override is in place, leave it; otherwise re-derive.
    if (overrideText == null) repaintAudioStatus();
  }, 500);
}

if (typeof window !== 'undefined') {
  window.showAudioStatusLatency = (audioMs, midiMs) => {
    if (audioMs != null) lastAudioLatencyMs = audioMs;
    if (midiMs != null) lastMidiLatencyMs = midiMs;
    repaintAudioStatus();
  };
}

// Race a promise against a timer so a hung Promise can't freeze our flow.
export function withTimeout(promise, ms, label) {
  return Promise.race([
    promise.then(v => ({ value: v }), e => ({ error: e })),
    new Promise(resolve => setTimeout(() => resolve({ timeout: true, label }), ms)),
  ]);
}

// Synchronously create the AudioContext. Safe to call multiple times.
// In some browsers/iframes this only succeeds inside a user-gesture
// handler, so we both try it at load time AND on first interaction.
export function tryCreateContext() {
  if (audioCtx) return true;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { showAudioStatus('no web audio api', 'error'); return false; }
    // latencyHint: 'interactive' asks the browser for the smallest
    // available audio buffer. Default is 'balanced' (power-conserving,
    // larger buffer) which produced ~180ms on Firefox-based browsers
    // here. 'interactive' typically drops to 20-50ms on the same
    // hardware. We're not aware of any voice in this app that needs
    // a huge buffer to render cleanly — there's headroom to take the
    // hit if a slower machine struggles, but the trade-off is worth
    // it for a live-playable feel.
    audioCtx = new Ctx({ latencyHint: 'interactive' });
    // Master chain: masterGain → masterLimiter → destination.
    // The limiter is a high-ratio compressor that catches transient
    // peaks above ~-2 dBFS so a loud chord or a hot drum hit doesn't
    // clip the output. Settings: threshold -2, ratio 20:1 (brickwall-
    // ish), 3ms attack to catch fast transients, 80ms release to let
    // tails through without pumping.
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.35;
    const masterLimiter = audioCtx.createDynamicsCompressor();
    masterLimiter.threshold.value = -2;
    masterLimiter.knee.value = 0;           // hard knee = limiter behaviour
    masterLimiter.ratio.value = 20;         // brickwall
    masterLimiter.attack.value = 0.003;
    masterLimiter.release.value = 0.080;
    masterGain.connect(masterLimiter);
    masterLimiter.connect(audioCtx.destination);
    // Drum bus + compressor. Routing: drumBus → drumCompressor →
    // masterGain → masterLimiter → destination. The drum compressor
    // glues the kit; the master limiter is the safety net for the
    // whole mix.
    drumBus = audioCtx.createGain();
    drumBus.gain.value = 1.0;
    drumCompressor = audioCtx.createDynamicsCompressor();
    drumCompressor.threshold.value = -18;   // start compressing past -18 dBFS
    drumCompressor.knee.value = 6;          // soft knee for musicality
    drumCompressor.ratio.value = 4;         // 4:1 — firm but not crushed
    drumCompressor.attack.value = 0.003;    // fast — catch the transient
    drumCompressor.release.value = 0.12;    // medium — let tails breathe
    drumBus.connect(drumCompressor);
    drumCompressor.connect(masterGain);
    // Detect PeriodicWave support (some older Android WebViews lack it)
    try {
      const w = audioCtx.createPeriodicWave(new Float32Array([0, 1, 0]), new Float32Array([0, 0, 0]));
      const tosc = audioCtx.createOscillator();
      tosc.setPeriodicWave(w);
      supportsPeriodicWave = true;
    } catch (e) {
      supportsPeriodicWave = false;
    }
    // Clear any prior override and let the pill derive from state.
    showAudioStatus(null);
    for (const h of onCreatedHooks) { try { h(); } catch (e) {} }
    return true;
  } catch (e) {
    showAudioStatus('create: ' + (e.message || e), 'error');
    return false;
  }
}

// Ensure audio is created AND resumed. Resume is timeout-guarded so a
// non-resolving Promise can't lock up the UI. Safe to call from any
// handler.
export async function ensureAudio() {
  if (!audioCtx && !tryCreateContext()) return null;
  if (audioCtx.state === 'suspended') {
    // No transient "resuming..." text — the derived "blocked" word
    // accurately describes the state until resume() actually flips it.
    const result = await withTimeout(audioCtx.resume(), 1500, 'resume');
    if (result.timeout) {
      showAudioStatus('resume timeout · state=' + audioCtx.state, 'error');
    } else if (result.error) {
      showAudioStatus('resume err · ' + (result.error.message || ''), 'error');
    } else {
      showAudioStatus(null);   // back to derived word
    }
  } else {
    showAudioStatus(null);
  }
  return audioCtx;
}

// Back-compat alias for callers that still say initAudio
export const initAudio = ensureAudio;

export function setMasterVol(v) {
  if (masterGain) masterGain.gain.setTargetAtTime(v, audioCtx.currentTime, 0.05);
}

export function buildPeriodicWave(harmonicAmps) {
  const len = NUM_HARMONICS + 2;
  const real = new Float32Array(len);
  const imag = new Float32Array(len);
  real[1] = 1.0;
  for (let i = 0; i < harmonicAmps.length; i++) real[i + 2] = harmonicAmps[i] || 0;
  return audioCtx.createPeriodicWave(real, imag);
}

// Apply a harmonic spectrum to an oscillator. If PeriodicWave isn't
// supported, approximate by picking a standard waveform type based on
// the harmonic content.
export function setOscWave(osc, harmonicAmps) {
  if (supportsPeriodicWave) {
    try {
      osc.setPeriodicWave(buildPeriodicWave(harmonicAmps));
      return;
    } catch (e) { /* fall through */ }
  }
  const lower = (harmonicAmps[0] || 0) + (harmonicAmps[1] || 0) + (harmonicAmps[2] || 0);
  const upper = (harmonicAmps[6] || 0) + (harmonicAmps[7] || 0) + (harmonicAmps[8] || 0) + (harmonicAmps[9] || 0);
  if (upper > 0.15) osc.type = 'sawtooth';
  else if (lower > 0.3) osc.type = 'triangle';
  else osc.type = 'sine';
}

let _noiseBufferCache = null;
export function createNoiseBuffer(durationSec) {
  durationSec = Math.max(0.05, durationSec);
  if (_noiseBufferCache && _noiseBufferCache.length / audioCtx.sampleRate >= durationSec - 0.001) {
    return _noiseBufferCache;
  }
  const length = Math.floor(audioCtx.sampleRate * Math.max(0.3, durationSec));
  const buf = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  _noiseBufferCache = buf;
  return buf;
}
