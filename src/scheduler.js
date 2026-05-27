// Audio scheduler + RAF visual tick.
//
// Two loops run together:
//   scheduleAhead (setInterval 25ms) — schedules audio events 100ms
//     ahead of currentTime. Reads seed timing, swing, polyrhythm.
//   visualTick (requestAnimationFrame) — pulses seed nodes, renders
//     chord outlines, advances pulse / sweep lifecycle, paints them.
//
// The two loops are decoupled at the rate level (audio uses ctx time,
// visuals use perf.now) but both iterate the same seed list.
//
// `highlightCurrentStep` is bound at runtime by inspector.js via
// setStepHighlightHandler — keeps the scheduler agnostic of the
// inspector module.

import { freqFromMidi, midiFromFreq, snapToScale } from './constants.js';
import { audioCtx } from './audio/context.js';
import { playPatch } from './audio/voices.js';
import { patchFromLegacySeed } from './audio/patches.js';
import {
  routeFinalOutput, PULSE_KINDS, SWEEP_KINDS, pulseCurrentRadius,
} from './audio/events.js';
import { seeds, activeEvents, state, seedById } from './state.js';
import {
  SVGNS, seedNodes, blobPath, renderSeed,
} from './seeds.js';

let stepHighlightHandler = null;
export function setStepHighlightHandler(fn) { stepHighlightHandler = fn; }

export function playNoteAt(seed, when, freq, gain, sustainMs) {
  // All seeds dispatch through the patch player. Drums (category 'drum')
  // are one-shot inside playPatch; tonal patches get attack → sustain
  // → release shaped by patch.envelope.
  const patch = seed.patch || patchFromLegacySeed(seed);
  // If a tonal seed has a legacy `decay` that differs from the patch's
  // releaseMs (e.g. user adjusted the length knob), prefer the live
  // seed value so inspector tweaks keep working post-refactor.
  if (patch.category !== 'drum' && seed.decay) {
    patch.envelope = patch.envelope || {};
    if (patch.envelope.releaseMs !== seed.decay) {
      patch.envelope = { ...patch.envelope, releaseMs: seed.decay };
      seed._cachedPatch = patch;
    }
  }
  playPatch(patch, when, freq, gain, sustainMs, (n) => routeFinalOutput(seed, n));
  seed.lastPulseAt = when;
}

