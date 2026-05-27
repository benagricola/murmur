// Seed model + SVG rendering.
//
// A seed is either kind:'voice' (a pitched/percussive source) or
// kind:'modifier' (an effect with a sphere of influence). Both share
// most of the same field shape; modifier-only fields (sphereR, delayMs,
// reverbSec, polyFactor, swing) sit alongside voice-only fields.
//
// Rendering: each seed gets a <g> element under #seeds-layer with a
// halo path, core path, ghosts container (for ripple), chord layer
// (for chord outlines), and a text label. seedNodes maps seed.id →
// these DOM refs.

import {
  WEAVE_COLOR, RIPPLE_COLOR, CLOUD_COLOR, POLY_COLOR, SEED_COLORS,
} from './constants.js';
import { BEAT_MS, BAR_MS } from './tempo.js';
import { TIMBRE_ROLES } from './timbres.js';
import { setupModifierChain } from './audio/chains.js';
import { NUM_HARMONICS } from './audio/context.js';
import { seeds, seedById, state } from './state.js';

export const SVGNS = 'http://www.w3.org/2000/svg';
export const canvasEl = document.getElementById('canvas');
export const canvasWrap = document.getElementById('canvas-wrap');
export const spheresLayer = document.getElementById('spheres-layer');
export const tethersLayer = document.getElementById('tethers-layer');
export const seedsLayer = document.getElementById('seeds-layer');
export const tapMarkersLayer = document.getElementById('tap-markers');
export const seedNodes = new Map();

// Deformation peaks visualise capture: a voice grows a tendril toward
// each modifier whose sphere contains it. Strength chosen larger than
// any natural harmonic so peaks remain clearly visible.
export const PEAK_STRENGTH = 0.30;
export const PEAK_WIDTH = 0.08;
export const PEAK_TIP_FACTOR = 1 + PEAK_STRENGTH + 0.02;

// Bar-fraction storage: timing fields (intervalMs, decay, attackMs,
// delayMs) all derive from a corresponding *Frac field — fraction of
// the current BAR_MS. transport.setBPM() recomputes the *Ms fields
// from the *Frac fields each tempo change, so:
// (a) repeated tempo changes don't accumulate floating-point error
//     (the *Ms read is always `frac * BAR_MS`, never `prev * ratio`),
// (b) scheduled events stay musically aligned across tempo changes
//     because the canonical value is "this seed plays a 1/4 note",
//     not "this seed plays every 500 ms".
// Callers that mutate seed.intervalMs (encoder turn, picker selection)
// should also update seed.intervalFrac via setSeedTiming() below.

export function setSeedTiming(seed, key, ms) {
  seed[key] = ms;
  const fracKey = key === 'intervalMs' ? 'intervalFrac'
               : key === 'decay'       ? 'decayFrac'
               : key === 'attackMs'    ? 'attackFrac'
               : key === 'delayMs'     ? 'delayFrac'
               : null;
  if (fracKey) seed[fracKey] = BAR_MS > 0 ? ms / BAR_MS : 0;
}

export function makeSeed(opts) {
  const intervalMs = opts.intervalMs || BEAT_MS;
  const decay      = opts.decay      || 500;
  const attackMs   = opts.attackMs !== undefined ? opts.attackMs : 8;
  const delayMs    = opts.delayMs    || 469;
  const seed = {
    id: state.nextSeedId++,
    kind: opts.kind || 'voice',
    modifierKind: opts.modifierKind,
    cx: opts.cx, cy: opts.cy,
    r: opts.r || 40,
    color: opts.color,
    fundamental: opts.fundamental || 220,
    decay,
    decayFrac:    decay      / BAR_MS,
    intervalMs,
    intervalFrac: intervalMs / BAR_MS,
    harmonics: opts.harmonics ? opts.harmonics.slice() : new Array(NUM_HARMONICS).fill(0),
    gain: opts.gain || 0.32,
    label: opts.label || (opts.kind === 'modifier' ? opts.modifierKind : 'seed'),
    pattern: opts.pattern
      ? opts.pattern.map(s => {
          const copy = {
            offset: s.offset || 0,
            velocity: s.velocity !== undefined ? s.velocity : 1.0,
          };
          if (s.duration !== undefined) copy.duration = s.duration;
          // tOffset: fractional displacement from the grid step
          // (range ~[-0.5, +0.5]). Recording stores this so the
          // seed's quantize toggle becomes a real playback choice —
          // on = snap to grid, off = honour the original micro-timing.
          if (s.tOffset !== undefined) copy.tOffset = s.tOffset;
          // drumSlot: for drum-kit seeds, each step references a slot
          // in DRUM_KIT (src/audio/drum-kit.js) so the scheduler can
          // dispatch each step to the right drum's patch. Tonal seeds
          // don't use this; absence means "use seed.patch".
          if (s.drumSlot !== undefined) copy.drumSlot = s.drumSlot;
          if (s.extras && s.extras.length > 0) {
            copy.extras = s.extras.map(e => {
              const ec = {
                offset: e.offset || 0,
                velocity: e.velocity !== undefined ? e.velocity : 1.0,
                duration: e.duration,
              };
              if (e.drumSlot !== undefined) ec.drumSlot = e.drumSlot;
              return ec;
            });
          }
          return copy;
        })
      : [{ offset: 0, velocity: 1.0 }],
    patternIdx: 0,
    currentStep: -1,
    nextTrigger: 0,
    lastPulseAt: 0,
    quantize: opts.quantize !== undefined ? opts.quantize : true,
    capturedByIds: new Set(),
    capturedSeedIds: new Set(),
    sphereR: opts.sphereR || 0,
    delayMs,
    delayFrac: delayMs / BAR_MS,
    reverbSec: opts.reverbSec || 2.0,
    delayInput: null,
    delayNode: null,
    reverbInput: null,
    convolver: null,
    role: opts.role || null,
    swing: opts.swing !== undefined ? opts.swing : 0.5,
    synthesisModel: opts.synthesisModel || 'additive',
    attackMs,
    attackFrac: attackMs / BAR_MS,
    polyFactor: opts.polyFactor !== undefined ? opts.polyFactor : 2/3,
    muted: opts.muted || false,
    patch: opts.patch || null,
  };
  if (!seed.color) {
    if (seed.kind === 'modifier') {
      if (seed.modifierKind === 'weave') seed.color = WEAVE_COLOR;
      else if (seed.modifierKind === 'ripple') seed.color = RIPPLE_COLOR;
      else if (seed.modifierKind === 'cloud') seed.color = CLOUD_COLOR;
      else if (seed.modifierKind === 'poly') seed.color = POLY_COLOR;
    } else {
      seed.color = (seed.role && TIMBRE_ROLES[seed.role])
        ? TIMBRE_ROLES[seed.role].color
        : SEED_COLORS[seeds.length % SEED_COLORS.length];
    }
  }
  setupModifierChain(seed);
  seeds.push(seed);
  return seed;
}

