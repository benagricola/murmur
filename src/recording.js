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
import { refreshPadLights, paintScreen } from './output/minilab3.js';
import { DRUM_KIT, DRUM_KIT_COLOURS, DRUM_KIT_FUNDAMENTAL_HZ } from './audio/drum-kit.js';

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
  refreshPadLights(); paintScreen();
}

export function finishRecording() {
  if (!state.isRecording) return;
  state.isRecording = false;
  document.getElementById('rec-btn').classList.remove('recording');
  document.getElementById('rec-btn').textContent = '● record';
  const ov = document.getElementById('rec-overlay');
  if (ov) ov.remove();
  refreshPadLights(); paintScreen();

  if (!state.recordingBuffer || state.recordingBuffer.notes.length === 0) return;
  const buf = state.recordingBuffer;
  state.recordingBuffer = null;

  // Split drum-pad hits from tonal notes. Drum hits get their own
  // per-slot seeds (one seed per drum kit slot used); tonal notes
  // become a single melodic seed via the original phraseFromRecording
  // path. Either bucket can be empty.
  const drumNotes = buf.notes.filter(n => n.kind === 'drum');
  const tonalNotes = buf.notes.filter(n => n.kind !== 'drum');

  if (drumNotes.length > 0) {
    plantDrumKitSeed(drumNotes);
  }

  if (tonalNotes.length === 0) return;
  const tonalBuf = { ...buf, notes: tonalNotes };
  const result = phraseFromRecording(tonalBuf);
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

  const naturalStepMs = state.guardrails ? (BAR_MS / 16) : (BAR_MS / 32);
  const maxSteps = state.guardrails ? 16 : 32;
  const totalSpan = Math.max(...notes.map(n => n.t)) + naturalStepMs;
  // If the recording is longer than maxSteps × naturalStepMs can
  // cover, expand the step size to fit. Without this, late notes
  // (anything past maxSteps × naturalStepMs ms) get jammed into the
  // final bucket — which is why arp recordings used to end with all
  // remaining notes piled onto one step. Sacrifice timing resolution
  // over note-cramming.
  const stepMs = totalSpan > maxSteps * naturalStepMs
    ? totalSpan / maxSteps
    : naturalStepMs;
  const totalSteps = Math.min(maxSteps, Math.max(4, Math.ceil(totalSpan / stepMs)));

  // Bucket notes by step + chord-cluster within step.
  //
  // The grid step is the rhythmic position (BAR_MS/16 or /32). Two
  // notes land in the same step if their timestamps round to the
  // same grid line — but that's a coarse window (62-125 ms at 120
  // BPM), wide enough that genuinely separate notes were being
  // merged into accidental chords.
  //
  // Chord detection now uses a tight time window (CHORD_WINDOW_MS,
  // ~35 ms) — roughly the threshold of human-perceived simultaneity.
  // Notes within that window of the step's existing primary become
  // chord extras; notes outside it get nudged to the next free step.
  //
  // Each bucket entry carries its original timestamp `t` so we can
  // compute tOffset (the fractional displacement from the grid line,
  // [-0.5, +0.5]). The seed's quantize toggle decides at PLAYBACK
  // time whether to honour tOffset or snap clean to grid.
  const CHORD_WINDOW_MS = 35;
  const stepBuckets = new Array(totalSteps).fill(null).map(() => []);
  for (const n of notes) {
    const durMs = n.duration !== null && n.duration !== undefined ? n.duration : (stepMs * 0.6);
    // Walk forward from the desired step looking for either an
    // empty bucket OR a bucket whose primary is within the chord
    // window of this note.
    let step = Math.min(totalSteps - 1, Math.round(n.t / stepMs));
    while (step < totalSteps) {
      const bucket = stepBuckets[step];
      if (bucket.length === 0) {
        const exactStep = n.t / stepMs;
        const tOffset = Math.max(-0.49, Math.min(0.49, exactStep - step));
        bucket.push({ midi: n.midi, velocity: n.velocity, durMs, tOffset, t: n.t });
        break;
      }
      const primary = bucket[0];
      const dt = Math.abs(primary.t - n.t);
      if (dt < CHORD_WINDOW_MS) {
        // True chord — within human-simultaneity window. Add as
        // extra unless the same midi is already in the cluster, in
        // which case keep the louder velocity.
        const existingIdx = bucket.findIndex(x => x.midi === n.midi);
        if (existingIdx >= 0) {
          if (bucket[existingIdx].velocity < n.velocity) {
            bucket[existingIdx] = { midi: n.midi, velocity: n.velocity, durMs, tOffset: bucket[existingIdx].tOffset, t: bucket[existingIdx].t };
          }
        } else {
          bucket.push({ midi: n.midi, velocity: n.velocity, durMs, tOffset: primary.tOffset, t: n.t });
        }
        break;
      }
      // Same step, but outside the chord window — nudge to next.
      step++;
    }
    // If we walked off the end, the note's lost. Acceptable for
    // very long recordings; loop length is capped at totalSteps.
  }
  while (stepBuckets.length > 1 && stepBuckets[stepBuckets.length - 1].length === 0) stepBuckets.pop();

  const toStep = (notes) => {
    if (notes.length === 0) return { offset: 0, velocity: 0, duration: 1.0 };
    notes.sort((a, b) => a.midi - b.midi);
    // Step-wide tOffset = the loudest (primary) note's offset. Extras
    // in a chord usually arrive within a few ms of each other, so one
    // shared value is musically right.
    const primaryRaw = notes[0];
    const noteToFields = (nn) => {
      const useMidi = state.guardrails ? snapToScale(nn.midi) : nn.midi;
      return {
        offset: useMidi - fundamentalMidi,
        velocity: Math.max(0.3, Math.min(1.0, nn.velocity * 1.3)),
        duration: Math.max(0.15, Math.min(8.0, nn.durMs / stepMs)),
      };
    };
    const primary = noteToFields(primaryRaw);
    primary.tOffset = primaryRaw.tOffset || 0;
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

// === Drum-kit recording → one seed per loop ===
//
// All drum-pad hits in a recording become ONE seed whose pattern
// steps reference DRUM_KIT slots via step.drumSlot. Simultaneous
// hits (e.g. kick + hat) ride along as `extras` on the primary step.
// Scheduler at src/scheduler.js:playSeedStep dispatches each step's
// drumSlot to the right DRUM_KIT[slot].patch, routing through drumBus
// for kit-glue compression.
//
// This matches the "one beat = one thing on the canvas" mental
// model. Per-drum re-roll / mute is a future inspector feature.
function plantDrumKitSeed(drumNotes) {
  if (drumNotes.length === 0) return;

  const naturalStepMs = state.guardrails ? (BAR_MS / 16) : (BAR_MS / 32);
  const maxSteps = state.guardrails ? 16 : 32;
  const totalSpan = Math.max(...drumNotes.map(n => n.t)) + naturalStepMs;
  const stepMs = totalSpan > maxSteps * naturalStepMs
    ? totalSpan / maxSteps
    : naturalStepMs;
  const totalSteps = Math.min(maxSteps, Math.max(4, Math.ceil(totalSpan / stepMs)));

  // Bucket by step. Drum hits within the same step (regardless of
  // slot) all live in the same bucket — kick + hat fired together
  // is a drum chord. Different slots in the same bucket → extras.
  // Same-slot duplicates within a step → louder wins.
  const buckets = new Array(totalSteps).fill(null).map(() => []);
  for (const n of drumNotes) {
    const exactStep = n.t / stepMs;
    const step = Math.min(totalSteps - 1, Math.round(exactStep));
    const tOffset = Math.max(-0.49, Math.min(0.49, exactStep - step));
    const existing = buckets[step].find(x => x.slot === n.slot);
    if (existing) {
      if (existing.velocity < n.velocity) {
        existing.velocity = n.velocity;
        existing.tOffset = tOffset;
        existing.t = n.t;
      }
    } else {
      buckets[step].push({ slot: n.slot, velocity: n.velocity, tOffset, t: n.t });
    }
  }
  while (buckets.length > 1 && buckets[buckets.length - 1].length === 0) buckets.pop();

  const pattern = buckets.map((bucket) => {
    if (bucket.length === 0) return { drumSlot: 0, velocity: 0, duration: 1.0 };
    // Loudest hit is the primary; others ride along as extras.
    bucket.sort((a, b) => b.velocity - a.velocity);
    const primary = bucket[0];
    const step = {
      drumSlot: primary.slot,
      velocity: Math.max(0.3, Math.min(1.0, primary.velocity * 1.3)),
      duration: 1.0,
      tOffset: primary.tOffset,
    };
    if (bucket.length > 1) {
      step.extras = bucket.slice(1).map(b => ({
        drumSlot: b.slot,
        velocity: Math.max(0.3, Math.min(1.0, b.velocity * 1.3)),
        duration: 1.0,
      }));
    }
    return step;
  });

  // Plant position: bottom-left area where demos put drums.
  const n = seeds.filter(s => s.kind === 'voice').length;
  const cx = 220 + (n % 3) * 140 + 30 * Math.random();
  const cy = 600 + 30 * Math.random();

  // Use the loudest drum's colour as the seed colour; label lists
  // every kit slot used so the user can tell what's in the loop.
  const slotsUsed = [...new Set(drumNotes.map(n => n.slot))];
  const loudest = drumNotes.reduce((a, b) => a.velocity > b.velocity ? a : b).slot;
  const color = DRUM_KIT_COLOURS[loudest] || '#aaaaaa';
  const slotsLabel = slotsUsed.map(s => DRUM_KIT[s].name).join('+');

  const seed = makeSeed({
    cx, cy,
    r: 50,
    fundamental: 220,                 // unused for drum-kit; kept for shape
    decay: BAR_MS / 4,
    intervalMs: stepMs,
    harmonics: new Array(NUM_HARMONICS).fill(0),
    color,
    label: 'drums · ' + slotsLabel,
    pattern,
    quantize: true,
    role: 'drumkit',
    // Marker patch: scheduler sees patch.category === 'drum-kit' and
    // dispatches each step to DRUM_KIT[step.drumSlot] instead of
    // using seed.patch directly.
    patch: { category: 'drum-kit', layers: [] },
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
  takeSnapshot('recorded drums · ' + slotsLabel);
}

document.getElementById('rec-btn').addEventListener('click', async () => {
  await initAudio();
  if (state.isRecording) finishRecording();
  else startRecording();
});
