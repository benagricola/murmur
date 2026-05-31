// The plant palette (left tool drawer) as a collapsible accordion.
//
// The flat list of ~19 plantables was hard to scan and the garden names
// (weave / vine / hush …) are deliberately non-descriptive, so nothing
// told you what a tool actually did. This groups them by musical role
// and gives each a quiet one-word function hint inline (WEAVE · swing)
// plus a richer sentence on hover.
//
// Behaviour:
//   - single-open accordion; only the selected item's group starts open.
//   - selecting any item (click, pad, or encoder) opens its group and
//     closes the others — see openGroupForKind, called from setPlantMode.
//   - the MiniLab main rotary walks the whole flat list (stepPlantSelection),
//     auto-opening groups as it crosses a boundary.
//
// Item clicks are still handled by pointer.js's delegated #plant-group
// listener (→ setPlantMode); this module only owns structure, the
// section heads, the hover tip, and encoder stepping.

import { state } from './state.js';
import { setPlantMode } from './pointer.js';

// Group taxonomy. `fn` is the inline hint word; `tip` is the hover
// sentence; `color` matches the per-kind dot colour in styles.css and
// is only used to tint the tooltip's dot. `event: true` marks one-shot
// groups so their items get the hollow-ring .event-opt styling.
export const PALETTE_GROUPS = [
  { id: 'instrument', label: 'INSTRUMENT', items: [
    { kind: 'voice', name: 'seed', fn: 'instrument', color: '#5fd2e8',
      tip: 'A musical voice. Tap-record a pattern and it loops on the grid.' },
  ] },
  { id: 'rhythm', label: 'RHYTHM', items: [
    { kind: 'weave', name: 'weave', fn: 'swing', color: '#ffa94d',
      tip: 'Nudges captured notes off the grid for a looser, swung feel.' },
    { kind: 'poly', name: 'vine', fn: 'polyrhythm', color: '#9be9a8',
      tip: 'Bends captured seeds into a cross-rhythm against the main pulse.' },
    { kind: 'shift', name: 'shift', fn: 're-roll', color: '#ffac4d',
      tip: 'Cycles captured seeds through their saved pattern variants.' },
  ] },
  { id: 'space', label: 'SPACE', items: [
    { kind: 'ripple', name: 'ripple', fn: 'echo', color: '#e8a8c8',
      tip: 'Adds tempo-synced echoes trailing behind each captured note.' },
    { kind: 'cloud', name: 'cloud', fn: 'reverb', color: '#d0d8e8',
      tip: 'Washes captured seeds in a soft reverberant haze.' },
  ] },
  { id: 'tone', label: 'TONE', items: [
    { kind: 'drive', name: 'drive', fn: 'overdrive', color: '#ff7a4d',
      tip: 'Pushes captured seeds into warm harmonic distortion.' },
    { kind: 'crush', name: 'crush', fn: 'lo-fi', color: '#ff5577',
      tip: 'Bit-crushes and downsamples captured seeds for a gritty lo-fi edge.' },
    { kind: 'squash', name: 'squash', fn: 'pump', color: '#7ad6ff',
      tip: 'Compresses captured seeds, adding punch and a pumping groove.' },
  ] },
  { id: 'motion', label: 'MOTION', items: [
    { kind: 'wobble', name: 'wobble', fn: 'warble', color: '#c478ff',
      tip: 'Modulates pitch and filter for a wavering, seasick warble.' },
    { kind: 'pan', name: 'pan', fn: 'auto-pan', color: '#5fd0a0',
      tip: 'Sweeps captured seeds back and forth across the stereo field.' },
  ] },
  { id: 'level', label: 'LEVEL', items: [
    { kind: 'gain', name: 'boost', fn: 'louder', color: '#ffe066',
      tip: 'Lifts the volume of captured seeds.' },
    { kind: 'mute', name: 'hush', fn: 'quieter', color: '#7a7f8e',
      tip: 'Pulls down the volume of captured seeds.' },
  ] },
  { id: 'modulator', label: 'MODULATOR', items: [
    { kind: 'runner', name: 'runner', fn: 'LFO source', color: '#4de0c8',
      tip: 'Sends tendrils that slowly oscillate a target’s strength, volume, pitch or pan.' },
  ] },
  { id: 'oneshots', label: 'ONE-SHOTS', event: true, items: [
    { kind: 'drop', name: 'drop', fn: 'cut', color: '#ff4d80',
      tip: 'A bloom that momentarily silences every seed it touches.' },
    { kind: 'muffle', name: 'muffle', fn: 'dampen', color: '#5e7ad8',
      tip: 'A bloom that sweeps a low-pass over the seeds it touches.' },
    { kind: 'thin', name: 'thin', fn: 'brighten', color: '#ffd84d',
      tip: 'A bloom that sweeps a high-pass over the seeds it touches.' },
    { kind: 'rise', name: 'rise', fn: 'unmute', color: '#5af095',
      tip: 'A wind that un-mutes each seed as the front passes over it.' },
    { kind: 'fade', name: 'fade', fn: 'mute', color: '#ff7a8c',
      tip: 'A wind that mutes each seed as the front passes over it.' },
  ] },
];

