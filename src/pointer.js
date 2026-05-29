// Canvas pointer interactions: planting voices (tap-record), modifiers
// (single tap), bombs (single tap), and sweeps (tap-drag). Also owns
// seed selection (clicking an existing seed) and free-drag positioning.
//
// Includes the plant-mode chip strip (top bar) and the palette swatches
// (timbre role picker) since both are part of the "what am I planting"
// surface.

import { SPHERE_OPTIONS } from './constants.js';
import { BEAT_MS, BAR_MS } from './tempo.js';
import {
  TIMBRE_ROLES, activeRole, setActiveRole,
} from './timbres.js';
import { state, seeds, seedById } from './state.js';
import {
  canvasEl, canvasWrap, SVGNS,
  makeSeed, syncRenderedSeeds, renderSeed, renderSpheres, renderTethers,
} from './seeds.js';
import { setupAuraChain, auraEntry, auraHarmonics, auraBaseR } from './auras/registry.js';
import {
  PULSE_KINDS, SWEEP_KINDS, spawnPulse, spawnSweep,
} from './audio/events.js';
import { initAudio, audioCtx } from './audio/context.js';
import { selectSeed } from './inspector.js';
import { setDraggedSeed } from './scheduler.js';
import { takeSnapshot } from './snapshots.js';
import { setSetPlantModeFn } from './input.js';
import { refreshPadLights } from './output/minilab3.js';
import { labelFor } from './labels.js';

export function canvasCoords(evt) {
  const ctm = canvasEl.getScreenCTM();
  if (ctm) {
    const pt = canvasEl.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y, screenX: evt.clientX, screenY: evt.clientY };
  }
  const rect = canvasEl.getBoundingClientRect();
  return {
    x: ((evt.clientX - rect.left) / rect.width) * 1400,
    y: ((evt.clientY - rect.top) / rect.height) * 800,
    screenX: evt.clientX, screenY: evt.clientY,
  };
}

function seedAtCanvas(c) {
  let best = null, bestDist = Infinity;
  for (const s of seeds) {
    const d = Math.hypot(c.x - s.cx, c.y - s.cy);
    if (d <= s.r * 1.4 && d < bestDist) { bestDist = d; best = s; }
  }
  return best;
}

function startTap(c) {
  // Bomb modes spawn a one-shot event at the tap point
  if (PULSE_KINDS[state.plantMode]) {
    spawnPulse(c.x, c.y, state.plantMode);
    takeSnapshot('fired ' + state.plantMode);
    return;
  }
  // Sweep modes start a drag: user defines start and end with one gesture
  if (SWEEP_KINDS[state.plantMode]) {
    if (!audioCtx) initAudio();
    state.sweepDrag = {
      x0: c.x, y0: c.y,
      x1: c.x, y1: c.y,
      kind: state.plantMode,
    };
    return;
  }
  if (state.plantMode !== 'voice') {
    plantModifierAt(c);
    return;
  }
  // Voice mode + empty canvas → no-op. Voices are planted via MIDI
  // device or on-screen keyboard (which gives the pattern its pitch
  // and rhythm in one gesture). Earlier we tap-planted a single-step
  // seed here, but it produced unintended seeds whenever the user
  // clicked the canvas to dismiss something else, and a one-note
  // voice has no useful information.
}

function plantModifierAt(c) {
  const modKind = state.plantMode;
  // baseR, blob-silhouette harmonics, and kind-specific defaults all
  // come from the aura registry — see src/auras/registry.js.
  const entry = auraEntry(modKind);
  const seed = makeSeed({
    kind: 'modifier', modifierKind: modKind,
    cx: c.x, cy: c.y,
    r: auraBaseR(modKind),
    intervalMs: BEAT_MS,
    sphereR: SPHERE_OPTIONS[1].r,
    delayMs: BAR_MS * 3/16,
    reverbSec: 2.0,
    polyFactor: 2/3,
    harmonics: auraHarmonics(modKind),
    ...(entry ? entry.defaults : {}),
    label: modKind,
  });
  setupAuraChain(seed);
  for (const v of seeds.filter(s => s.kind === 'voice')) {
    const d = Math.hypot(v.cx - seed.cx, v.cy - seed.cy);
    if (d < seed.sphereR) {
      v.capturedByIds.add(seed.id);
      seed.capturedSeedIds.add(v.id);
    }
  }
  syncRenderedSeeds();
  selectSeed(seed.id);
  takeSnapshot('planted ' + labelFor(modKind));
}

