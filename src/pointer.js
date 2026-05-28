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
  radiusForFundamental,
} from './seeds.js';
import { setupModifierChain } from './audio/chains.js';
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
  // Voice mode: plant one seed immediately at the click point with
  // the role's default pattern. The earlier tap-buffer melody
  // capture (multiple clicks → pitched pattern, after 1.4s timeout)
  // was removed — recording melodies now goes through the MIDI
  // device + on-screen keyboard exclusively, which gives clearer
  // semantic intent and works the same on every input source.
  plantVoiceSeedAt(c);
}

function plantVoiceSeedAt(c) {
  const role = TIMBRE_ROLES[activeRole] || TIMBRE_ROLES.melody;
  const gen = role.generate();
  // Pitch from Y position, biased into role's natural range.
  // Top of canvas = +1 octave, bottom = -1 octave from default.
  const yNorm = Math.max(0, Math.min(1, c.y / 800));
  const fundamental = gen.fundamentalHz * Math.pow(2, (0.5 - yNorm) * 1.6);
  const r = radiusForFundamental(fundamental);
  const labels = ['little wisp', 'soft hum', 'echo bone', 'spark', 'glimmer', 'small stone', 'feather', 'dapple', 'flicker', 'reed'];
  const label = labels[Math.floor(Math.random() * labels.length)];
  const seed = makeSeed({
    cx: c.x, cy: c.y, r,
    fundamental: Math.round(fundamental),
    decay: Math.round(gen.decay),
    intervalMs: Math.round(gen.intervalMs),
    harmonics: gen.harmonics,
    color: role.color,
    label,
    pattern: [{ offset: 0, velocity: 1.0 }],   // single-step default
    role: activeRole,
    synthesisModel: gen.synthesisModel,
    attackMs: gen.attackMs,
    patch: gen.patch,
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
  takeSnapshot('planted ' + label);
}

function plantModifierAt(c) {
  const modKind = state.plantMode;
  const baseR = modKind === 'weave' ? 30 : (modKind === 'ripple' ? 26 : (modKind === 'poly' ? 28 : 32));
  // Tiny harmonic shape per modifier kind so the blob silhouette hints
  // at character even before any voices are captured.
  const harmonics = new Array(12).fill(0);
  if (modKind === 'weave')       { harmonics[2] = 0.06; harmonics[5] = 0.04; }
  else if (modKind === 'ripple') { harmonics[2] = 0.05; harmonics[5] = 0.03; }
  else if (modKind === 'poly')   { harmonics[1] = 0.06; harmonics[4] = 0.04; harmonics[7] = 0.03; }
  else                            { harmonics[1] = 0.03; harmonics[3] = 0.02; }
  const seed = makeSeed({
    kind: 'modifier', modifierKind: modKind,
    cx: c.x, cy: c.y,
    r: baseR,
    intervalMs: BEAT_MS,
    sphereR: SPHERE_OPTIONS[1].r,
    delayMs: BAR_MS * 3/16,
    reverbSec: 2.0,
    polyFactor: 2/3,
    harmonics,
    label: modKind,
  });
  setupModifierChain(seed);
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
  drag = { seed, offsetX: c.x - seed.cx, offsetY: c.y - seed.cy, moved: false };
  setDraggedSeed(seedId);   // tell physics to skip this one while held
  seed.vx = 0; seed.vy = 0; // kill any residual velocity from prior bumps
  selectSeed(seedId);
}

function continueDrag(evt) {
  if (!drag) return;
  const c = canvasCoords(evt);
  drag.seed.cx = Math.max(40, Math.min(1360, c.x - drag.offsetX));
  drag.seed.cy = Math.max(40, Math.min(760, c.y - drag.offsetY));
  drag.moved = true;
  renderSeed(drag.seed);
  if (drag.seed.kind === 'voice') {
    updateVoiceCaptures(drag.seed);
    renderTethers();
    renderSeed(drag.seed);
  } else if (drag.seed.kind === 'modifier') {
    reevaluateAllCaptures();
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
    if (drag.moved) takeSnapshot('moved ' + drag.seed.label);
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