export function playSeedStep(seed, when) {
  if (!seed.pattern || seed.pattern.length === 0) {
    playNoteAt(seed, when, seed.fundamental, seed.gain || 0.35);
    return;
  }
  const stepIdx = seed.patternIdx % seed.pattern.length;
  const step = seed.pattern[stepIdx];
  // Monotonic increment (no modulo here). Pattern lookup wraps via
  // modulo on read. Keeping patternIdx monotonic is what lets the
  // master beat clock formula (see stepFireOffset below) compute each
  // step's fire time fresh from playbackStartTime, never accumulating
  // drift across thousands of steps.
  seed.patternIdx++;
  const delayMs = Math.max(0, (when - audioCtx.currentTime) * 1000);
  setTimeout(() => {
    seed.currentStep = stepIdx;
    if (state.selectedSeedId === seed.id && stepHighlightHandler) stepHighlightHandler(seed);
  }, delayMs);
  if (step.velocity < 0.05) return;
  const baseMidi = midiFromFreq(seed.fundamental);
  const baseGain = seed.gain || 0.35;
  const targetMidi = baseMidi + (step.offset || 0);
  // seed.quantize gates two things: pitch snap-to-scale AND micro-
  // timing snap to the grid step. tOffset (set at record time) holds
  // the original off-grid displacement; honour it only when quantize
  // is off so the user can switch between clean-grid and as-played.
  const finalMidi = seed.quantize ? snapToScale(targetMidi) : targetMidi;
  const freq = freqFromMidi(finalMidi);
  // sustainMs MUST be a number for scheduled notes — undefined makes
  // playPatch fall through to live mode, which never schedules voice
  // stops and leaves oscillators running forever. Default to 1.0
  // step-fractions so a pattern step with no explicit duration takes
  // a full step's worth of time and self-terminates cleanly.
  const stepDuration = step.duration !== undefined ? step.duration : 1.0;
  const sustainMs = stepDuration * seed.intervalMs;
  // tOffset is in fractions of a step (range ~[-0.5, +0.5]).
  // Convert to seconds and add to the fire time. Quantize on = ignore.
  let fireAt = when;
  if (!seed.quantize && step.tOffset) {
    fireAt = when + (step.tOffset * seed.intervalMs) / 1000;
  }
  playNoteAt(seed, fireAt, freq, baseGain * step.velocity, sustainMs);
  if (step.extras && step.extras.length > 0) {
    for (const ex of step.extras) {
      const exMidi = baseMidi + (ex.offset || 0);
      const exFinalMidi = seed.quantize ? snapToScale(exMidi) : exMidi;
      const exFreq = freqFromMidi(exFinalMidi);
      const exDuration = ex.duration !== undefined ? ex.duration : stepDuration;
      const exSustainMs = exDuration * seed.intervalMs;
      // Chord extras fire at the SAME time as the primary — share fireAt so
      // an unquantized chord stays coherent.
      playNoteAt(seed, fireAt, exFreq, baseGain * (ex.velocity !== undefined ? ex.velocity : step.velocity), exSustainMs);
    }
    // Record this chord step for blob visualisation. Only chord steps
    // trigger outlines — single-note steps stay represented by the
    // seed body alone.
    if (!seed._chordVoices) seed._chordVoices = [];
    const sustainSec = (sustainMs !== undefined ? sustainMs : seed.decay) / 1000;
    const releaseSec = seed.decay / 1000;
    seed._chordVoices.push({
      offset: step.offset || 0,
      startedAt: when,
      sustainSec,
      releaseSec,
    });
    for (const ex of step.extras) {
      const exSusSec = (ex.duration !== undefined ? ex.duration * seed.intervalMs : sustainMs) / 1000;
      seed._chordVoices.push({
        offset: ex.offset || 0,
        startedAt: when,
        sustainSec: exSusSec || sustainSec,
        releaseSec,
      });
    }
    if (seed._chordVoices.length > 30) {
      seed._chordVoices = seed._chordVoices.slice(-30);
    }
  }
}

// Master beat clock — fire-time offset from playbackStartTime for
// step N of a seed, given its baseInterval (seconds) and swing
// (0.5 = straight, > 0.5 = late offbeat). Computed fresh per step
// instead of incrementally accumulated, so floating-point drift
// can't pile up over a long session and seeds at the same rhythm
// stay perfectly locked to each other forever.
//
// Derivation: even step k fires at k*baseInterval. Odd step k fires
// at k*baseInterval + (2*swing - 1)*baseInterval (the offbeat shift).
// Identity check: for swing=0.5 both branches collapse to k*bI; for
// swing=0.75 odd steps land 1.5*bI after the previous even step, as
// the old incremental code did.
function stepFireOffset(stepIdx, baseInterval, swing) {
  const offbeat = (stepIdx % 2 === 1) ? (2 * swing - 1) * baseInterval : 0;
  return stepIdx * baseInterval + offbeat;
}

