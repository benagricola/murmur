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

import { freqFromMidi, midiFromFreq } from './constants.js';
import { audioCtx } from './audio/context.js';
import { playPatch } from './audio/voices.js';
import { patchFromLegacySeed } from './audio/patches.js';
import {
  routeFinalOutput, PULSE_KINDS, SWEEP_KINDS, pulseCurrentRadius, pulseEffectIntensity,
} from './audio/events.js';
import { seeds, activeEvents, state, seedById } from './state.js';
import { BAR_MS } from './tempo.js';
import {
  SVGNS, seedNodes, blobPath, renderSeed, renderTethers, animateTethers,
  updateSphereTransforms, auraIntensityForSeed, renderRunnerTendrils,
} from './seeds.js';
import { auraGainDefault, auraModTargets } from './auras/registry.js';
import { DRUM_KIT, DRUM_KIT_FUNDAMENTAL_HZ } from './audio/drum-kit.js';
import { refreshTooltip as refreshAuraTooltip } from './aura-tooltip.js';

let stepHighlightHandler = null;
export function setStepHighlightHandler(fn) { stepHighlightHandler = fn; }

export function playNoteAt(seed, when, freq, gain, sustainMs, patchOverride) {
  // Runner pitch modulation: a tendril targeting this seed's pitch sets
  // _pitchMod (cents) each frame; we apply it per note at fire time (the
  // note keeps that pitch — successive notes track the LFO, which reads
  // as vibrato at musical rates).
  if (seed._pitchMod) freq *= Math.pow(2, seed._pitchMod / 1200);
  // All seeds dispatch through the patch player. Drums (category 'drum')
  // are one-shot inside playPatch; tonal patches get attack → sustain
  // → release shaped by patch.envelope.
  //
  // patchOverride lets drum-kit seeds (one seed → many drum patches,
  // one per pattern step) supply the per-step DRUM_KIT patch without
  // mutating seed.patch.
  const patch = patchOverride || seed.patch || patchFromLegacySeed(seed);
  // If a tonal seed has a legacy `decay` that differs from the patch's
  // releaseMs (e.g. user adjusted the length knob), prefer the live
  // seed value so inspector tweaks keep working post-refactor.
  if (!patchOverride && patch.category !== 'drum' && seed.decay) {
    patch.envelope = patch.envelope || {};
    if (patch.envelope.releaseMs !== seed.decay) {
      patch.envelope = { ...patch.envelope, releaseMs: seed.decay };
      seed._cachedPatch = patch;
    }
  }
  // tag = seed.id so removeSeed can force-stop all in-flight audio
  // from a deleted seed instead of letting envelopes ring out.
  playPatch(patch, when, freq, gain, sustainMs, (n) => routeFinalOutput(seed, n), seed.id);
  seed.lastPulseAt = when;
}

// Weighted-roll a new patternBank entry for the seed if the dice
// fall the right way. Switch probability = base 5% + sum of shift-aura
// intensities at the seed's position, clamped to 1.0. When switching
// we exclude the current variant from the weighted pool so we never
// "switch to the same thing" — sterile if the bank only has 2
// variants and the dice would otherwise stick.
const PATTERN_SWITCH_BASE_PROB = 0.05;
function maybeRollPatternBank(seed) {
  const bank = seed.patternBank;
  if (!bank || bank.length < 2) return;
  let shiftBoost = 0;
  for (const m of seeds) {
    if (m.kind !== 'modifier' || m.modifierKind !== 'shift') continue;
    shiftBoost += auraIntensityForSeed(m, seed);
  }
  const prob = Math.min(1, PATTERN_SWITCH_BASE_PROB + shiftBoost);
  if (Math.random() >= prob) return;
  // Weighted pick from all entries except the current one.
  let total = 0;
  for (let i = 0; i < bank.length; i++) {
    if (i === seed.patternBankIdx) continue;
    total += (bank[i].weight != null ? bank[i].weight : 1);
  }
  if (total <= 0) return;
  let r = Math.random() * total;
  let pickIdx = -1;
  for (let i = 0; i < bank.length; i++) {
    if (i === seed.patternBankIdx) continue;
    r -= (bank[i].weight != null ? bank[i].weight : 1);
    if (r <= 0) { pickIdx = i; break; }
  }
  if (pickIdx < 0) return;
  seed.patternBankIdx = pickIdx;
  seed.pattern = bank[pickIdx].steps;
  // Inspector listens so the pattern editor + variation badge refresh
  // when a switch happens while the seed is being viewed.
  window.dispatchEvent(new CustomEvent('pattern-bank-switch', { detail: { seedId: seed.id } }));
}

