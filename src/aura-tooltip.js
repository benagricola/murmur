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
// intensity (0..1) at the seed's current position. Sorted
// alphabetically by aura label — sorting by intensity made the list
// flip order constantly as a drifting seed crossed close-strength
// thresholds, which was visually distracting.
function effectsForSeed(seed) {
  if (!seed || seed.kind !== 'voice') return [];
  const out = [];
  for (const m of seeds) {
    if (m.kind !== 'modifier') continue;
    const intensity = auraIntensityForSeed(m, seed);
    if (intensity < 0.01) continue;
    out.push({ aura: m, intensity });
  }
  out.sort((a, b) => labelFor(a.aura.modifierKind).localeCompare(labelFor(b.aura.modifierKind)));
  return out;
}

// When the hovered thing IS an aura, report what's INSIDE it
// instead of which auras affect it (which is always zero — auras
// don't get captured by other auras). Same alphabetical sort.
function seedsInAura(aura) {
  if (!aura || aura.kind !== 'modifier') return [];
  const out = [];
  for (const s of seeds) {
    if (s.kind !== 'voice') continue;
    const intensity = auraIntensityForSeed(aura, s);
    if (intensity < 0.01) continue;
    out.push({ seed: s, intensity });
  }
  out.sort((a, b) => String(a.seed.label || '').localeCompare(String(b.seed.label || '')));
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

// Compact pattern preview for a tonal seed — one dot per pattern
// step, lit if hit, dim if rest. The currently-playing step gets a
// bright outline so the preview reads "live". seed.currentStep is
// updated by the scheduler at each step's fire time (see
// playSeedStep's setTimeout), so this refreshes naturally as the
// tooltip re-renders from visualTick.
function renderPatternPreview(seed) {
  if (!seed.pattern || seed.pattern.length === 0) return '';
  const MAX = 32;
  const steps = seed.pattern.slice(0, MAX);
  const current = seed.currentStep;
  const dots = steps.map((s, idx) => {
    const lit = (s.velocity || 0) > 0.05;
    const isCurrent = idx === current;
    const cls = isCurrent ? 'aura-tooltip-step current' : 'aura-tooltip-step';
    const colour = lit ? (seed.color || '#fff') : 'rgba(255,255,255,0.15)';
    return `<span class="${cls}" style="background:${colour}"></span>`;
  }).join('');
  const more = seed.pattern.length > MAX
    ? `<span class="aura-tooltip-step-more">+${seed.pattern.length - MAX}</span>`
    : '';
  return `<div class="aura-tooltip-pattern">${dots}${more}</div>`;
}

// Called from scheduler.visualTick while something is hovered so
// the values update live for drifting seeds + changing aura configs.
export function refreshTooltip() {
  if (!tooltipEl || hoveredSeedId == null) return;
  const seed = seedById(hoveredSeedId);
  if (!seed) { tooltipEl.classList.remove('open'); hoveredSeedId = null; return; }

  // Two display modes — voice seed hover shows "what auras are
  // affecting me". Aura hover shows "what am I affecting + my
  // settings". Different question, different answer.
  if (seed.kind === 'voice') {
    const effects = effectsForSeed(seed);
    const title = `<div class="aura-tooltip-title">${escapeHtml(seed.label || 'seed')}</div>`;
    const pattern = renderPatternPreview(seed);
    let body;
    if (effects.length === 0) {
      body = `<div class="aura-tooltip-empty">no auras affecting</div>`;
    } else {
      body = `<div class="aura-tooltip-section">affected by:</div>`;
      body += effects.map(e => {
        const colour = e.aura.color || '#aaa';
        return `<div class="aura-tooltip-row">
          <span class="dot" style="background:${colour}"></span>
          <span class="name">${escapeHtml(labelFor(e.aura.modifierKind))}</span>
          <span class="val">${escapeHtml(effectValueLabel(e.aura, e.intensity))}</span>
        </div>`;
      }).join('');
    }
    tooltipEl.innerHTML = title + pattern + body;
  } else if (seed.kind === 'modifier') {
    const inside = seedsInAura(seed);
    const colour = seed.color || '#aaa';
    const settings = auraSettingsLine(seed);
    const title = `<div class="aura-tooltip-title">
      <span class="dot" style="background:${colour}"></span>
      ${escapeHtml(labelFor(seed.modifierKind))} aura
    </div>`;
    let body = settings ? `<div class="aura-tooltip-settings">${escapeHtml(settings)}</div>` : '';
    if (inside.length === 0) {
      body += `<div class="aura-tooltip-empty">no seeds inside</div>`;
    } else {
      body += `<div class="aura-tooltip-section">affecting:</div>`;
      body += inside.map(e => `<div class="aura-tooltip-row">
        <span class="dot" style="background:${e.seed.color || '#888'}"></span>
        <span class="name">${escapeHtml(e.seed.label || 'seed')}</span>
        <span class="val">${Math.round(e.intensity * 100)}%</span>
      </div>`).join('');
    }
    tooltipEl.innerHTML = title + body;
  }
  positionTooltip();
}

// One-line description of what the aura currently does. Pulls the
// kind-specific parameter so the user knows e.g. swing strength,
// delay time, drive amount.
function auraSettingsLine(aura) {
  const k = aura.modifierKind;
  if (k === 'weave')  return `swing ${(aura.swing || 0.5).toFixed(2)}`;
  if (k === 'ripple') return `delay ${Math.round(aura.delayMs || 0)} ms`;
  if (k === 'cloud')  return `reverb ${(aura.reverbSec || 0).toFixed(1)} s`;
  if (k === 'poly')   return `ratio ${(aura.polyFactor || 1).toFixed(2)}`;
  if (k === 'drive')  return `drive ×${(aura.driveAmount || 0).toFixed(1)}`;
  if (k === 'gain')   return `boost ${(aura.gainAmount || 1).toFixed(2)}× at centre`;
  if (k === 'mute')   return `hush ${(aura.gainAmount || 0).toFixed(2)}× at centre`;
  return '';
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
