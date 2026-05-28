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
import { forceStopByTag } from './audio/voices.js';
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

// === Aura intensity field ===
// Each aura is a circular region whose effect strength varies with
// distance from the epicentre. The shape is `edgeIntensity` at the
// sphere boundary, `centerIntensity` at the centre, interpolated by
// `falloffCurve`. This replaces the old binary "in sphere or not"
// capture model — seeds get more of an effect the deeper they are.
export const AURA_CURVES = {
  linear:   (t) => t,
  easeIn:   (t) => t * t,
  easeOut:  (t) => 1 - (1 - t) * (1 - t),
  smooth:   (t) => t * t * (3 - 2 * t),
  sharp:    (t) => t * t * t,
  step:     (t) => t < 0.5 ? 0 : 1,
};
export const AURA_CURVE_KEYS = Object.keys(AURA_CURVES);

export function auraIntensityAt(aura, x, y) {
  if (!aura || aura.kind !== 'modifier' || !aura.sphereR) return 0;
  const dist = Math.hypot(x - aura.cx, y - aura.cy);
  if (dist >= aura.sphereR) return 0;
  // frac: 0 at the edge, 1 at the centre.
  const frac = 1 - (dist / aura.sphereR);
  const fn = AURA_CURVES[aura.falloffCurve] || AURA_CURVES.linear;
  const t = fn(Math.max(0, Math.min(1, frac)));
  const edge = aura.edgeIntensity != null ? aura.edgeIntensity : 0;
  const cen  = aura.centerIntensity != null ? aura.centerIntensity : 1;
  return Math.max(0, Math.min(1, edge + t * (cen - edge)));
}

export function auraIntensityForSeed(aura, seed) {
  return auraIntensityAt(aura, seed.cx, seed.cy);
}

