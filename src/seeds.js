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
  WEAVE_COLOR, RIPPLE_COLOR, CLOUD_COLOR, POLY_COLOR,
  DRIVE_COLOR, GAIN_COLOR, MUTE_COLOR,
  SQUASH_COLOR, WOBBLE_COLOR, CRUSH_COLOR, SHIFT_COLOR,
  SEED_COLORS,
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

// Default wanderlust per role — drums anchored, melody/voice drift.
// Per-seed override via inspector slider; saved by snapshots.
export function defaultWanderlust(kind, role) {
  if (kind === 'modifier') return 0;
  switch (role) {
    case 'kick': case 'snare': case 'hat':
    case 'drumkit': return 0;
    case 'bass':    return 0.1;
    case 'melody':  return 0.2;
    case 'voice':   return 0.3;
    default:        return 0.15;
  }
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
    // patternBank — additional pattern variations. seed.pattern always
    // points at patternBank[patternBankIdx].steps so editing the live
    // pattern mutates the bank in place. At each loop boundary the
    // scheduler may pick a different bank entry (see #53). Bank starts
    // with the initial pattern as the sole entry, weight 1.
    patternBank: null,
    patternBankIdx: 0,
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
    // Drive / gain / mute aura kind-specific settings.
    driveAmount: opts.driveAmount !== undefined ? opts.driveAmount : 1.6,
    gainAmount:  opts.gainAmount  !== undefined ? opts.gainAmount  : 1.0,
    // Effects-pass aura settings (#54). squash = compressor amount,
    // wobble = LFO depth / rate, crush = bit depth / rate reduction.
    squashAmount: opts.squashAmount !== undefined ? opts.squashAmount : 1.5,
    wobbleRate:   opts.wobbleRate   !== undefined ? opts.wobbleRate   : 4.5,
    wobbleDepth:  opts.wobbleDepth  !== undefined ? opts.wobbleDepth  : 0.6,
    crushBits:    opts.crushBits    !== undefined ? opts.crushBits    : 5,
    crushRate:    opts.crushRate    !== undefined ? opts.crushRate    : 0.35,
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
    // Wanderlust 0..1 — how restless the seed is. Adds a smoothly-
    // changing random drift force in physicsStep. 0 = stays where
    // placed; 1 = chaotically wanders. Default per role: drums sit
    // still, bass barely moves, voice drifts gently. Auras have
    // wanderlust 0 — they're territory, not organisms.
    wanderlust: opts.wanderlust !== undefined ? opts.wanderlust
      : defaultWanderlust(opts.kind, opts.role),
    muted: opts.muted || false,
    patch: opts.patch || null,
  };
  // Initialise the patternBank with the seed's starting pattern as
  // the sole entry. Editing seed.pattern in place keeps the bank in
  // sync because seed.pattern and patternBank[0].steps share the same
  // array reference. New variations append to the bank.
  if (seed.kind === 'voice') {
    seed.patternBank = [{
      id: Math.random().toString(36).slice(2, 8),
      steps: seed.pattern,
      weight: 1,
    }];
    seed.patternBankIdx = 0;
  }
  if (!seed.color) {
    if (seed.kind === 'modifier') {
      if      (seed.modifierKind === 'weave')  seed.color = WEAVE_COLOR;
      else if (seed.modifierKind === 'ripple') seed.color = RIPPLE_COLOR;
      else if (seed.modifierKind === 'cloud')  seed.color = CLOUD_COLOR;
      else if (seed.modifierKind === 'poly')   seed.color = POLY_COLOR;
      else if (seed.modifierKind === 'drive')  seed.color = DRIVE_COLOR;
      else if (seed.modifierKind === 'gain')   seed.color = GAIN_COLOR;
      else if (seed.modifierKind === 'mute')   seed.color = MUTE_COLOR;
      else if (seed.modifierKind === 'squash') seed.color = SQUASH_COLOR;
      else if (seed.modifierKind === 'wobble') seed.color = WOBBLE_COLOR;
      else if (seed.modifierKind === 'crush')  seed.color = CRUSH_COLOR;
      else if (seed.modifierKind === 'shift')  seed.color = SHIFT_COLOR;
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
  // Disconnect the seed's persistent audio nodes so nothing leaks.
  if (seed.postGain)    { try { seed.postGain.disconnect(); }    catch (e) {} seed.postGain = null; }
  if (seed.auraGain)    { try { seed.auraGain.disconnect(); }    catch (e) {} seed.auraGain = null; }
  if (seed.driveInput)  { try { seed.driveInput.disconnect(); }  catch (e) {} seed.driveInput = null; }
  // Disconnect modifier audio chains owned by this seed (delay/reverb
  // inputs) so their tails go silent rather than ringing into masterGain.
  if (seed.kind === 'modifier') {
    if (seed.delayInput)  { try { seed.delayInput.disconnect();  } catch (e) {} }
    if (seed.reverbInput) { try { seed.reverbInput.disconnect(); } catch (e) {} }
    if (seed.squashInput) { try { seed.squashInput.disconnect(); } catch (e) {} }
    if (seed.wobbleInput) { try { seed.wobbleInput.disconnect(); } catch (e) {} }
    if (seed.wobbleLFO)   { try { seed.wobbleLFO.stop();         } catch (e) {} }
    if (seed.crushInput)  { try { seed.crushInput.disconnect();  } catch (e) {} }
    if (seed.crushProcessor) { try { seed.crushProcessor.disconnect(); } catch (e) {} }
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

// Tether particle streams — each (seed, aura) pair gets a small
// stream of particles that flow from the seed's edge into the
// aura's centre, suggesting material being drawn in. Particles
// fade and shrink as they approach the aura (consumed). The
// stream is rebuilt when the set of active pairs changes; the
// per-frame `animateTethers` advances the particles along their
// curves.
//
// Active streams cache:
//   key  = `seedId-auraId`
//   val  = { gNode, particles: [<circle>...], phases: [0..1...] }
// More particles, larger, brighter — the previous 5 small dots at the
// aura's colour got lost against the aura's point cloud. Now each
// particle carries the SEED's colour (it's material being torn off the
// seed, so it stays seed-coloured) and there are enough of them to
// read as a continuous stream.
const PARTICLES_PER_STREAM = 9;
const PARTICLE_BASE_R = 3.5;
const tetherStreams = new Map();

function ensureTetherStream(key, v, m, intensity) {
  let cached = tetherStreams.get(key);
  if (!cached) {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('pointer-events', 'none');
    const particles = [];
    const phases = [];
    for (let i = 0; i < PARTICLES_PER_STREAM; i++) {
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('r', String(PARTICLE_BASE_R));
      // Soft outer halo via stroke makes each particle pop against the
      // aura's point cloud regardless of background colour. No filter
      // node — SVG filters tank perf at our particle count.
      c.setAttribute('stroke', m.color);
      c.setAttribute('stroke-width', '1');
      c.setAttribute('stroke-opacity', '0.6');
      g.appendChild(c);
      particles.push(c);
      // Evenly spaced phases instead of pure random — gives a steady
      // visible chain instead of clumps that briefly look empty.
      phases.push(i / PARTICLES_PER_STREAM);
    }
    tethersLayer.appendChild(g);
    cached = { gNode: g, particles, phases };
    tetherStreams.set(key, cached);
  }
  // Particles are coloured with the SEED's hue (material being pulled
  // off the seed) with the aura's hue as the halo — communicates the
  // direction of flow.
  for (const p of cached.particles) {
    p.setAttribute('fill', v.color || '#fff');
    p.setAttribute('stroke', m.color);
  }
  cached.gNode.dataset.intensity = intensity;
  cached.gNode.dataset.vId = v.id;
  cached.gNode.dataset.mId = m.id;
  return cached;
}

export function renderTethers() {
  // Mark which streams should exist this pass.
  const wantedKeys = new Set();
  for (const v of seeds) {
    if (v.kind !== 'voice') continue;
    for (const m of seeds) {
      if (m.kind !== 'modifier') continue;
      const intensity = auraIntensityForSeed(m, v);
      if (intensity < 0.05) continue;
      const key = `${v.id}-${m.id}`;
      wantedKeys.add(key);
      ensureTetherStream(key, v, m, intensity);
    }
  }
  // Tear down streams whose pair is no longer active.
  for (const [key, cached] of tetherStreams) {
    if (wantedKeys.has(key)) continue;
    cached.gNode.remove();
    tetherStreams.delete(key);
  }
}

// Per-frame particle advance. Called from scheduler.visualTick so
// streams animate smoothly even when nothing is moving. Each
// particle walks a quadratic Bezier from the seed's edge to the
// aura's centre; on reaching 1.0 it wraps to 0.0 with a small
// random jitter so the stream doesn't pulse in lockstep.
export function animateTethers() {
  for (const [key, cached] of tetherStreams) {
    const vId = parseInt(cached.gNode.dataset.vId);
    const mId = parseInt(cached.gNode.dataset.mId);
    const v = seedById(vId);
    const m = seedById(mId);
    if (!v || !m) continue;
    const intensity = parseFloat(cached.gNode.dataset.intensity) || 0;
    // Stream geometry — anchor on the seed's edge in the aura's
    // direction (matches the attachmentsForSeed peak), curve into
    // the aura's centre.
    const ang = Math.atan2(m.cy - v.cy, m.cx - v.cx);
    const ax = v.cx + v.r * PEAK_TIP_FACTOR * Math.cos(ang);
    const ay = v.cy + v.r * PEAK_TIP_FACTOR * Math.sin(ang);
    const bx = m.cx, by = m.cy;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    const perpX = len ? -dy / len : 0, perpY = len ? dx / len : 0;
    const sag = Math.min(len * 0.12, 28);
    const ctrlX = (ax + bx) / 2 + perpX * sag;
    const ctrlY = (ay + by) / 2 + perpY * sag;
    // Particles flow at a rate scaled by intensity — stronger
    // gravity pulls material in faster. Roughly 1.5s end-to-end
    // at full intensity, 4s at the edge.
    const speed = (0.004 + 0.012 * intensity);
    for (let i = 0; i < cached.particles.length; i++) {
      let phase = cached.phases[i] + speed;
      if (phase >= 1) {
        phase -= 1 + Math.random() * 0.08;   // small jitter on wrap
        if (phase < 0) phase = 0;
      }
      cached.phases[i] = phase;
      // Quadratic Bezier evaluation P(t) = (1-t)²P0 + 2(1-t)t P1 + t² P2
      const t = phase;
      const u = 1 - t;
      const px = u * u * ax + 2 * u * t * ctrlX + t * t * bx;
      const py = u * u * ay + 2 * u * t * ctrlY + t * t * by;
      const p = cached.particles[i];
      p.setAttribute('cx', px.toFixed(1));
      p.setAttribute('cy', py.toFixed(1));
      // Bright at the seed-end (just torn off) and fades as the
      // particle is "absorbed" into the aura's centre. Shrinks too —
      // the gravitational stretch metaphor. We keep a higher floor
      // than before so the streams stay readable at lower intensities.
      const fade = (1 - t) * 0.55 + 0.45;
      const shrink = (1 - t * 0.6).toFixed(2);
      const opacity = Math.min(1, intensity * 1.2) * fade;
      p.setAttribute('opacity', opacity.toFixed(3));
      p.setAttribute('r', (PARTICLE_BASE_R * shrink).toFixed(2));
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
