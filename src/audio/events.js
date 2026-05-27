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

export const PULSE_KINDS = {
  drop:   { label: 'drop',   color: '#ff4d80', maxRadius: 320, durationBars: 1 },
  muffle: { label: 'muffle', color: '#5e7ad8', maxRadius: 360, durationBars: 1 },
  thin:   { label: 'thin',   color: '#ffd84d', maxRadius: 360, durationBars: 1 },
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
  const phase = Math.min(1, elapsedMs / ev.durationMs);
  return ev.maxRadius * phase;
}

// Return any pulses whose current radius contains this seed.
export function activePulsesAffecting(seed) {
  const out = [];
  for (const ev of activeEvents) {
    if (ev.state !== 'expanding') continue;
    const r = pulseCurrentRadius(ev);
    if (Math.hypot(seed.cx - ev.cx, seed.cy - ev.cy) <= r) out.push(ev);
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
      const isDrum = seed.patch && seed.patch.category === 'drum';
      node.connect(isDrum && drumBus ? drumBus : masterGain);
    }
    if (seed.capturedByIds && seed.capturedByIds.size > 0) {
      for (const id of seed.capturedByIds) {
        const m = seedById(id);
        if (!m) continue;
        if (m.modifierKind === 'ripple' && m.delayInput) node.connect(m.delayInput);
        if (m.modifierKind === 'cloud'  && m.reverbInput) node.connect(m.reverbInput);
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
    if (m.modifierKind === 'ripple' && m.delayInput) node.connect(m.delayInput);
    if (m.modifierKind === 'cloud'  && m.reverbInput) node.connect(m.reverbInput);
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
  const durationBars = tune.durationBars != null ? tune.durationBars : def.durationBars;
  const ev = {
    id: state.nextEventId++,
    type: 'pulse',
    kind: kindKey,
    color: def.color,
    cx, cy,
    maxRadius,
    durationMs: durationBars * BAR_MS,
    startTimeMs: performance.now(),
    state: 'expanding',           // 'expanding' → 'popped' → 'done'
    popTimeMs: null,
    affectedSeedIds: new Set(),
    filterNode: null,
  };
  if (audioCtx && masterGain) {
    if (kindKey === 'muffle') {
      const f = audioCtx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 380;
      f.Q.value = 0.9;
      f.connect(masterGain);
      ev.filterNode = f;
    } else if (kindKey === 'thin') {
      const f = audioCtx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 2400;
      f.Q.value = 0.9;
      f.connect(masterGain);
      ev.filterNode = f;
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