export function removeSeed(id) {
  const seed = seedById(id);
  if (!seed) return;
  if (seed.kind === 'modifier') {
    for (const vid of seed.capturedSeedIds) {
      const v = seedById(vid);
      if (v) v.capturedByIds.delete(id);
    }
  }
  if (seed.kind === 'voice' && seed.capturedByIds) {
    for (const modId of seed.capturedByIds) {
      const m = seedById(modId);
      if (m) m.capturedSeedIds.delete(id);
    }
  }
  const i = seeds.findIndex(s => s.id === id);
  if (i >= 0) seeds.splice(i, 1);
  if (state.selectedSeedId === id) {
    state.selectedSeedId = null;
    document.getElementById('inspector').classList.remove('open');
  }
}

export function radiusForFundamental(hz) {
  return Math.max(18, Math.min(80, 50 + (220 - hz) / 8));
}

export function blobPath(cx, cy, baseR, harmonicAmps, attachments) {
  const N = 128;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const theta = (i / N) * Math.PI * 2;
    let r = baseR;
    for (let h = 0; h < harmonicAmps.length; h++) {
      const amp = harmonicAmps[h];
      if (amp) r += baseR * amp * 0.55 * Math.cos((h + 2) * theta);
    }
    if (attachments) {
      for (const a of attachments) {
        let d = Math.abs(((theta - a.angle + Math.PI) % (Math.PI * 2)) - Math.PI);
        r += baseR * a.strength * Math.exp(-(d * d) / (2 * a.width * a.width));
      }
    }
    pts.push([cx + r * Math.cos(theta), cy + r * Math.sin(theta)]);
  }
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N], p1 = pts[i], p2 = pts[(i + 1) % N], p3 = pts[(i + 2) % N];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d + ' Z';
}

export function attachmentsForSeed(seed) {
  if (!seed || seed.kind !== 'voice' || !seed.capturedByIds || seed.capturedByIds.size === 0) return null;
  const atts = [];
  for (const id of seed.capturedByIds) {
    const m = seedById(id);
    if (!m) continue;
    atts.push({
      angle: Math.atan2(m.cy - seed.cy, m.cx - seed.cx),
      strength: PEAK_STRENGTH,
      width: PEAK_WIDTH,
    });
  }
  return atts;
}

