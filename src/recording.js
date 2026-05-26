// Recording: capture a played phrase from the keyboard, compress it
// into a pattern, and plant a fresh seed (or overwrite the selected
// voice seed's pattern). Auto-finish kicks in after a quiet period
// with no held keys.

import { freqFromMidi, snapToScale, SEED_COLORS } from './constants.js';
import { NUM_HARMONICS, initAudio } from './audio/context.js';
import { BAR_MS } from './tempo.js';
import { seeds, state, seedById, activeLiveNotes } from './state.js';
import {
  makeSeed, radiusForFundamental, syncRenderedSeeds,
} from './seeds.js';
import { selectSeed } from './inspector.js';
import { takeSnapshot } from './snapshots.js';

const RECORD_AUTO_FINISH_MS = 1500;  // stop after this much silence

export function startRecording() {
  if (state.isRecording) return;
  state.isRecording = true;
  state.recordingBuffer = null;
  document.getElementById('rec-btn').classList.add('recording');
  document.getElementById('rec-btn').textContent = '■ stop';
  const ov = document.createElement('div');
  ov.className = 'recording-overlay';
  ov.id = 'rec-overlay';
  ov.innerHTML = '<span class="rec-dot"></span><span>recording · play a phrase</span>';
  document.getElementById('canvas-wrap').appendChild(ov);
}

export function finishRecording() {
  if (!state.isRecording) return;
  state.isRecording = false;
  document.getElementById('rec-btn').classList.remove('recording');
  document.getElementById('rec-btn').textContent = '● record';
  const ov = document.getElementById('rec-overlay');
  if (ov) ov.remove();

  if (!state.recordingBuffer || state.recordingBuffer.notes.length === 0) return;
  const result = phraseFromRecording(state.recordingBuffer);
  state.recordingBuffer = null;
  if (!result) return;

  const sel = seedById(state.selectedSeedId);
  if (sel && sel.kind === 'voice') {
    sel.pattern = result.pattern;
    sel.intervalMs = result.intervalMs;
    sel.fundamental = result.fundamental;
    sel.r = radiusForFundamental(sel.fundamental);
    syncRenderedSeeds();
    selectSeed(sel.id);
    takeSnapshot('rewrote ' + sel.label);
  } else {
    plantRecordedSeed(result);
  }
}

export function rescheduleRecordingAutoFinish() {
  if (!state.recordingBuffer) return;
  clearTimeout(state.recordingBuffer.silenceTimer);
  state.recordingBuffer.silenceTimer = setTimeout(checkAutoFinishRecording, RECORD_AUTO_FINISH_MS);
}

function checkAutoFinishRecording() {
  if (!state.isRecording || !state.recordingBuffer) return;
  if (activeLiveNotes.size > 0) {
    // Keys still held — recheck in 100ms
    state.recordingBuffer.silenceTimer = setTimeout(checkAutoFinishRecording, 100);
    return;
  }
  const sinceActivity = performance.now() - state.recordingBuffer.lastActivityMs;
  if (sinceActivity < RECORD_AUTO_FINISH_MS) {
    state.recordingBuffer.silenceTimer = setTimeout(checkAutoFinishRecording, RECORD_AUTO_FINISH_MS - sinceActivity + 50);
    return;
  }
  finishRecording();
}

// Transform a recorded note stream into seed parameters.
// Guardrails on: quantize to 16th notes, snap to scale. Otherwise
// 32nd-note grid and keep raw pitches.
function phraseFromRecording(buf) {
  const notes = buf.notes;
  if (notes.length === 0) return null;

  const midis = notes.map(n => n.midi).slice().sort((a, b) => a - b);
  const fundamentalMidi = midis[Math.floor(midis.length / 2)];
  const fundamentalFreq = freqFromMidi(fundamentalMidi);

  const stepMs = state.guardrails ? (BAR_MS / 16) : (BAR_MS / 32);
  const maxSteps = state.guardrails ? 16 : 32;
  const totalSpan = Math.max(...notes.map(n => n.t)) + stepMs;
  const totalSteps = Math.min(maxSteps, Math.max(4, Math.ceil(totalSpan / stepMs)));

  // Bucket notes by step. Each step keeps an array of unique-pitch
  // notes; if a pitch hits the same step twice, the louder wins.
  const stepBuckets = new Array(totalSteps).fill(null).map(() => []);
  for (const n of notes) {
    const step = Math.min(totalSteps - 1, Math.round(n.t / stepMs));
    const durMs = n.duration !== null && n.duration !== undefined ? n.duration : (stepMs * 0.6);
    const existingIdx = stepBuckets[step].findIndex(x => x.midi === n.midi);
    const entry = { midi: n.midi, velocity: n.velocity, durMs };
    if (existingIdx >= 0) {
      if (stepBuckets[step][existingIdx].velocity < n.velocity) {
        stepBuckets[step][existingIdx] = entry;
      }
    } else {
      stepBuckets[step].push(entry);
    }
  }
  while (stepBuckets.length > 1 && stepBuckets[stepBuckets.length - 1].length === 0) stepBuckets.pop();

  const toStep = (notes) => {
    if (notes.length === 0) return { offset: 0, velocity: 0, duration: 1.0 };
    notes.sort((a, b) => a.midi - b.midi);
    const noteToFields = (nn) => {
      const useMidi = state.guardrails ? snapToScale(nn.midi) : nn.midi;
      return {
        offset: useMidi - fundamentalMidi,
        velocity: Math.max(0.3, Math.min(1.0, nn.velocity * 1.3)),
        duration: Math.max(0.15, Math.min(8.0, nn.durMs / stepMs)),
      };
    };
    const primary = noteToFields(notes[0]);
    if (notes.length > 1) primary.extras = notes.slice(1).map(noteToFields);
    return primary;
  };

  return {
    fundamental: fundamentalFreq,
    intervalMs: stepMs,
    pattern: stepBuckets.map(toStep),
  };
}

function plantRecordedSeed(result) {
  const n = seeds.filter(s => s.kind === 'voice').length;
  const cx = 240 + (n % 4) * 280 + 40 * Math.random();
  const cy = 180 + Math.floor(n / 4) * 200 + 40 * Math.random();

  const harmonics = new Array(NUM_HARMONICS).fill(0);
  for (let i = 0; i < 5; i++) harmonics[i] = 0.3 * Math.exp(-i * 0.5);

  const color = SEED_COLORS[n % SEED_COLORS.length];
  const labels = ['little wisp', 'soft hum', 'echo bone', 'spark', 'glimmer', 'small stone', 'feather', 'dapple', 'flicker', 'reed'];
  const label = labels[Math.floor(Math.random() * labels.length)];

  const seed = makeSeed({
    cx, cy,
    r: radiusForFundamental(result.fundamental),
    fundamental: result.fundamental,
    decay: BAR_MS / 4,
    intervalMs: result.intervalMs,
    harmonics, color, label,
    pattern: result.pattern,
    quantize: true,
  });

  for (const m of seeds.filter(s => s.kind === 'modifier')) {
    const d = Math.hypot(seed.cx - m.cx, seed.cy - m.cy);
    if (d < m.sphereR) {
      seed.capturedByIds.add(m.id);
      m.capturedSeedIds.add(seed.id);
    }
  }

  syncRenderedSeeds();
  selectSeed(seed.id);
  takeSnapshot('recorded ' + label);
}

document.getElementById('rec-btn').addEventListener('click', async () => {
  await initAudio();
  if (state.isRecording) finishRecording();
  else startRecording();
});