export function playSeedStep(seed, when) {
  if (!seed.pattern || seed.pattern.length === 0) {
    playNoteAt(seed, when, seed.fundamental, seed.gain || 0.35);
    return;
  }
  const stepIdx = seed.patternIdx % seed.pattern.length;
  // Pattern-bank roll fires at the LOOP BOUNDARY (step 0, after the
  // first loop). Higher chance under a shift aura — at full intensity
  // the seed switches every loop; with no aura the bank's base
  // tendency is gentle (~5%) so multi-variant seeds get the occasional
  // organic change without constant churn.
  if (stepIdx === 0 && seed.patternIdx > 0
      && seed.patternBank && seed.patternBank.length > 1) {
    maybeRollPatternBank(seed);
  }
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
  const baseGain = seed.gain || 0.35;
  const stepDuration = step.duration !== undefined ? step.duration : 1.0;
  const sustainMs = stepDuration * seed.intervalMs;
  let fireAt = when;
  if (!seed.quantize && step.tOffset) {
    fireAt = when + (step.tOffset * seed.intervalMs) / 1000;
  }

  // === Drum-kit branch ===
  // Step references a DRUM_KIT slot — fire that slot's patch instead
  // of seed.patch. Extras may reference different slots (kick + hat
  // together), all fired at the same fireAt.
  if (step.drumSlot != null) {
    const slot = DRUM_KIT[step.drumSlot];
    if (slot && slot.patch) {
      const slotFreq = DRUM_KIT_FUNDAMENTAL_HZ[step.drumSlot] || 220;
      playNoteAt(seed, fireAt, slotFreq, baseGain * step.velocity, sustainMs, slot.patch);
    }
    if (step.extras && step.extras.length > 0) {
      for (const ex of step.extras) {
        const exSlot = DRUM_KIT[ex.drumSlot];
        if (!exSlot || !exSlot.patch) continue;
        const exFreq = DRUM_KIT_FUNDAMENTAL_HZ[ex.drumSlot] || 220;
        const exDuration = ex.duration !== undefined ? ex.duration : stepDuration;
        const exSustainMs = exDuration * seed.intervalMs;
        const exVel = ex.velocity !== undefined ? ex.velocity : step.velocity;
        playNoteAt(seed, fireAt, exFreq, baseGain * exVel, exSustainMs, exSlot.patch);
      }
    }
    return;
  }

  // === Tonal branch (default) ===
  // Pitch is always faithful to the recorded / authored offset — the
  // offset encodes the exact interval the user played. seed.quantize is
  // a TIMING toggle only (it gates the micro-timing tOffset above); it
  // must NOT snap pitch, or an off-scale note the user played gets
  // pulled to the nearest scale tone on playback.
  const baseMidi = midiFromFreq(seed.fundamental);
  const finalMidi = baseMidi + (step.offset || 0);
  const freq = freqFromMidi(finalMidi);
  playNoteAt(seed, fireAt, freq, baseGain * step.velocity, sustainMs);
  if (step.extras && step.extras.length > 0) {
    for (const ex of step.extras) {
      const exFinalMidi = baseMidi + (ex.offset || 0);
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
    // Proximity-graded aura effects. Walk every modifier on the canvas,
    // compute its intensity at this seed's position (0 at edge / outside,
    // up to 1 at the centre — modulated by the aura's falloff curve and
    // edge/centre intensity values). Apply each effect scaled by its
    // intensity:
    //   poly  → multiplicatively scale baseInterval toward polyFactor
    //   weave → intensity-weighted blend of swing values across overlapping
    //           weave auras
    // ripple/cloud sends are handled in routeFinalOutput at note-route time.
    let weaveBlendNum = 0, weaveBlendDen = 0;
    for (const m of seeds) {
      if (m.kind !== 'modifier') continue;
      const intensity = auraIntensityForSeed(m, seed);
      if (intensity < 0.001) continue;
      if (m.modifierKind === 'poly' && m.polyFactor) {
        baseInterval *= 1 + (m.polyFactor - 1) * intensity;
      } else if (m.modifierKind === 'weave' && m.swing != null) {
        weaveBlendNum += m.swing * intensity;
        weaveBlendDen += intensity;
      }
    }
    if (weaveBlendDen > 0) {
      const avgSwing = weaveBlendNum / weaveBlendDen;
      const i = Math.min(1.0, weaveBlendDen);
      swing = 0.5 + (avgSwing - 0.5) * i;
    }

    // Per-seed fire anchor. fireTime = _fireAnchor + stepFireOffset(idx).
    //
    // Re-anchor (recompute the anchor from scratch) when the seed is
    // fresh or its nextTrigger went stale / was cleared (rhythm change,
    // tempo change, play start). Without that, changing the rhythm
    // picker mid-play left patternIdx pointing at a far-future fireTime
    // and the seed went silent.
    //
    // Crucially, ALSO re-anchor when the effective interval or swing
    // changes — which is what a vine (poly) or weave aura does to a
    // captured seed as it drifts through the field. fireTime scales the
    // MONOTONIC patternIdx by the interval, so a change of Δinterval
    // shifts the current step by patternIdx × Δinterval (seconds, once
    // patternIdx is large). That made a seed leaving a vine jump far
    // into the future — a long silent pause. Here we shift the anchor
    // so the CURRENT step holds its fire time and only LATER steps
    // re-space at the new rate: a smooth tempo glide, no discontinuity.
    if (seed._fireAnchor == null && seed.nextTrigger && seed.nextTrigger >= now - 1) {
      // First scheduler pass on a seed whose (patternIdx, nextTrigger)
      // was set externally to mean "fire THIS step at THIS time" — e.g.
      // a fresh recording snapped to the next bar. Derive the anchor so
      // that exact fire time is honoured.
      seed._fireAnchor = seed.nextTrigger - stepFireOffset(seed.patternIdx, baseInterval, swing);
      seed._lastInterval = baseInterval;
      seed._lastSwing = swing;
    } else if (!seed.nextTrigger || seed.nextTrigger < now - 1 || seed._fireAnchor == null) {
      // (Re)derive from the global grid: a brand-new seed, or one whose
      // nextTrigger went stale / was cleared (rhythm change, tempo
      // change, play start). Without this, changing the rhythm picker
      // mid-play left patternIdx pointing at a far-future fireTime and
      // the seed went silent.
      if (seed.quantize) {
        const since = now - state.playbackStartTime;
        seed.patternIdx = Math.max(0, Math.ceil(since / baseInterval));
        seed._fireAnchor = state.playbackStartTime;
      } else {
        seed._fireAnchor = now + 0.04 - stepFireOffset(seed.patternIdx, baseInterval, swing);
      }
      seed._lastInterval = baseInterval;
      seed._lastSwing = swing;
    } else if (Math.abs(baseInterval - seed._lastInterval) > 1e-9 ||
               Math.abs(swing - seed._lastSwing) > 1e-9) {
      // Effective interval/swing changed while playing — a captured
      // seed drifting through a vine (poly) or weave aura, or a global
      // tempo change. Shift the anchor so the CURRENT step keeps its
      // fire time and only LATER steps re-space at the new rate. The
      // old code recomputed fireTime as playbackStartTime + patternIdx ×
      // interval, so any Δinterval moved the current step by patternIdx
      // × Δinterval — seconds once patternIdx was large — making a seed
      // leaving a vine jump far into the future (the silent pause).
      seed._fireAnchor += stepFireOffset(seed.patternIdx, seed._lastInterval, seed._lastSwing)
                        - stepFireOffset(seed.patternIdx, baseInterval, swing);
      seed._lastInterval = baseInterval;
      seed._lastSwing = swing;
    }

    // Schedule every step whose fire time falls inside our lookahead
    // window. fireTime is derived fresh from patternIdx each loop —
    // no incremental accumulation, no drift.
    //
    // Non-looping seeds (seed.loop === false) play through their
    // pattern exactly once per play-start, then stay silent. The
    // play-button handler in transport.js resets patternIdx to 0 on
    // every play, so each press re-triggers the one-shot.
    while (true) {
      if (seed.loop === false && seed.patternIdx >= seed.pattern.length) break;
      const fireTime = seed._fireAnchor + stepFireOffset(seed.patternIdx, baseInterval, swing);
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

// === Physics: soft mass-aware repulsion + canvas-edge reflection ===
// Each tick computes per-seed velocity from nearby-seed repulsion +
// canvas-edge bounce, scales by 1/mass, damps, integrates position.
// Damping (~0.85/tick) means things settle if not actively pushed —
// the canvas isn't a perpetual chaos. Auras (modifiers) have high
// mass so they barely budge but still get nudged a tiny bit on
// collision; if we want them strictly immovable later we can clamp
// their velocity to 0 directly.
//
// Currently-dragged seed is exempt — physics doesn't fight a drag.
const CANVAS_W = 1400, CANVAS_H = 800;
const CANVAS_MARGIN = 24;
const PHYSICS_DAMPING = 0.85;
const PHYSICS_MAX_V = 4.0;
let draggedSeedId = null;
export function setDraggedSeed(id) { draggedSeedId = id; }

function duckSeed(seed) {
  if (!seed.postGain || !audioCtx) return;
  const now = audioCtx.currentTime;
  const g = seed.postGain.gain;
  try {
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0.35, now + 0.008);   // dip
    g.linearRampToValueAtTime(1.0,  now + 0.18);    // recover
  } catch (e) {}
}

// Exported so demo / future bulk-plant code can pre-settle layouts
// before the user sees them — call settlePhysics(40) right after
// planting and the seeds will have separated into a stable
// configuration by the time anything renders.
export function settlePhysics(iterations = 40) {
  for (let i = 0; i < iterations; i++) physicsStep(true);
}

function physicsStep(silent) {
  const tnow = performance.now();
  // Compute repulsion forces. O(N²) but N is small (~25 worst case).
  for (const a of seeds) {
    if (a.id === draggedSeedId) continue;
    let fx = 0, fy = 0;
    let maxImpactForce = 0;
    let impactPartner = null;
    // Wanderlust drift with INERTIAL direction changes. The seed
    // picks a new TARGET direction at random intervals, but the
    // applied force direction rotates smoothly TOWARD the target
    // rather than snapping. Combined with mass and damping this
    // gives a sweeping, swimmy quality — heavy seeds especially
    // glide rather than tic-tac.
    if (a.wanderlust > 0) {
      if (a._wanderUntil == null || tnow > a._wanderUntil) {
        a._wanderTargetTheta = Math.random() * Math.PI * 2;
        // Longer hold for low-wanderlust seeds (more committed
        // direction). Heavier seeds also get longer holds — heft
        // implies persistence.
        const changeMs = (1200 + (1 - a.wanderlust) * 2500) * (0.7 + 0.3 * (a.mass || 1));
        a._wanderUntil = tnow + changeMs;
      }
      if (a._wanderTheta == null) a._wanderTheta = a._wanderTargetTheta;
      // Smoothly rotate current direction toward target. The rate
      // scales with wanderlust — restless seeds change quicker —
      // but it's an angular SLERP, not an instant change.
      const dTheta = ((a._wanderTargetTheta - a._wanderTheta + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      a._wanderTheta += dTheta * (0.008 + 0.025 * a.wanderlust);
      // Force is smaller than before (was 0.12) so seeds GLIDE
      // rather than skitter. Inertia carries them between target
      // reseeds.
      const wf = 0.08 * a.wanderlust;
      fx += Math.cos(a._wanderTheta) * wf;
      fy += Math.sin(a._wanderTheta) * wf;
    }
    for (const b of seeds) {
      if (b === a) continue;
      const dx = a.cx - b.cx;
      const dy = a.cy - b.cy;
      const dist = Math.hypot(dx, dy);
      // Collision radius matches the seed's full VISUAL extent —
      // body radius × 1.3 (halo path) × 1.15 (margin for harmonic
      // perturbations) ≈ 1.5×. Previous 1.15× was body-only and let
      // halos overlap visually by ~30% before repulsion kicked in.
      const reach = (a.r + b.r) * 1.5;
      if (dist >= reach) continue;
      const overlap = reach - dist;
      // Avoid divide-by-zero for stacked seeds; pick a random push.
      let nx, ny;
      if (dist < 0.001) {
        const t = Math.random() * Math.PI * 2;
        nx = Math.cos(t); ny = Math.sin(t);
      } else {
        nx = dx / dist; ny = dy / dist;
      }
      // Stronger force (0.18 → 0.30) so overlapping bodies actually
      // separate rather than equilibrating mid-overlap when forces
      // and damping balance out.
      const force = overlap * 0.30;
      fx += nx * force;
      fy += ny * force;
      // Track strongest impact this tick — fires a duck if the
      // collision is "energetic" enough and not in cooldown.
      if (force > maxImpactForce) { maxImpactForce = force; impactPartner = b; }
    }
    // Duck on energetic collision. Cooldown prevents repeated duck
    // while two seeds are sustained-touching (e.g. just placed too
    // close and physics is gently nudging them apart).
    if (maxImpactForce > 0.6 && tnow > (a._duckUntil || 0)) {
      duckSeed(a);
      if (impactPartner) duckSeed(impactPartner);
      a._duckUntil = tnow + 250;
    }
    // Canvas-edge reflection — soft inward force when close to a wall.
    // Threshold accounts for the seed's radius so the BODY doesn't
    // extend past the canvas edge (previous behaviour let blobs poke
    // out into the top bar / timeline area). Stronger spring than
    // before — was 0.10, now 0.25 — so high-velocity items don't
    // breach the margin before the force can reverse them.
    const edge = CANVAS_MARGIN + (a.r || 0);
    if (a.cx < edge)              fx += (edge - a.cx) * 0.25;
    if (a.cx > CANVAS_W - edge)   fx -= (a.cx - (CANVAS_W - edge)) * 0.25;
    if (a.cy < edge)              fy += (edge - a.cy) * 0.25;
    if (a.cy > CANVAS_H - edge)   fy -= (a.cy - (CANVAS_H - edge)) * 0.25;
    // Integrate. a = F/m → v += a, damp v, clamp, position += v.
    const inv = 1 / (a.mass || 1);
    a.vx = ((a.vx || 0) + fx * inv) * PHYSICS_DAMPING;
    a.vy = ((a.vy || 0) + fy * inv) * PHYSICS_DAMPING;
    if (a.vx > PHYSICS_MAX_V)  a.vx = PHYSICS_MAX_V;
    if (a.vx < -PHYSICS_MAX_V) a.vx = -PHYSICS_MAX_V;
    if (a.vy > PHYSICS_MAX_V)  a.vy = PHYSICS_MAX_V;
    if (a.vy < -PHYSICS_MAX_V) a.vy = -PHYSICS_MAX_V;
  }
  // Apply integration as a second pass so all forces are computed
  // from the same configuration (no order-dependent leakage). In
  // silent mode (pre-settle) we skip the DOM updates and rely on
  // the caller to syncRenderedSeeds() at the end.
  let anyMoved = false;
  for (const a of seeds) {
    if (a.id === draggedSeedId) continue;
    if (Math.abs(a.vx) < 0.02 && Math.abs(a.vy) < 0.02) continue;
    a.cx += a.vx;
    a.cy += a.vy;
    // Hard clamp on top of the soft edge force. Belt-and-braces:
    // even if a body breaches the soft margin (e.g. dragged hard
    // by another collision), it can't escape the canvas. Zero out
    // the velocity component pushing into the wall so the seed
    // stops rather than vibrating against it.
    const hardEdge = (a.r || 0);
    if (a.cx < hardEdge)              { a.cx = hardEdge;              if (a.vx < 0) a.vx = 0; }
    if (a.cx > CANVAS_W - hardEdge)   { a.cx = CANVAS_W - hardEdge;   if (a.vx > 0) a.vx = 0; }
    if (a.cy < hardEdge)              { a.cy = hardEdge;              if (a.vy < 0) a.vy = 0; }
    if (a.cy > CANVAS_H - hardEdge)   { a.cy = CANVAS_H - hardEdge;   if (a.vy > 0) a.vy = 0; }
    anyMoved = true;
    if (!silent) {
      const node = seedNodes.get(a.id);
      if (node) renderSeed(a);
    }
  }
  if (anyMoved && !silent) {
    renderTethers();
    updateSphereTransforms();
  }
}

// Each frame, walk every voice seed and compute its net gain
// multiplier from any gain/mute auras in range. Ramp seed.auraGain
// toward that value via setTargetAtTime so the change is smooth
// even when the seed drifts in/out of the aura field. Default
// multiplier is 1.0 (no aura affecting).
function updateAuraModulation() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  for (const seed of seeds) {
    if (seed.kind !== 'voice' || !seed.auraGain) continue;
    let mult = 1.0;
    for (const m of seeds) {
      if (m.kind !== 'modifier') continue;
      if (m.modifierKind !== 'gain' && m.modifierKind !== 'mute') continue;
      const intensity = auraIntensityForSeed(m, seed);
      if (intensity < 0.001) continue;
      // gain: amount > 1 (boost). mute: amount < 1 (reduce). Resting
      // multiplier at full intensity defaults from the aura registry.
      const amount = m.gainAmount != null ? m.gainAmount : auraGainDefault(m.modifierKind);
      mult *= 1 + (amount - 1) * intensity;
    }
    // Runner volume tremolo rides on the same gain node (set in
    // updateRunnerModulation; resting 1.0 when no runner targets it).
    if (seed._modVol != null) mult *= seed._modVol;
    // Clamp to a sensible band so a stack of gain auras doesn't blow
    // up to absurd levels.
    if (mult < 0)   mult = 0;
    if (mult > 4.0) mult = 4.0;
    try { seed.auraGain.gain.setTargetAtTime(mult, now, 0.04); } catch (e) {}
  }
}

// Runner (LFO) modulation. Each runner oscillates 0..1 over its period
// (in bars, phase-locked to playbackStartTime so peaks land on the
// beat). Unlike a field aura it only affects the seeds/auras it's
// explicitly LINKED to: for each link we scale the target aura's
// `_lfoMod` between (1 - amplitude) and 1, where amplitude is the
// runner's centreIntensity. `_lfoMod` then scales that aura's effective
// intensity everywhere (auraIntensityAt), pulsing its drive/boost/send/
// poly strength. Runners are sources, not targets — their own _lfoMod
// stays 1; we stash _lfoVal for the tendril breathing.
function updateRunnerModulation(now) {
  const runners = [];
  for (const m of seeds) {
    if (m.kind === 'modifier' && m.modifierKind === 'runner') runners.push(m);
  }
  const t = now - (state.playbackStartTime || 0);
  for (const R of runners) {
    const periodSec = Math.max(0.05, (R.lfoBars || 2) * BAR_MS / 1000);
    const ph = (t / periodSec) % 1;
    R._lfoPhase = ph < 0 ? ph + 1 : ph;             // 0..1 for the tendril animation
    R._lfoVal = 0.5 + 0.5 * Math.sin((t / periodSec) * Math.PI * 2);
    R._lfoMod = 1;
  }
  // Reset modulation accumulators each frame, then re-apply active
  // links — so removing a link (or a runner) restores the target next
  // frame with no explicit cleanup.
  for (const m of seeds) {
    if (m.kind === 'modifier' && m.modifierKind !== 'runner') { m._lfoMod = 1; m._panDriven = false; }
    else if (m.kind === 'voice') { m._modVol = 1; m._pitchMod = 0; }
  }
  for (const R of runners) {
    const amp = R.centerIntensity != null ? R.centerIntensity : 1;   // modulation depth
    const val = R._lfoVal;                       // 0..1
    const down = 1 - amp * (1 - val);            // unipolar (tremolo / strength)
    const bipolar = 0.5 + (val - 0.5) * amp;     // swings around 0.5, for params
    for (const link of (R.links || [])) {
      const target = seedById(link.targetId);
      if (!target) continue;
      const dest = link.dest || (target.kind === 'modifier' ? 'strength' : 'volume');
      if (target.kind === 'modifier') {
        if (dest === 'strength') {
          target._lfoMod *= down;
        } else {
          const mt = auraModTargets(target.modifierKind).find(t => t.key === dest);
          if (mt) mt.apply(target, bipolar);
        }
      } else if (target.kind === 'voice') {
        if (dest === 'pitch') target._pitchMod += (val - 0.5) * 2 * amp * 200;   // ±amp whole-tone
        else target._modVol *= down;                                            // volume tremolo
      }
    }
  }
}

// Pan auras auto-pan their captured voices across the stereo field at
// their own rate (panBars), width = centreIntensity, scaled by the
// aura's proximity intensity at each voice. Net pan sums across pan
// auras and rides each voice's persistent panNode (resting 0 = centre,
// so a voice leaving the field re-centres smoothly).
function updatePanModulation(now) {
  if (!audioCtx) return;
  const t = now - (state.playbackStartTime || 0);
  const pans = [];
  for (const m of seeds) {
    if (m.kind !== 'modifier' || m.modifierKind !== 'pan' || !m.sphereR) continue;
    if (m._panDriven) {
      // A runner is steering this pan aura's position this frame — its
      // override already carries the swing, so width is folded in (1).
      pans.push({ m, val: m._panDriveVal, width: 1 });
    } else {
      const period = Math.max(0.05, (m.panBars || 1) * BAR_MS / 1000);
      pans.push({ m, val: Math.sin((t / period) * Math.PI * 2), width: m.centerIntensity != null ? m.centerIntensity : 1 });
    }
  }
  for (const v of seeds) {
    if (v.kind !== 'voice' || !v.panNode) continue;
    let net = 0;
    for (const P of pans) {
      const intensity = auraIntensityForSeed(P.m, v);
      if (intensity < 0.01) continue;
      net += P.val * P.width * intensity;
    }
    if (net > 1) net = 1; else if (net < -1) net = -1;
    try { v.panNode.pan.setTargetAtTime(net, now, 0.04); } catch (e) {}
  }
}

function visualTick() {
  const now = audioCtx ? audioCtx.currentTime : 0;
  physicsStep();
  updateRunnerModulation(now);
  updateSphereTransforms();   // every frame so modulated auras breathe
  renderRunnerTendrils();
  updateAuraModulation();
  updatePanModulation(now);
  // Aura-tooltip live refresh — short-circuits inside the module
  // when nothing is hovered.
  refreshAuraTooltip();
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
  animateTethers();
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
    // Pass blobPhases so the chord outlines share the seed's
    // unique shape orientation — otherwise they're misaligned from
    // the seed body that uses phase offsets.
    path.setAttribute('d', blobPath(seed.cx, seed.cy, seed.r * scale, seed.harmonics, null, seed.blobPhases));
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
        // Effect intensity = 1 during expansion, fades linearly across
        // the hold remainder. We ramp the per-bloom wet gain so the
        // filter audibly trails off instead of cutting at pop.
        if (ev.filterWetGain && audioCtx) {
          const intensity = pulseEffectIntensity(ev);
          ev.filterWetGain.gain.setTargetAtTime(intensity, audioCtx.currentTime, 0.04);
        }
        if (elapsed >= ev.durationMs) {
          ev.state = 'popped';
          ev.popTimeMs = tnow;
          if (ev.filterNode) {
            try { ev.filterNode.disconnect(); } catch (e) {}
          }
          if (ev.filterWetGain) {
            try { ev.filterWetGain.disconnect(); } catch (e) {}
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
        const sweepLen = Math.sqrt(lenSq);
        const def = SWEEP_KINDS[ev.kind];
        for (const seed of seeds) {
          if (seed.kind !== 'voice') continue;
          if (ev.affectedSeedIds.has(seed.id)) continue;
          const t = ((seed.cx - ev.x0) * dx + (seed.cy - ev.y0) * dy) / lenSq;
          // Edge-based crossing: the wavefront touches the seed when
          // its NEAREST point (t - seed.r/sweepLen along the line)
          // crosses phase. Without this we'd wait for the wavefront
          // to reach the seed's centre, making sweeps feel laggy.
          const edgeT = t - (seed.r || 0) / sweepLen;
          if (edgeT <= phase && t <= 1) {
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
        // Visual opacity tracks effect intensity — full during the
        // growth phase, fading during the hold so the user can SEE
        // the bloom releasing its grip before it actually pops.
        const vis = pulseEffectIntensity(ev);
        const fill = document.createElementNS(SVGNS, 'circle');
        fill.setAttribute('cx', ev.cx); fill.setAttribute('cy', ev.cy);
        fill.setAttribute('r', r);
        fill.setAttribute('fill', ev.color);
        fill.setAttribute('fill-opacity', (0.12 * vis).toFixed(3));
        eventsLayer.appendChild(fill);
        const ring = document.createElementNS(SVGNS, 'circle');
        ring.setAttribute('cx', ev.cx); ring.setAttribute('cy', ev.cy);
        ring.setAttribute('r', r);
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke', ev.color);
        ring.setAttribute('stroke-width', 3);
        ring.setAttribute('stroke-opacity', (0.85 * (0.4 + 0.6 * vis)).toFixed(3));
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