export function renderSeed(seed) {
  let node = seedNodes.get(seed.id);
  if (!node) {
    const wrap = document.createElementNS(SVGNS, 'g');
    wrap.setAttribute('class', 'seed-wrap');
    wrap.dataset.seedId = seed.id;
    const halo = document.createElementNS(SVGNS, 'path');
    halo.setAttribute('class', 'seed-halo');
    halo.setAttribute('opacity', '0.45');
    wrap.appendChild(halo);
    const core = document.createElementNS(SVGNS, 'path');
    core.setAttribute('class', 'seed-core');
    wrap.appendChild(core);
    const ghosts = document.createElementNS(SVGNS, 'g');
    wrap.appendChild(ghosts);
    const chordLayer = document.createElementNS(SVGNS, 'g');
    chordLayer.setAttribute('pointer-events', 'none');
    wrap.appendChild(chordLayer);
    const label = document.createElementNS(SVGNS, 'text');
    label.setAttribute('class', 'seed-label');
    wrap.appendChild(label);
    seedsLayer.appendChild(wrap);
    node = { wrap, halo, core, ghosts, chordLayer, label };
    seedNodes.set(seed.id, node);
  }
  node.halo.setAttribute('fill', seed.color);
  node.core.setAttribute('fill', seed.color);
  const atts = attachmentsForSeed(seed);
  if (seed.kind === 'modifier') {
    node.halo.setAttribute('filter', 'url(#halo-blur-small)');
    if (seed.modifierKind === 'weave') {
      node.core.setAttribute('class', 'seed-core weave-pulse');
    } else if (seed.modifierKind === 'cloud') {
      node.core.setAttribute('class', 'seed-core cloud-pulse');
    } else if (seed.modifierKind === 'poly') {
      node.core.setAttribute('class', 'seed-core poly-pulse');
    } else {
      node.core.setAttribute('class', 'seed-core');
    }
    if (seed.modifierKind === 'ripple' && node.ghosts.children.length === 0) {
      const drifts = [
        { gx: 14, gy: 6, delay: 0 },
        { gx: 16, gy: -4, delay: 500 },
        { gx: 10, gy: 12, delay: 1000 },
      ];
      drifts.forEach(d => {
        const ghost = document.createElementNS(SVGNS, 'path');
        ghost.setAttribute('fill', seed.color);
        ghost.setAttribute('class', 'ripple-ghost');
        ghost.style.setProperty('--gx', d.gx + 'px');
        ghost.style.setProperty('--gy', d.gy + 'px');
        ghost.style.animationDelay = d.delay + 'ms';
        node.ghosts.appendChild(ghost);
      });
    }
    if (seed.modifierKind === 'ripple') {
      for (const g of node.ghosts.children) {
        g.setAttribute('d', blobPath(seed.cx, seed.cy, seed.r, seed.harmonics));
      }
    }
  } else {
    node.halo.setAttribute('filter', 'url(#halo-blur)');
    node.core.setAttribute('class', 'seed-core');
  }
  node.halo.setAttribute('d', blobPath(seed.cx, seed.cy, seed.r * 1.3, seed.harmonics, atts));
  node.core.setAttribute('d', blobPath(seed.cx, seed.cy, seed.r, seed.harmonics, atts));
  node.label.setAttribute('x', seed.cx);
  node.label.setAttribute('y', seed.cy + seed.r + 22);
  node.label.textContent = seed.label;
  if (state.selectedSeedId === seed.id) node.wrap.classList.add('seed-selected');
  else node.wrap.classList.remove('seed-selected');
  node.wrap.classList.toggle('muted', !!seed.muted);
}

export function renderSpheres() {
  spheresLayer.innerHTML = '';
  for (const s of seeds) {
    if (s.kind !== 'modifier' || !s.sphereR) continue;
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', s.cx); c.setAttribute('cy', s.cy);
    c.setAttribute('r', s.sphereR);
    c.setAttribute('class', 'sphere');
    c.setAttribute('fill', `url(#sphere-${s.modifierKind}-grad)`);
    spheresLayer.appendChild(c);
  }
}

export function renderTethers() {
  tethersLayer.innerHTML = '';
  for (const v of seeds) {
    if (v.kind !== 'voice' || !v.capturedByIds || v.capturedByIds.size === 0) continue;
    for (const modId of v.capturedByIds) {
      const m = seedById(modId);
      if (!m) continue;
      const path = document.createElementNS(SVGNS, 'path');
      const ang = Math.atan2(m.cy - v.cy, m.cx - v.cx);
      const ax = v.cx + v.r * PEAK_TIP_FACTOR * Math.cos(ang);
      const ay = v.cy + v.r * PEAK_TIP_FACTOR * Math.sin(ang);
      const bx = m.cx, by = m.cy;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      const perpX = len ? -dy / len : 0, perpY = len ? dx / len : 0;
      const sag = Math.min(len * 0.10, 24);
      const ctrlX = mx + perpX * sag, ctrlY = my + perpY * sag;
      path.setAttribute('d', `M ${ax.toFixed(1)} ${ay.toFixed(1)} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`);
      path.setAttribute('class', 'tether-' + m.modifierKind);
      path.setAttribute('stroke', m.color);
      tethersLayer.appendChild(path);
    }
  }
}

export function syncRenderedSeeds() {
  const liveIds = new Set(seeds.map(s => s.id));
  for (const [id, node] of seedNodes) {
    if (!liveIds.has(id)) { node.wrap.remove(); seedNodes.delete(id); }
  }
  const ordered = [...seeds].sort((a, b) =>
    (a.kind === 'modifier' ? 0 : 1) - (b.kind === 'modifier' ? 0 : 1));
  for (const s of ordered) {
    renderSeed(s);
    seedsLayer.appendChild(seedNodes.get(s.id).wrap);
  }
  renderSpheres();
  renderTethers();
}
