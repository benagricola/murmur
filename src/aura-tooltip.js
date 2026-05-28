// Hover tooltip — shows every aura currently affecting the hovered
// seed, with its intensity (or computed gain multiplier). Live-
// updating: if the seed is drifting, the list and values change as
// it moves in and out of fields. Especially important when several
// auras overlap and the user needs to see the net result.
//
// Position: follows the cursor with a small offset. Hidden on
// pointer-leave or when no seed is under the cursor.

import { seeds, seedById } from './state.js';
import { auraIntensityForSeed, seedsLayer } from './seeds.js';
import { labelFor } from './labels.js';

let tooltipEl = null;
let hoveredSeedId = null;
let lastMouseX = 0, lastMouseY = 0;

function buildTooltip() {
  const el = document.createElement('div');
  el.className = 'aura-tooltip';
  el.id = 'aura-tooltip';
  document.body.appendChild(el);
  return el;
}

export function setHoveredSeed(id) {
  if (hoveredSeedId === id) return;
  hoveredSeedId = id;
  if (!tooltipEl) tooltipEl = buildTooltip();
  if (id == null) {
    tooltipEl.classList.remove('open');
  } else {
    tooltipEl.classList.add('open');
    refreshTooltip();
  }
}

export function getHoveredSeedId() { return hoveredSeedId; }

export function updateMousePos(x, y) {
  lastMouseX = x; lastMouseY = y;
  if (tooltipEl && hoveredSeedId != null) positionTooltip();
}

function positionTooltip() {
  if (!tooltipEl) return;
  let x = lastMouseX + 16;
  let y = lastMouseY + 8;
  const w = tooltipEl.offsetWidth || 180;
  const h = tooltipEl.offsetHeight || 80;
  if (x + w > window.innerWidth - 8)  x = lastMouseX - w - 16;
  if (y + h > window.innerHeight - 8) y = lastMouseY - h - 16;
  if (y < 8) y = 8;
  if (x < 8) x = 8;
  tooltipEl.style.left = x + 'px';
  tooltipEl.style.top  = y + 'px';
}

// Build the list of every aura affecting this seed right now, with
// intensity (0..1) at the seed's current position. Sorted strongest
// first so the most-important effect reads first.
function effectsForSeed(seed) {
  if (!seed || seed.kind !== 'voice') return [];
  const out = [];
  for (const m of seeds) {
    if (m.kind !== 'modifier') continue;
    const intensity = auraIntensityForSeed(m, seed);
    if (intensity < 0.01) continue;
    out.push({ aura: m, intensity });
  }
  out.sort((a, b) => b.intensity - a.intensity);
  return out;
}

// For gain/mute we show the resulting multiplier directly because
// "× 1.4" is more useful than "intensity 50%". For others, the
// intensity % is what the user reaches for.
function effectValueLabel(aura, intensity) {
  const kind = aura.modifierKind;
  if (kind === 'gain' || kind === 'mute') {
    const amount = aura.gainAmount != null
      ? aura.gainAmount
      : (kind === 'gain' ? 1.6 : 0.0);
    const mult = 1 + (amount - 1) * intensity;
    return `${mult.toFixed(2)}×`;
  }
  return `${Math.round(intensity * 100)}%`;
}

// Called from scheduler.visualTick while a seed is hovered so the
// values update live for drifting seeds and changing aura configs.
export function refreshTooltip() {
  if (!tooltipEl || hoveredSeedId == null) return;
  const seed = seedById(hoveredSeedId);
  if (!seed) { tooltipEl.classList.remove('open'); hoveredSeedId = null; return; }
  const effects = effectsForSeed(seed);
  const title = `<div class="aura-tooltip-title">${escapeHtml(seed.label || 'seed')}</div>`;
  if (effects.length === 0) {
    tooltipEl.innerHTML = title + `<div class="aura-tooltip-empty">no auras</div>`;
  } else {
    const rows = effects.map(e => {
      const colour = e.aura.color || '#aaa';
      return `<div class="aura-tooltip-row">
        <span class="dot" style="background:${colour}"></span>
        <span class="name">${escapeHtml(labelFor(e.aura.modifierKind))}</span>
        <span class="val">${escapeHtml(effectValueLabel(e.aura, e.intensity))}</span>
      </div>`;
    }).join('');
    tooltipEl.innerHTML = title + rows;
  }
  positionTooltip();
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Event delegation on the seeds layer — entering a seed-wrap sets
// the hovered id; moving outside clears it. mousemove also tracks
// cursor position for tooltip placement.
if (seedsLayer) {
  seedsLayer.addEventListener('mousemove', (e) => {
    const wrap = e.target.closest('.seed-wrap');
    if (!wrap) { setHoveredSeed(null); return; }
    const id = parseInt(wrap.dataset.seedId);
    if (!Number.isNaN(id)) setHoveredSeed(id);
    updateMousePos(e.clientX, e.clientY);
  });
  seedsLayer.addEventListener('mouseleave', () => setHoveredSeed(null));
}