// Seed mass for the soft-repulsion physics in scheduler.visualTick.
// Heavier seeds barely move when bumped; lighter ones scatter. Mass
// scales as log2(220 / fundamental) + 1 — 30 Hz → ~3.9, 220 → 1.0,
// 1000 → ~-1.2 (clamped to 0.3). Modifiers (auras) get high mass so
// they act as immovable territory.
export function computeSeedMass(fundamental, kind, modifierKind) {
  if (kind === 'modifier') return 8.0;   // immovable territory
  const f = fundamental || 220;
  const m = Math.log2(220 / f) + 1.0;
  return Math.max(0.3, Math.min(4.0, m));
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
    // loop: when true (default), the pattern repeats indefinitely
    // during playback. When false the pattern plays through exactly
    // once on each play-start (or trigger), then stays silent until
    // the next trigger. Foundation for the future "trigger seeds
    // via bloom / wind" feature.
    loop: opts.loop !== undefined ? opts.loop : true,
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
    // Aura intensity grading. edgeIntensity = effect strength at the
    // sphere boundary, centerIntensity = at the epicentre. The curve
    // controls how intensity interpolates between them — linear by
    // default, but the inspector lets the user pick an easing shape.
    edgeIntensity:   opts.edgeIntensity   !== undefined ? opts.edgeIntensity   : 0,
    centerIntensity: opts.centerIntensity !== undefined ? opts.centerIntensity : 1,
    falloffCurve:    opts.falloffCurve || 'linear',
    synthesisModel: opts.synthesisModel || 'additive',
    attackMs,
    attackFrac: attackMs / BAR_MS,
    polyFactor: opts.polyFactor !== undefined ? opts.polyFactor : 2/3,
    // Per-seed harmonic phase offsets — gives each seed a unique
    // blob orientation. Without this every blob's harmonic ripples
    // line up at theta=0 and shapes look stamped from the same mould.
    blobPhases: opts.blobPhases || (new Array(NUM_HARMONICS).fill(0)
      .map(() => Math.random() * Math.PI * 2)),
    // Physics: each seed has velocity + mass for soft repulsion.
    // Mass derived from fundamental — lower freq = heavier (log-2
    // scale centred on 220Hz = mass 1.0). Drum-kit seeds use a
    // representative slot freq via their patch.
    vx: 0, vy: 0,
    mass: computeSeedMass(opts.fundamental, opts.kind, opts.modifierKind),
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
  // Silence any in-flight audio from this seed immediately. Without
  // this, scheduled notes already in the Web Audio queue would play
  // out their full envelope after the seed is gone.
  forceStopByTag(id);
  // Disconnect modifier audio chains owned by this seed (delay/reverb
  // inputs) so their tails go silent rather than ringing into masterGain.
  if (seed.kind === 'modifier') {
    if (seed.delayInput)  { try { seed.delayInput.disconnect();  } catch (e) {} }
    if (seed.reverbInput) { try { seed.reverbInput.disconnect(); } catch (e) {} }
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

export function blobPath(cx, cy, baseR, harmonicAmps, attachments, phases) {
  const N = 128;
  const pts = [];
  // `phases` (optional) — per-harmonic phase offset 0..2π. Without it
  // every harmonic's cosine ripple starts at theta=0, so blob shapes
  // always lean rightward and look samey. With it (set per seed at
  // creation), each seed gets a unique orientation while preserving
  // the same overall spectrum-driven character.
  for (let i = 0; i < N; i++) {
    const theta = (i / N) * Math.PI * 2;
    let r = baseR;
    for (let h = 0; h < harmonicAmps.length; h++) {
      const amp = harmonicAmps[h];
      if (amp) {
        const phase = phases ? (phases[h] || 0) : 0;
        r += baseR * amp * 0.55 * Math.cos((h + 2) * theta + phase);
      }
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
  if (!seed || seed.kind !== 'voice') return null;
  // Walk every aura on the canvas and grow a tendril toward each one
  // whose intensity at this seed is meaningful. Tendril strength
  // scales with intensity, so a seed at the edge of an aura gets a
  // tiny nub; deep inside, a full peak. Was capturedByIds-driven and
  // binary; now graded.
  const atts = [];
  for (const m of seeds) {
    if (m.kind !== 'modifier') continue;
    const intensity = auraIntensityForSeed(m, seed);
    if (intensity < 0.05) continue;
    atts.push({
      angle: Math.atan2(m.cy - seed.cy, m.cx - seed.cx),
      // Scale the original PEAK_STRENGTH/WIDTH by intensity so the
      // tendril grows in / shrinks out as the seed drifts.
      _intensity: intensity,
      strength: PEAK_STRENGTH * intensity,
      width: PEAK_WIDTH,
    });
  }
  return atts.length > 0 ? atts : null;
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
        g.setAttribute('d', blobPath(seed.cx, seed.cy, seed.r, seed.harmonics, null, seed.blobPhases));
      }
    }
  } else {
    node.halo.setAttribute('filter', 'url(#halo-blur)');
    node.core.setAttribute('class', 'seed-core');
  }
  node.halo.setAttribute('d', blobPath(seed.cx, seed.cy, seed.r * 1.3, seed.harmonics, atts, seed.blobPhases));
  node.core.setAttribute('d', blobPath(seed.cx, seed.cy, seed.r, seed.harmonics, atts, seed.blobPhases));
  node.label.setAttribute('x', seed.cx);
  node.label.setAttribute('y', seed.cy + seed.r + 22);
  node.label.textContent = seed.label;
  if (state.selectedSeedId === seed.id) node.wrap.classList.add('seed-selected');
  else node.wrap.classList.remove('seed-selected');
  node.wrap.classList.toggle('muted', !!seed.muted);
}

// Each aura caches a set of point positions in normalised
// (theta, frac) form — frac in 0..1 of sphereR — so they survive
// sphere resizing without regenerating. Density is uniform across
// the disc; visual density of LIT dots tracks intensity, since
// out-of-range dots are skipped at render time.
const AURA_DOTS_PER_SPHERE = 120;
function generateAuraDots() {
  const pts = [];
  for (let i = 0; i < AURA_DOTS_PER_SPHERE; i++) {
    pts.push({
      theta: Math.random() * Math.PI * 2,
      frac: Math.sqrt(Math.random()),   // uniform disc sampling
    });
  }
  return pts;
}

export function renderSpheres() {
  spheresLayer.innerHTML = '';
  for (const s of seeds) {
    if (s.kind !== 'modifier' || !s.sphereR) continue;
    // Soft fill ring (the existing radial-gradient circle) for the
    // overall territory hint.
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', s.cx); c.setAttribute('cy', s.cy);
    c.setAttribute('r', s.sphereR);
    c.setAttribute('class', 'sphere');
    c.setAttribute('fill', `url(#sphere-${s.modifierKind}-grad)`);
    spheresLayer.appendChild(c);
    // Point-cloud overlay: each dot's opacity tracks the aura's
    // intensity at that point. Together they form a density gradient
    // that follows the chosen falloff curve + edge/centre values.
    if (!s._auraDots) s._auraDots = generateAuraDots();
    for (const p of s._auraDots) {
      const r = s.sphereR * p.frac;
      const x = s.cx + r * Math.cos(p.theta);
      const y = s.cy + r * Math.sin(p.theta);
      const intensity = auraIntensityAt(s, x, y);
      if (intensity < 0.04) continue;
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('cx', x.toFixed(1));
      dot.setAttribute('cy', y.toFixed(1));
      dot.setAttribute('r', 1.6);
      dot.setAttribute('fill', s.color);
      dot.setAttribute('opacity', (intensity * 0.7).toFixed(3));
      dot.setAttribute('pointer-events', 'none');
      spheresLayer.appendChild(dot);
    }
  }
}

export function renderTethers() {
  tethersLayer.innerHTML = '';
  // Tethers are drawn from each voice toward every aura whose
  // intensity at that voice is above a visibility threshold. Opacity
  // tracks intensity so an aura's edge produces a faint hint and the
  // centre produces a fully-lit line.
  for (const v of seeds) {
    if (v.kind !== 'voice') continue;
    for (const m of seeds) {
      if (m.kind !== 'modifier') continue;
      const intensity = auraIntensityForSeed(m, v);
      if (intensity < 0.05) continue;
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
      path.setAttribute('opacity', intensity.toFixed(3));
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