export function scheduleAhead() {
  if (!audioCtx || !state.isPlaying) return;
  const now = audioCtx.currentTime;
  const lookahead = 0.10;
  for (const seed of seeds) {
    if (seed.kind !== 'voice') continue;
    let baseInterval = seed.intervalMs / 1000;
    let swing = 0.5;
    // Iterate all capturing modifiers. Polyrhythm scales interval,
    // weave sets swing. Multiple polys multiply; last weave wins.
    if (seed.capturedByIds && seed.capturedByIds.size > 0) {
      for (const id of seed.capturedByIds) {
        const m = seedById(id);
        if (!m) continue;
        if (m.modifierKind === 'poly' && m.polyFactor) baseInterval *= m.polyFactor;
        if (m.modifierKind === 'weave' && m.swing) swing = m.swing;
      }
    }

    // Catch-up logic: if we're way behind (just started / playback
    // start was moved), advance patternIdx to the next slot. For
    // quantized seeds, snap to the grid boundary; for free-running
    // seeds, anchor patternIdx to "as close to now as the formula
    // allows" by computing what step would fire next.
    if (seed.nextTrigger && seed.nextTrigger < now - 1) {
      if (seed.quantize) {
        const since = now - state.playbackStartTime;
        seed.patternIdx = Math.max(0, Math.ceil(since / baseInterval));
      } else {
        // Free-running: re-anchor playbackStartTime so step
        // `patternIdx` fires ~now. This is the equivalent of the old
        // `nextTrigger = now + 0.04` snap.
        state.playbackStartTime = now + 0.04 - stepFireOffset(seed.patternIdx, baseInterval, swing);
      }
    }

    // Schedule every step whose fire time falls inside our lookahead
    // window. fireTime is derived fresh from patternIdx each loop —
    // no incremental accumulation, no drift.
    while (true) {
      const fireTime = state.playbackStartTime + stepFireOffset(seed.patternIdx, baseInterval, swing);
      if (fireTime >= now + lookahead) {
        seed.nextTrigger = fireTime;  // kept for diagnostic / catch-up logic
        break;
      }
      if (fireTime < now - 1) {
        // Edge case: a single step is more than 1s in the past.
        // Skip past it without playing — happens on tab-throttle return.
        seed.patternIdx++;
        continue;
      }
      if (!seed.muted) {
        playSeedStep(seed, fireTime);
      } else {
        seed.patternIdx++;
      }
    }
  }
}
setInterval(scheduleAhead, 25);

function visualTick() {
  const now = audioCtx ? audioCtx.currentTime : 0;
  for (const seed of seeds) {
    const node = seedNodes.get(seed.id);
    if (!node) continue;
    if (seed.kind === 'modifier') continue;
    let pulseScale = 1;
    if (seed.lastPulseAt) {
      const since = now - seed.lastPulseAt;
      const pulse = Math.max(0, Math.exp(-since * 6) - 0.05);
      pulseScale = 1 + 0.14 * pulse;
    }
    node.core.style.transform = `scale(${pulseScale})`;
    node.halo.style.transform = `scale(${pulseScale * 1.05})`;
    node.halo.style.opacity = (0.35 + 0.3 * (pulseScale - 1) / 0.14).toFixed(2);
    renderChordOutlines(seed, node, now);
  }
  updateEvents();
  renderEvents();
  requestAnimationFrame(visualTick);
}
requestAnimationFrame(visualTick);

// Each chord voice fades through attack → sustain → release.
function renderChordOutlines(seed, node, audioNow) {
  if (!node.chordLayer) return;
  const isDrum = seed.synthesisModel === 'kick' || seed.synthesisModel === 'snare' || seed.synthesisModel === 'hihat';
  if (isDrum) {
    if (node.chordLayer.childNodes.length > 0) node.chordLayer.innerHTML = '';
    return;
  }
  if (!seed._chordVoices || seed._chordVoices.length === 0) {
    if (node.chordLayer.childNodes.length > 0) node.chordLayer.innerHTML = '';
    return;
  }
  seed._chordVoices = seed._chordVoices.filter(v => {
    const elapsed = audioNow - v.startedAt;
    return elapsed < v.sustainSec + v.releaseSec + 0.05;
  });
  node.chordLayer.innerHTML = '';
  for (const v of seed._chordVoices) {
    const elapsed = audioNow - v.startedAt;
    if (elapsed < 0) continue;
    let opacity;
    if (elapsed < 0.04) opacity = elapsed / 0.04;
    else if (elapsed < v.sustainSec) opacity = 1;
    else opacity = Math.max(0, 1 - (elapsed - v.sustainSec) / v.releaseSec);
    if (opacity <= 0.01) continue;
    const scale = Math.max(0.35, Math.min(1.4, 1 - v.offset * 0.04));
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', blobPath(seed.cx, seed.cy, seed.r * scale, seed.harmonics));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', seed.color);
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-opacity', (opacity * 0.85).toFixed(2));
    node.chordLayer.appendChild(path);
  }
}

const ECHO_MS = 500;