canvasEl.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0) return;
  const c = canvasCoords(evt);
  const hit = seedAtCanvas(c);
  if (hit) { beginDrag(evt, hit.id); return; }
  startTap(c);
});

let drag = null;
function beginDrag(evt, seedId) {
  const seed = seedById(seedId);
  if (!seed) return;
  const c = canvasCoords(evt);
  drag = {
    seed, offsetX: c.x - seed.cx, offsetY: c.y - seed.cy, moved: false,
    // Recent-velocity tracking for release inertia. We keep a 3-frame
    // moving average so a quick wiggle at release doesn't get translated
    // into an oversized post-release flick.
    velSamples: [],
    lastX: seed.cx, lastY: seed.cy, lastT: performance.now(),
  };
  setDraggedSeed(seedId);   // tell physics to skip this one while held
  seed.vx = 0; seed.vy = 0; // kill any residual velocity from prior bumps
  selectSeed(seedId);
}

function continueDrag(evt) {
  if (!drag) return;
  const c = canvasCoords(evt);
  // Clamp the seed's centre so its visible body (radius) stays
  // entirely inside the canvas. Margin = 8 logical px beyond the
  // radius so the halo doesn't kiss the edge.
  const margin = 8 + (drag.seed.r || 0);
  drag.seed.cx = Math.max(margin, Math.min(1400 - margin, c.x - drag.offsetX));
  drag.seed.cy = Math.max(margin, Math.min(800  - margin, c.y - drag.offsetY));
  drag.moved = true;
  // Track per-frame velocity for release inertia. Pixels per ~16ms
  // tick converted into "units per physics tick" (≈ pixels/frame).
  const tnow = performance.now();
  const dt = Math.max(1, tnow - drag.lastT);
  const vx = (drag.seed.cx - drag.lastX) * (16 / dt);
  const vy = (drag.seed.cy - drag.lastY) * (16 / dt);
  drag.velSamples.push({ vx, vy });
  if (drag.velSamples.length > 3) drag.velSamples.shift();
  drag.lastX = drag.seed.cx;
  drag.lastY = drag.seed.cy;
  drag.lastT = tnow;
  renderSeed(drag.seed);
  if (drag.seed.kind === 'voice') {
    updateVoiceCaptures(drag.seed);
    renderTethers();
    renderSeed(drag.seed);
  } else if (drag.seed.kind === 'modifier') {
    // Aura dragged: its sphere + point cloud + tethers all need to
    // follow in real time. Without renderSpheres here, the gradient
    // ring + dots stay at the OLD position until pointerup.
    reevaluateAllCaptures();
    renderSpheres();
    renderTethers();
  }
}

// Sync a voice's capturedByIds with the modifiers whose spheres it's
// currently inside.
function updateVoiceCaptures(v) {
  if (!v.capturedByIds) v.capturedByIds = new Set();
  const newCaptors = new Set();
  for (const m of seeds.filter(s => s.kind === 'modifier')) {
    if (Math.hypot(v.cx - m.cx, v.cy - m.cy) < m.sphereR) {
      newCaptors.add(m.id);
    }
  }
  for (const id of v.capturedByIds) {
    if (!newCaptors.has(id)) {
      const m = seedById(id);
      if (m) m.capturedSeedIds.delete(v.id);
    }
  }
  for (const id of newCaptors) {
    if (!v.capturedByIds.has(id)) {
      const m = seedById(id);
      if (m) m.capturedSeedIds.add(v.id);
    }
  }
  v.capturedByIds = newCaptors;
}

export function reevaluateAllCaptures() {
  for (const v of seeds.filter(s => s.kind === 'voice')) {
    updateVoiceCaptures(v);
  }
}

