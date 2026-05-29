// Ephemeral temporal effects: pulses (radial, internally `pulse` —
// the user calls them "blooms") and sweeps (directional — the user
// calls them "winds"). Pulses expand from a tap point and snap back
// at pop; sweeps travel from start to end and commit a state change
// as the wavefront passes each affected seed.
//
// `routeFinalOutput` lives here because audio output routing has to
// know about active pulses (filter / mute) — it's the single entry
// point that every voice's output passes through on its way to the
// master gain. Modifier-chain sends fan out from the same place.

import { audioCtx, masterGain, drumBus, initAudio } from './context.js';
import { activeEvents, seeds, state, seedById } from '../state.js';
import { BAR_MS } from '../tempo.js';
import { auraIntensityForSeed } from '../seeds.js';
import { auraEntry } from '../auras/registry.js';

// PULSE_KINDS defaults — expandBars sets the shockwave velocity (how
// many bars until maxRadius is reached); durationBars sets total
// lifetime, with the effect fading linearly over the hold remainder
// before popping. Spawn-time tunables in state.bloomSettings override.
export const PULSE_KINDS = {
  drop:   { label: 'drop',   color: '#ff4d80', maxRadius: 320, expandBars: 0.25, durationBars: 1.5 },
  muffle: { label: 'muffle', color: '#5e7ad8', maxRadius: 360, expandBars: 0.5,  durationBars: 2.0 },
  thin:   { label: 'thin',   color: '#ffd84d', maxRadius: 360, expandBars: 0.5,  durationBars: 2.0 },
};

// Sweeps are directional lines that travel from start→end over a fixed
// musical duration. As the wavefront passes each voice, the voice's
// mute state is committed (persists after the sweep completes — unlike
// bombs which snap back at pop).
export const SWEEP_KINDS = {
  rise: { label: 'rise', color: '#5af095', durationBars: 4, action: 'unmute' },
  fade: { label: 'fade', color: '#ff7a8c', durationBars: 4, action: 'mute' },
};

export function pulseCurrentRadius(ev) {
  if (ev.state !== 'expanding') return ev.maxRadius;
  const elapsedMs = performance.now() - ev.startTimeMs;
  // Two-phase: grow during expandMs, then hold at maxRadius until pop.
  // Without expandMs (legacy events) fall back to old single-phase
  // ramp over durationMs.
  const expandMs = ev.expandMs != null ? ev.expandMs : ev.durationMs;
  const phase = Math.min(1, elapsedMs / Math.max(1, expandMs));
  return ev.maxRadius * phase;
}

// 1.0 during expansion, then linearly fades to 0 across the hold
// remainder before the pop. Used to scale visual opacity and the
// audio wet/dry of filter-style blooms so the effect "trails off"
// instead of cutting hard.
export function pulseEffectIntensity(ev) {
  if (ev.state !== 'expanding') return 0;
  const elapsed = performance.now() - ev.startTimeMs;
  const expandMs = ev.expandMs != null ? ev.expandMs : ev.durationMs;
  const total = ev.durationMs;
  if (elapsed <= expandMs) return 1;
  const holdMs = Math.max(1, total - expandMs);
  return Math.max(0, 1 - (elapsed - expandMs) / holdMs);
}

// Return any pulses whose current radius reaches this seed's edge.
// Edge-based (radius + seed.r) instead of centre-based — a pulse
// dropped slightly inside the seed's halo now triggers immediately
// rather than waiting for the pulse to grow far enough to cross the
// seed's centre. Same logic for sweeps below.
export function activePulsesAffecting(seed) {
  const out = [];
  const r0 = seed.r || 0;
  for (const ev of activeEvents) {
    if (ev.state !== 'expanding') continue;
    const r = pulseCurrentRadius(ev);
    if (Math.hypot(seed.cx - ev.cx, seed.cy - ev.cy) <= r + r0) out.push(ev);
  }
  return out;
}