// Flat plant order for the encoder — groups concatenated top-to-bottom.
function flatKinds() {
  const out = [];
  for (const g of PALETTE_GROUPS) for (const it of g.items) out.push(it.kind);
  return out;
}

// === Hover tooltip (single reusable, fixed-position element) ===
let tipEl = null;
function ensureTip() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'palette-tip';
  document.body.appendChild(tipEl);
  return tipEl;
}
function showTip(opt, it) {
  const el = ensureTip();
  el.innerHTML =
    `<div class="palette-tip-head">` +
      `<span class="pt-dot" style="background:${it.color}"></span>` +
      `<span class="pt-name">${it.name}</span>` +
      `<span class="pt-fn">${it.fn}</span>` +
    `</div>` +
    `<div class="palette-tip-body">${it.tip}</div>`;
  el.classList.add('open');
  // Position to the right of the item, clamped to the viewport so it
  // never spills off-screen. Measured after .open so offsetHeight is real.
  const r = opt.getBoundingClientRect();
  const h = el.offsetHeight;
  let top = r.top - 2;
  if (top + h > window.innerHeight - 8) top = window.innerHeight - 8 - h;
  el.style.left = Math.round(r.right + 10) + 'px';
  el.style.top = Math.round(Math.max(8, top)) + 'px';
}
function hideTip() { if (tipEl) tipEl.classList.remove('open'); }

// Single-open: opening one section collapses the rest.
function toggleSection(section) {
  const root = section.parentElement;
  const wasOpen = section.classList.contains('open');
  root.querySelectorAll('.plant-section.open').forEach(s => s.classList.remove('open'));
  if (!wasOpen) section.classList.add('open');
}

// Ensure the group containing `kind` is the open one, and keep the
// active item in view. Called by setPlantMode for every selection path
// (click / pad / encoder), so the open group always tracks selection.
export function openGroupForKind(kind) {
  const root = document.getElementById('plant-group');
  if (!root) return;
  const opt = root.querySelector(`.plant-opt[data-kind="${kind}"]`);
  if (!opt) return;
  const section = opt.closest('.plant-section');
  root.querySelectorAll('.plant-section.open').forEach(s => {
    if (s !== section) s.classList.remove('open');
  });
  if (section) {
    section.classList.add('open');
    try { opt.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }
}

// Encoder: step selection through the flat list, wrapping at the ends.
export function stepPlantSelection(dir) {
  const flat = flatKinds();
  let idx = flat.indexOf(state.plantMode);
  if (idx < 0) idx = 0;
  const n = flat.length;
  const next = (((idx + (dir >= 0 ? 1 : -1)) % n) + n) % n;
  setPlantMode(flat[next]);
}

export function renderPaletteAccordion() {
  const root = document.getElementById('plant-group');
  if (!root) return;
  const selected = state.plantMode || 'voice';
  root.innerHTML = '';
  for (const g of PALETTE_GROUPS) {
    const hasSelected = g.items.some(i => i.kind === selected);
    const section = document.createElement('div');
    section.className = 'plant-section' + (hasSelected ? ' open' : '');
    section.dataset.group = g.id;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'plant-section-head';
    head.innerHTML =
      `<span class="sect-chevron">▸</span>` +
      `<span class="sect-name">${g.label}</span>` +
      `<span class="sect-count">${g.items.length}</span>`;
    head.addEventListener('click', () => toggleSection(section));
    section.appendChild(head);

    const body = document.createElement('div');
    body.className = 'plant-section-body';
    for (const it of g.items) {
      const opt = document.createElement('div');
      opt.className = 'plant-opt' + (g.event ? ' event-opt' : '') +
        (it.kind === selected ? ' active' : '');
      opt.dataset.kind = it.kind;
      opt.innerHTML =
        `<span class="dot"></span>` +
        `<span class="opt-name">${it.name}</span>` +
        `<span class="opt-fn">${it.fn}</span>`;
      opt.addEventListener('mouseenter', () => showTip(opt, it));
      opt.addEventListener('mouseleave', hideTip);
      body.appendChild(opt);
      // The seed timbre-role swatches live just under the seed item;
      // pointer.js's buildPalette() fills this once it exists.
      if (it.kind === 'voice') {
        const pal = document.createElement('div');
        pal.className = 'palette';
        pal.id = 'palette';
        body.appendChild(pal);
      }
    }
    section.appendChild(body);
    root.appendChild(section);
  }
}
// Render is driven explicitly from pointer.js (before its buildPalette,
// which depends on #palette existing) so it doesn't hinge on the
// circular import-evaluation order between the two modules.