function endDrag() {
  if (drag) {
    if (drag.seed.kind === 'modifier') renderSpheres();
    if (drag.moved) {
      // Release inertia — if the user let go while the pointer was
      // moving, the seed inherits that velocity scaled by 1/mass
      // (heavier seeds carry less inertia, lighter ones fly). Damping
      // in physicsStep gradually slows it. If the user let go while
      // stationary, the average velocity is ~0 and nothing happens.
      let avgX = 0, avgY = 0;
      for (const s of drag.velSamples) { avgX += s.vx; avgY += s.vy; }
      if (drag.velSamples.length > 0) {
        avgX /= drag.velSamples.length;
        avgY /= drag.velSamples.length;
        // Velocity scale: at mass 1 the inertia matches the drag
        // velocity. Heavier seeds keep less momentum (1/mass).
        const massScale = 1 / Math.max(0.3, drag.seed.mass || 1);
        drag.seed.vx = avgX * massScale;
        drag.seed.vy = avgY * massScale;
      }
      takeSnapshot('moved ' + drag.seed.label);
    }
    setDraggedSeed(null);   // physics can resume on this seed
    drag = null;
  }
}

function continueSweepDrag(evt) {
  if (!state.sweepDrag) return;
  const c = canvasCoords(evt);
  state.sweepDrag.x1 = c.x;
  state.sweepDrag.y1 = c.y;
}

function endSweepDrag() {
  if (!state.sweepDrag) return;
  spawnSweep(state.sweepDrag.x0, state.sweepDrag.y0, state.sweepDrag.x1, state.sweepDrag.y1, state.sweepDrag.kind);
  takeSnapshot('fired ' + state.sweepDrag.kind);
  state.sweepDrag = null;
}

window.addEventListener('pointermove', continueDrag);
window.addEventListener('pointermove', continueSweepDrag);
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointerup', endSweepDrag);

// === Plant-mode chip strip ===
export function setPlantMode(kind) {
  const opt = document.querySelector(`.plant-opt[data-kind="${kind}"]`);
  if (!opt) return;
  state.plantMode = kind;
  document.querySelectorAll('.plant-opt').forEach(el =>
    el.classList.toggle('active', el === opt));
  refreshPadLights();
  // Broadcast so the bloom/wind config window can refresh.
  window.dispatchEvent(new CustomEvent('plant-mode-changed', { detail: kind }));
}
document.getElementById('plant-group').addEventListener('click', (e) => {
  const opt = e.target.closest('.plant-opt');
  if (!opt) return;
  setPlantMode(opt.dataset.kind);
  // On mobile the palette is a slide-up drawer — auto-close after a
  // tool is picked so the canvas isn't covered.
  const palette = document.getElementById('tool-palette');
  if (palette && palette.classList.contains('open')) palette.classList.remove('open');
});
// Hand setPlantMode to input.js so MiniLab 3 bank-B pads can switch modes.
setSetPlantModeFn(setPlantMode);

// Tool-palette drawer toggle (visible only on narrow viewports — CSS
// handles the show/hide). Tapping the button slides the palette up;
// tapping anywhere else on the canvas closes it.
const toolPalette = document.getElementById('tool-palette');
const toolPaletteToggle = document.getElementById('tool-palette-toggle');
if (toolPaletteToggle && toolPalette) {
  toolPaletteToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    toolPalette.classList.toggle('open');
  });
  canvasEl.addEventListener('pointerdown', () => {
    if (toolPalette.classList.contains('open')) toolPalette.classList.remove('open');
  }, { capture: true });
}

// === Palette (active timbre role for new voices) ===
function buildPalette() {
  const el = document.getElementById('palette');
  if (!el) return;
  // Swatches sit under the "Seeds" tool-heading already — no need
  // for a redundant "palette" sub-label.
  el.innerHTML = '';
  for (const [roleKey, def] of Object.entries(TIMBRE_ROLES)) {
    const item = document.createElement('div');
    item.className = 'palette-item';
    if (roleKey === activeRole) item.classList.add('active');
    item.dataset.role = roleKey;
    item.innerHTML = `<span class="pal-dot" style="background:${def.color}"></span>${def.label}`;
    item.addEventListener('click', () => {
      setActiveRole(roleKey);
      document.querySelectorAll('.palette-item').forEach(x => x.classList.remove('active'));
      item.classList.add('active');
    });
    el.appendChild(item);
  }
}
buildPalette();