// Centralised output routing. Every voice's enveloped signal goes
// through here on its way to master — this is where pulse filters /
// mutes apply and modifier sends fan out.
//
// Drum-category seeds route to drumBus (→ drumCompressor → masterGain)
// instead of straight to masterGain. The compressor glues kick/snare/
// hat into one cohesive kit. Tonal seeds skip the bus and hit
// masterGain directly so they don't get pumped by the kick.
export function routeFinalOutput(seed, node) {
  const pulses = activePulsesAffecting(seed);
  const muteBomb = pulses.find(b => b.kind === 'drop');
  if (!muteBomb) {
    const filterBomb = pulses.find(b => b.filterNode);
    if (filterBomb) {
      node.connect(filterBomb.filterNode);
    } else {
      // Two persistent per-seed gain nodes:
      //   seed.auraGain  — modulated by gain/mute proximity each tick
      //                    (scheduler.updateAuraModulation). Resting
      //                    value 1.0 when no aura affects the seed.
      //   seed.postGain  — collision duck handles this. Resting 1.0.
      // Chain: node → auraGain → postGain → dest. Both lazily-created.
      const cat = seed.patch && seed.patch.category;
      const isDrum = cat === 'drum' || cat === 'drum-kit';
      const dest = isDrum && drumBus ? drumBus : masterGain;
      if (!seed.postGain && audioCtx) {
        seed.postGain = audioCtx.createGain();
        seed.postGain.gain.value = 1.0;
        seed.postGain.connect(dest);
      }
      if (!seed.auraGain && audioCtx) {
        seed.auraGain = audioCtx.createGain();
        seed.auraGain.gain.value = 1.0;
        seed.auraGain.connect(seed.postGain || dest);
      }
      node.connect(seed.auraGain || seed.postGain || dest);
    }
    // Proximity-graded ripple / cloud sends. For every aura on the
    // canvas, compute its intensity at this seed's position and route
    // the audio through a per-send gain proportional to intensity.
    // No-op when intensity is essentially zero (saves a gain node per
    // distant aura). The send gain is set once at note creation —
    // seeds drifting through the field have their NEXT notes attenuated
    // at the new position; currently-playing notes don't re-modulate
    // mid-flight.
    if (audioCtx) {
      for (const m of seeds) {
        if (m.kind !== 'modifier') continue;
        const entry = auraEntry(m.modifierKind);
        if (!entry || !entry.chain) continue;     // gain/mute/poly/weave/shift: no audio send
        const inputNode = m[entry.chain.inputProp];
        if (!inputNode) continue;
        const intensity = auraIntensityForSeed(m, seed);
        if (intensity < 0.02) continue;
        const g = audioCtx.createGain();
        g.gain.value = intensity;
        node.connect(g);
        g.connect(inputNode);
      }
    }
  }
  // If muteBomb is active, we don't connect to anything. Note plays silently.
}

// Legacy alias kept for any callers that didn't get updated.
export function routeToModifiers(seed, node) {
  if (!seed.capturedByIds || seed.capturedByIds.size === 0) return;
  for (const id of seed.capturedByIds) {
    const m = seedById(id);
    if (!m) continue;
    const entry = auraEntry(m.modifierKind);
    if (entry && entry.chain && m[entry.chain.inputProp]) node.connect(m[entry.chain.inputProp]);
  }
}

export function spawnPulse(cx, cy, kindKey) {
  if (!audioCtx) initAudio();
  const def = PULSE_KINDS[kindKey];
  if (!def) return null;
  // Live tunables: state.bloomSettings overrides def's defaults so the
  // user can edit radius/duration from the bloom config window without
  // patching the def in-place. Falls back to def if no override exists.
  const tune = (state.bloomSettings && state.bloomSettings[kindKey]) || {};
  const maxRadius = tune.maxRadius != null ? tune.maxRadius : def.maxRadius;
  const expandBars = tune.expandBars != null ? tune.expandBars : def.expandBars;
  const durationBars = tune.durationBars != null ? tune.durationBars : def.durationBars;
  // Pop must come after expansion completes — clamp duration up if a
  // user dialled it absurdly small. expandBars is the minimum.
  const expandMs = Math.max(50, expandBars * BAR_MS);
  const durationMs = Math.max(expandMs + 50, durationBars * BAR_MS);
  const ev = {
    id: state.nextEventId++,
    type: 'pulse',
    kind: kindKey,
    color: def.color,
    cx, cy,
    maxRadius,
    expandMs,
    durationMs,
    startTimeMs: performance.now(),
    state: 'expanding',           // 'expanding' → 'popped' → 'done'
    popTimeMs: null,
    affectedSeedIds: new Set(),
    filterNode: null,
    filterWetGain: null,
  };
  if (audioCtx && masterGain) {
    if (kindKey === 'muffle' || kindKey === 'thin') {
      const f = audioCtx.createBiquadFilter();
      if (kindKey === 'muffle') {
        f.type = 'lowpass';
        f.frequency.value = 380;
      } else {
        f.type = 'highpass';
        f.frequency.value = 2400;
      }
      f.Q.value = 0.9;
      // Wet-only gain after the filter so we can fade the filter's
      // contribution to zero during the hold phase. Voices still
      // route to the filter while it's connected; the gain envelope
      // is what actually fades the effect away.
      const wet = audioCtx.createGain();
      wet.gain.value = 1;
      f.connect(wet);
      wet.connect(masterGain);
      ev.filterNode = f;
      ev.filterWetGain = wet;
    }
  }
  activeEvents.push(ev);
  return ev;
}

export function spawnSweep(x0, y0, x1, y1, kindKey) {
  const def = SWEEP_KINDS[kindKey];
  if (!def) return null;
  if (Math.hypot(x1 - x0, y1 - y0) < 30) return null;
  const tune = (state.windSettings && state.windSettings[kindKey]) || {};
  const durationBars = tune.durationBars != null ? tune.durationBars : def.durationBars;
  const ev = {
    id: state.nextEventId++,
    type: 'sweep',
    kind: kindKey,
    color: def.color,
    x0, y0, x1, y1,
    durationMs: durationBars * BAR_MS,
    startTimeMs: performance.now(),
    state: 'active',
    affectedSeedIds: new Set(),
  };
  activeEvents.push(ev);
  return ev;
}