function updateEvents() {
  const tnow = performance.now();
  for (let i = activeEvents.length - 1; i >= 0; i--) {
    const ev = activeEvents[i];
    if (ev.type === 'pulse') {
      if (ev.state === 'expanding') {
        const elapsed = tnow - ev.startTimeMs;
        const r = pulseCurrentRadius(ev);
        for (const seed of seeds) {
          if (seed.kind !== 'voice') continue;
          if (Math.hypot(seed.cx - ev.cx, seed.cy - ev.cy) <= r) {
            ev.affectedSeedIds.add(seed.id);
          }
        }
        if (elapsed >= ev.durationMs) {
          ev.state = 'popped';
          ev.popTimeMs = tnow;
          if (ev.filterNode) {
            try { ev.filterNode.disconnect(); } catch (e) {}
          }
          for (const id of ev.affectedSeedIds) {
            const s = seedById(id);
            if (s) {
              s._echoUntil = tnow + ECHO_MS;
              s._echoColor = ev.color;
            }
          }
        }
      } else if (ev.state === 'popped') {
        if (tnow - ev.popTimeMs > ECHO_MS + 50) activeEvents.splice(i, 1);
      }
    } else if (ev.type === 'sweep') {
      if (ev.state === 'active') {
        const elapsed = tnow - ev.startTimeMs;
        const phase = Math.min(1, elapsed / ev.durationMs);
        const dx = ev.x1 - ev.x0;
        const dy = ev.y1 - ev.y0;
        const lenSq = dx*dx + dy*dy || 1;
        const def = SWEEP_KINDS[ev.kind];
        for (const seed of seeds) {
          if (seed.kind !== 'voice') continue;
          if (ev.affectedSeedIds.has(seed.id)) continue;
          const t = ((seed.cx - ev.x0) * dx + (seed.cy - ev.y0) * dy) / lenSq;
          if (t <= phase && t <= 1) {
            ev.affectedSeedIds.add(seed.id);
            if (def.action === 'mute') seed.muted = true;
            else if (def.action === 'unmute') seed.muted = false;
            seed._echoUntil = tnow + ECHO_MS;
            seed._echoColor = ev.color;
            renderSeed(seed);  // refresh dim state immediately
          }
        }
        if (elapsed >= ev.durationMs) {
          ev.state = 'done';
          ev.doneTimeMs = tnow;
        }
      } else if (ev.state === 'done') {
        if (tnow - ev.doneTimeMs > 400) activeEvents.splice(i, 1);
      }
    }
  }
}

const eventsLayer = document.getElementById('events-layer');
function renderEvents() {
  eventsLayer.innerHTML = '';
  const tnow = performance.now();
  for (const ev of activeEvents) {
    if (ev.type === 'pulse') {
      if (ev.state === 'expanding') {
        const r = pulseCurrentRadius(ev);
        const fill = document.createElementNS(SVGNS, 'circle');
        fill.setAttribute('cx', ev.cx); fill.setAttribute('cy', ev.cy);
        fill.setAttribute('r', r);
        fill.setAttribute('fill', ev.color);
        fill.setAttribute('fill-opacity', 0.12);
        eventsLayer.appendChild(fill);
        const ring = document.createElementNS(SVGNS, 'circle');
        ring.setAttribute('cx', ev.cx); ring.setAttribute('cy', ev.cy);
        ring.setAttribute('r', r);
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke', ev.color);
        ring.setAttribute('stroke-width', 3);
        ring.setAttribute('stroke-opacity', 0.85);
        eventsLayer.appendChild(ring);
      } else if (ev.state === 'popped') {
        const since = tnow - ev.popTimeMs;
        const popPhase = Math.min(1, since / 250);
        if (popPhase < 1) {
          const burst = document.createElementNS(SVGNS, 'circle');
          burst.setAttribute('cx', ev.cx); burst.setAttribute('cy', ev.cy);
          burst.setAttribute('r', ev.maxRadius * (1 + popPhase * 0.15));
          burst.setAttribute('fill', 'none');
          burst.setAttribute('stroke', ev.color);
          burst.setAttribute('stroke-width', 4 * (1 - popPhase));
          burst.setAttribute('stroke-opacity', 1 - popPhase);
          eventsLayer.appendChild(burst);
        }
      }
    } else if (ev.type === 'sweep') {
      const dx = ev.x1 - ev.x0;
      const dy = ev.y1 - ev.y0;
      const len = Math.hypot(dx, dy) || 1;
      const dxn = dx / len, dyn = dy / len;
      const perpX = -dyn, perpY = dxn;
      let phase;
      if (ev.state === 'active') phase = Math.min(1, (tnow - ev.startTimeMs) / ev.durationMs);
      else phase = 1;
      const wfX = ev.x0 + dx * phase;
      const wfY = ev.y0 + dy * phase;
      const EXT = 2000;
      const a0x = ev.x0 + perpX * EXT, a0y = ev.y0 + perpY * EXT;
      const a1x = ev.x0 - perpX * EXT, a1y = ev.y0 - perpY * EXT;
      const w0x = wfX + perpX * EXT,   w0y = wfY + perpY * EXT;
      const w1x = wfX - perpX * EXT,   w1y = wfY - perpY * EXT;
      const trail = document.createElementNS(SVGNS, 'polygon');
      trail.setAttribute('points',
        `${a0x.toFixed(1)},${a0y.toFixed(1)} ${a1x.toFixed(1)},${a1y.toFixed(1)} ${w1x.toFixed(1)},${w1y.toFixed(1)} ${w0x.toFixed(1)},${w0y.toFixed(1)}`);
      trail.setAttribute('fill', ev.color);
      trail.setAttribute('fill-opacity', ev.state === 'active' ? 0.10 : 0.05);
      eventsLayer.appendChild(trail);
      if (ev.state === 'active') {
        const line = document.createElementNS(SVGNS, 'line');
        line.setAttribute('x1', w0x.toFixed(1)); line.setAttribute('y1', w0y.toFixed(1));
        line.setAttribute('x2', w1x.toFixed(1)); line.setAttribute('y2', w1y.toFixed(1));
        line.setAttribute('stroke', ev.color);
        line.setAttribute('stroke-width', 3);
        line.setAttribute('stroke-opacity', 0.85);
        eventsLayer.appendChild(line);
      }
    }
  }

  // Live preview during sweep drag (state.sweepDrag is set by input/pointer.js)
  if (state.sweepDrag) {
    const sd = state.sweepDrag;
    const def = SWEEP_KINDS[sd.kind];
    const color = def ? def.color : '#ffffff';
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', sd.x0); line.setAttribute('y1', sd.y0);
    line.setAttribute('x2', sd.x1); line.setAttribute('y2', sd.y1);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', 2);
    line.setAttribute('stroke-dasharray', '6 4');
    line.setAttribute('stroke-opacity', 0.7);
    eventsLayer.appendChild(line);
    for (const pt of [[sd.x0, sd.y0], [sd.x1, sd.y1]]) {
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('cx', pt[0]); dot.setAttribute('cy', pt[1]);
      dot.setAttribute('r', 5);
      dot.setAttribute('fill', color);
      dot.setAttribute('fill-opacity', 0.8);
      eventsLayer.appendChild(dot);
    }
  }

  // Echo halos on seeds (shared between pulse and sweep effects)
  for (const seed of seeds) {
    if (seed.kind !== 'voice') continue;
    if (!seed._echoUntil || tnow > seed._echoUntil) continue;
    const remaining = seed._echoUntil - tnow;
    const phase = 1 - (remaining / ECHO_MS);
    const haloR = seed.r * 1.5 + phase * 40;
    const halo = document.createElementNS(SVGNS, 'circle');
    halo.setAttribute('cx', seed.cx); halo.setAttribute('cy', seed.cy);
    halo.setAttribute('r', haloR);
    halo.setAttribute('fill', 'none');
    halo.setAttribute('stroke', seed._echoColor || '#ffffff');
    halo.setAttribute('stroke-width', 3 * (1 - phase));
    halo.setAttribute('stroke-opacity', (1 - phase) * 0.9);
    eventsLayer.appendChild(halo);
  }
}
