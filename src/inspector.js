// Right-side seed inspector panel.
// Selecting a seed (pointer.js) opens this; the panel shows the seed's
// role, pitch, rhythm, length, harmonics, melody pattern, mute state.
// Each control wires through takeSnapshot so tweaks persist into the
// snapshot history.

import {
  RHYTHM_OPTIONS, LENGTH_OPTIONS, SPHERE_OPTIONS, RIPPLE_DELAY_OPTIONS,
  CLOUD_SIZE_OPTIONS, SWING_OPTIONS, POLY_RATIOS,
  nearestOptionIdx, snapToScale, freqFromMidi, midiFromFreq, noteName,
} from './constants.js';
import { audioCtx, NUM_HARMONICS } from './audio/context.js';
import { BAR_MS } from './tempo.js';
import { createReverbIR } from './audio/chains.js';
import { TIMBRE_ROLES } from './timbres.js';
import { seeds, seedById, state } from './state.js';
import {
  SVGNS, renderSeed, removeSeed, radiusForFundamental, syncRenderedSeeds,
} from './seeds.js';
import { setStepHighlightHandler, playNoteAt } from './scheduler.js';
import { refreshSelectionLights, paintScreen } from './output/minilab3.js';
import { ensureAudio } from './audio/context.js';
import { labelFor, categoryLabel } from './labels.js';

let takeSnapshotFn = (label) => {};
let reevaluateAllCapturesFn = () => {};
export function setTakeSnapshotFn(fn) { takeSnapshotFn = fn; }
export function setReevaluateAllCapturesFn(fn) { reevaluateAllCapturesFn = fn; }

export const inspectorEl = document.getElementById('inspector');
const harmonicEditorEl = document.getElementById('harmonic-editor');
const hNumbersEl = document.getElementById('h-numbers');
const patternEditorEl = document.getElementById('pattern-editor');
const velocityEditorEl = document.getElementById('velocity-editor');

for (let i = 0; i < NUM_HARMONICS; i++) {
  const bar = document.createElement('div');
  bar.className = 'h-bar';
  bar.dataset.idx = i;
  bar.style.height = '2px';
  harmonicEditorEl.appendChild(bar);
  const num = document.createElement('div');
  num.className = 'h-num';
  num.textContent = i + 2;
  hNumbersEl.appendChild(num);
}

function buildPicker(el, options, onSelect, getCurrent) {
  el.innerHTML = '';
  options.forEach((opt, i) => {
    const o = document.createElement('div');
    o.className = 'picker-opt';
    o.textContent = opt.label;
    o.dataset.idx = i;
    if (i === getCurrent()) o.classList.add('active');
    o.addEventListener('click', () => {
      el.querySelectorAll('.picker-opt').forEach(x => x.classList.remove('active'));
      o.classList.add('active');
      onSelect(opt, i);
    });
    el.appendChild(o);
  });
}

export function selectSeed(id) {
  const seed = seedById(id);
  if (!seed) return;
  state.selectedSeedId = id;
  syncRenderedSeeds();
  document.getElementById('insp-title').textContent = seed.label;
  // Sub-line: "aura · ripple" or "seed · melody · amber willow".
  // The generative patch name lets the user tell at a glance
  // whether a re-roll actually produced a new sound.
  const patchName = seed.patch && seed.patch.name;
  let subLine;
  if (seed.kind === 'modifier') {
    subLine = `${categoryLabel('modifier')} · ${labelFor(seed.modifierKind)}`;
  } else {
    subLine = `${categoryLabel('voice')}${seed.role ? ' · ' + seed.role : ''}`;
    if (patchName) subLine += ' · ' + patchName;
  }
  document.getElementById('insp-sub').textContent = subLine;

  const presetRow = document.getElementById('preset-row');
  const regenBtn = document.getElementById('regen-btn');
  if (seed.kind === 'voice') {
    presetRow.style.display = '';
    regenBtn.style.display = '';
    const roleKeys = Object.keys(TIMBRE_ROLES);
    buildPicker(
      document.getElementById('preset-picker'),
      roleKeys.map(k => ({ label: TIMBRE_ROLES[k].label, key: k })),
      (opt) => {
        const gen = TIMBRE_ROLES[opt.key].generate();
        seed.harmonics = gen.harmonics;
        seed.decay = gen.decay;
        seed.decayFrac = gen.decay / BAR_MS;
        seed.attackMs = gen.attackMs;
        seed.attackFrac = gen.attackMs / BAR_MS;
        seed.synthesisModel = gen.synthesisModel;
        seed.patch = gen.patch;
        seed._cachedPatch = null;
        seed.role = opt.key;
        seed.color = TIMBRE_ROLES[opt.key].color;
        syncRenderedSeeds();
        selectSeed(seed.id);
        takeSnapshotFn('switched to ' + opt.label);
      },
      () => Math.max(0, roleKeys.indexOf(seed.role || 'melody'))
    );
  } else {
    presetRow.style.display = 'none';
    regenBtn.style.display = 'none';
  }
  const pitchRow = document.getElementById('pitch-row');
  if (seed.kind === 'voice') {
    pitchRow.style.display = '';
    const midi = midiFromFreq(seed.fundamental);
    document.getElementById('pitch-slider').value = midi;
    document.getElementById('pitch-val').textContent = noteName(snapToScale(midi));
  } else {
    pitchRow.style.display = 'none';
  }
  const rhythmRow = document.getElementById('rhythm-row');
  rhythmRow.style.display = '';
  if (seed.kind === 'modifier' && seed.modifierKind === 'weave') {
    document.querySelector('#rhythm-row label').textContent = 'swing';
    buildPicker(
      document.getElementById('rhythm-picker'),
      SWING_OPTIONS,
      (opt) => {
        seed.swing = opt.val;
        for (const v of seeds) {
          if (v.capturedByIds && v.capturedByIds.has(seed.id)) v.nextTrigger = 0;
        }
        takeSnapshotFn('swing: ' + opt.label);
      },
      () => {
        const sw = seed.swing || 0.5;
        let best = 0, bestDiff = Infinity;
        for (let i = 0; i < SWING_OPTIONS.length; i++) {
          const d = Math.abs(SWING_OPTIONS[i].val - sw);
          if (d < bestDiff) { bestDiff = d; best = i; }
        }
        return best;
      }
    );
  } else if (seed.kind === 'modifier' && seed.modifierKind === 'ripple') {
    document.querySelector('#rhythm-row label').textContent = 'delay';
    buildPicker(
      document.getElementById('rhythm-picker'),
      RIPPLE_DELAY_OPTIONS,
      (opt) => {
        seed.delayMs = opt.ms;
        seed.delayFrac = opt.frac;     // canonical bar-fraction storage
        if (seed.delayNode) seed.delayNode.delayTime.setTargetAtTime(opt.ms / 1000, audioCtx.currentTime, 0.02);
        takeSnapshotFn('tweaked delay');
      },
      () => nearestOptionIdx(RIPPLE_DELAY_OPTIONS, seed.delayMs)
    );
  } else if (seed.kind === 'modifier' && seed.modifierKind === 'cloud') {
    document.querySelector('#rhythm-row label').textContent = 'size';
    buildPicker(
      document.getElementById('rhythm-picker'),
      CLOUD_SIZE_OPTIONS.map(o => ({ label: o.label, ms: o.sec })),
      (opt) => {
        seed.reverbSec = opt.ms;
        if (seed.convolver && audioCtx) {
          seed.convolver.buffer = createReverbIR(opt.ms);
        }
        takeSnapshotFn('tweaked size');
      },
      () => nearestOptionIdx(CLOUD_SIZE_OPTIONS.map(o => ({ms: o.sec})), seed.reverbSec || 2.0)
    );
  } else if (seed.kind === 'modifier' && seed.modifierKind === 'poly') {
    document.querySelector('#rhythm-row label').textContent = 'ratio';
    buildPicker(
      document.getElementById('rhythm-picker'),
      POLY_RATIOS.map(r => ({ label: r.label, val: r.factor })),
      (opt) => {
        seed.polyFactor = opt.val;
        for (const v of seeds) {
          if (v.capturedByIds && v.capturedByIds.has(seed.id)) v.nextTrigger = 0;
        }
        takeSnapshotFn('ratio: ' + opt.label);
      },
      () => {
        const pf = seed.polyFactor || 2/3;
        let best = 0, bestDiff = Infinity;
        for (let i = 0; i < POLY_RATIOS.length; i++) {
          const d = Math.abs(POLY_RATIOS[i].factor - pf);
          if (d < bestDiff) { bestDiff = d; best = i; }
        }
        return best;
      }
    );
  } else {
    document.querySelector('#rhythm-row label').textContent = 'rhythm';
    buildPicker(
      document.getElementById('rhythm-picker'),
      RHYTHM_OPTIONS,
      (opt) => {
        seed.intervalMs = opt.ms;
        seed.intervalFrac = opt.frac;   // canonical bar-fraction storage
        updatePatternLoopInfo(seed);
        takeSnapshotFn('tweaked rhythm');
      },
      () => nearestOptionIdx(RHYTHM_OPTIONS, seed.intervalMs)
    );
  }
  const lengthRow = document.getElementById('length-row');
  if (seed.kind === 'voice') {
    lengthRow.style.display = '';
    buildPicker(
      document.getElementById('length-picker'),
      LENGTH_OPTIONS,
      (opt) => {
        seed.decay = opt.ms;
        seed.decayFrac = opt.frac;     // canonical bar-fraction storage
        takeSnapshotFn('tweaked length');
      },
      () => nearestOptionIdx(LENGTH_OPTIONS, seed.decay)
    );
  } else {
    lengthRow.style.display = 'none';
  }
  const volRow = document.getElementById('volume-row');
  if (seed.kind === 'voice') {
    volRow.style.display = '';
    const slider = document.getElementById('seed-vol-slider');
    const val = document.getElementById('seed-vol-val');
    const pct = Math.round((seed.gain || 0.35) * 100);
    slider.value = pct;
    val.textContent = pct + '%';
  } else {
    volRow.style.display = 'none';
  }
  const qRow = document.getElementById('quantize-row');
  if (seed.kind === 'voice') {
    qRow.style.display = '';
    document.getElementById('quantize-toggle').classList.toggle('on', seed.quantize);
  } else {
    qRow.style.display = 'none';
  }
  const mRow = document.getElementById('mute-row');
  if (seed.kind === 'voice') {
    mRow.style.display = '';
    document.getElementById('mute-toggle').classList.toggle('on', !!seed.muted);
  } else {
    mRow.style.display = 'none';
  }
  const lRow = document.getElementById('loop-row');
  if (seed.kind === 'voice') {
    lRow.style.display = '';
    document.getElementById('loop-toggle').classList.toggle('on', seed.loop !== false);
  } else {
    lRow.style.display = 'none';
  }
  document.getElementById('harmonic-section').style.display = seed.kind === 'voice' ? '' : 'none';
  document.getElementById('pattern-section').style.display = seed.kind === 'voice' ? '' : 'none';
  if (seed.kind === 'voice') {
    const bars = harmonicEditorEl.querySelectorAll('.h-bar');
    bars.forEach((bar, i) => {
      const amp = seed.harmonics[i] || 0;
      bar.style.height = Math.max(2, amp * 80) + 'px';
      bar.style.background = amp > 0.05 ? seed.color : '';
    });
    renderPatternEditor(seed);
    renderVelocityEditor(seed);
    updatePatternLoopInfo(seed);
  }
  const sphereRow = document.getElementById('sphere-row');
  if (seed.kind === 'modifier') {
    sphereRow.style.display = '';
    buildPicker(
      document.getElementById('sphere-picker'),
      SPHERE_OPTIONS,
      (opt) => {
        seed.sphereR = opt.r;
        reevaluateAllCapturesFn();
        syncRenderedSeeds();
        takeSnapshotFn('tweaked reach');
      },
      () => nearestOptionIdx(SPHERE_OPTIONS.map(o => ({ms: o.r})), seed.sphereR)
    );
  } else {
    sphereRow.style.display = 'none';
  }
  const capInfo = document.getElementById('captured-info');
  if (seed.kind === 'voice' && seed.capturedByIds && seed.capturedByIds.size > 0) {
    const ms = [...seed.capturedByIds].map(id => seedById(id)).filter(Boolean);
    capInfo.style.display = '';
    capInfo.textContent = `held by ${ms.map(m => m.label).join(' + ')}`;
  } else if (seed.kind === 'modifier' && seed.capturedSeedIds.size > 0) {
    capInfo.style.display = '';
    capInfo.textContent = `holding ${seed.capturedSeedIds.size} voice${seed.capturedSeedIds.size === 1 ? '' : 's'}`;
  } else {
    capInfo.style.display = 'none';
  }
  inspectorEl.classList.add('open');
  refreshSelectionLights();
  paintScreen();
}

function updatePatternLoopInfo(seed) {
  if (seed.kind !== 'voice') return;
  const chordCount = seed.pattern.filter(s => s.extras && s.extras.length > 0).length;
  const stepLabel = seed.pattern.length + ' step' + (seed.pattern.length > 1 ? 's' : '');
  document.getElementById('pattern-len-info').textContent =
    chordCount > 0 ? `${stepLabel} · ${chordCount} chord${chordCount > 1 ? 's' : ''}` : stepLabel;
  document.getElementById('pattern-loop-info').textContent =
    ((seed.pattern.length * seed.intervalMs) / 1000).toFixed(1) + 's loop';
}

function renderPatternEditor(seed) {
  patternEditorEl.innerHTML = '';
  const W = 276, H = 100, pad = 14;
  const usableH = H - pad * 2;
  const stepW = (W - pad * 2) / Math.max(1, seed.pattern.length);
  const offsetRange = 14;
  const offsetToY = o => pad + usableH / 2 - (o / offsetRange) * (usableH / 2 - 4);
  const refLine = document.createElementNS(SVGNS, 'line');
  refLine.setAttribute('x1', pad); refLine.setAttribute('x2', W - pad);
  refLine.setAttribute('y1', pad + usableH / 2); refLine.setAttribute('y2', pad + usableH / 2);
  refLine.setAttribute('stroke', 'rgba(255,255,255,0.06)');
  refLine.setAttribute('stroke-width', '1');
  refLine.setAttribute('stroke-dasharray', '2 4');
  patternEditorEl.appendChild(refLine);
  if (seed.pattern.length > 1) {
    let d = '';
    seed.pattern.forEach((step, i) => {
      const x = pad + stepW * (i + 0.5);
      const y = offsetToY(step.offset);
      d += (i === 0 ? 'M' : 'L') + ` ${x.toFixed(1)} ${y.toFixed(1)} `;
    });
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', seed.color);
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('opacity', '0.4');
    patternEditorEl.appendChild(path);
  }
  seed.pattern.forEach((step, i) => {
    const x = pad + stepW * (i + 0.5);
    const isRest = step.velocity < 0.1;
    const hasChord = step.extras && step.extras.length > 0;
    if (hasChord && !isRest) {
      for (const ex of step.extras) {
        const exY = offsetToY(ex.offset);
        const exDot = document.createElementNS(SVGNS, 'circle');
        exDot.setAttribute('cx', x); exDot.setAttribute('cy', exY);
        exDot.setAttribute('r', 3.5);
        exDot.setAttribute('fill', seed.color);
        exDot.setAttribute('fill-opacity', 0.65);
        exDot.setAttribute('class', 'pattern-extra');
        patternEditorEl.appendChild(exDot);
      }
      const offsets = [step.offset, ...step.extras.map(e => e.offset)];
      const minO = Math.min(...offsets), maxO = Math.max(...offsets);
      const bar = document.createElementNS(SVGNS, 'line');
      bar.setAttribute('x1', x); bar.setAttribute('x2', x);
      bar.setAttribute('y1', offsetToY(minO));
      bar.setAttribute('y2', offsetToY(maxO));
      bar.setAttribute('stroke', seed.color);
      bar.setAttribute('stroke-width', '1');
      bar.setAttribute('stroke-opacity', 0.35);
      patternEditorEl.appendChild(bar);
    }
    const y = offsetToY(step.offset);
    const dot = document.createElementNS(SVGNS, 'circle');
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
    dot.setAttribute('r', hasChord ? 7 : 6);
    dot.setAttribute('fill', isRest ? 'rgba(80, 70, 100, 0.6)' : seed.color);
    dot.setAttribute('class', 'pattern-dot');
    dot.dataset.idx = i;
    dot.style.cursor = 'ns-resize';
    if (i === seed.currentStep) {
      dot.setAttribute('stroke', '#fff8c8');
      dot.setAttribute('stroke-width', '2');
    }
    patternEditorEl.appendChild(dot);
  });
}

function highlightCurrentStep(seed) {
  const dots = patternEditorEl.querySelectorAll('.pattern-dot');
  dots.forEach((d, i) => {
    if (i === seed.currentStep) {
      d.setAttribute('stroke', '#fff8c8'); d.setAttribute('stroke-width', '2');
    } else {
      d.setAttribute('stroke', 'none');
    }
  });
  // Mirror the highlight onto the velocity-curve bar so the user can
  // see which step's volume is currently firing.
  const bars = velocityEditorEl.querySelectorAll('.vel-bar');
  bars.forEach((b, i) => {
    if (i === seed.currentStep) {
      b.setAttribute('stroke', '#fff8c8'); b.setAttribute('stroke-width', '1.5');
    } else {
      b.setAttribute('stroke', 'none');
    }
  });
}
// Tell the scheduler to call our highlight function on each step.
setStepHighlightHandler(highlightCurrentStep);

// === Velocity / volume-curve editor ===
// A short lane drawn directly beneath the melody pattern. One bar per
// pattern step; bar height = step velocity (0..1). Empty/rest steps
// (velocity < 0.05) render as a dimmed full-height ghost so the user
// can grab them and turn them into hits. Drag a bar vertically to set
// that step's velocity.
function renderVelocityEditor(seed) {
  velocityEditorEl.innerHTML = '';
  const W = 276, H = 60, pad = 6;
  const usableH = H - pad * 2;
  const stepW = (W - pad * 2) / Math.max(1, seed.pattern.length);
  // Baseline so empty bars are still visible / grabbable.
  const baseline = document.createElementNS(SVGNS, 'line');
  baseline.setAttribute('x1', pad); baseline.setAttribute('x2', W - pad);
  baseline.setAttribute('y1', H - pad); baseline.setAttribute('y2', H - pad);
  baseline.setAttribute('stroke', 'rgba(255,255,255,0.10)');
  baseline.setAttribute('stroke-width', '1');
  velocityEditorEl.appendChild(baseline);
  seed.pattern.forEach((step, i) => {
    const x = pad + stepW * i;
    const w = Math.max(2, stepW - 2);
    const vel = Math.max(0, Math.min(1, step.velocity || 0));
    const barH = Math.max(2, vel * usableH);
    const isRest = vel < 0.05;
    // Ghost full-height bar so rests are still hit-targets.
    const ghost = document.createElementNS(SVGNS, 'rect');
    ghost.setAttribute('x', x); ghost.setAttribute('y', pad);
    ghost.setAttribute('width', w); ghost.setAttribute('height', usableH);
    ghost.setAttribute('fill', 'rgba(255,255,255,0.04)');
    ghost.setAttribute('class', 'vel-ghost');
    ghost.dataset.idx = i;
    ghost.style.cursor = 'ns-resize';
    velocityEditorEl.appendChild(ghost);
    if (!isRest) {
      const bar = document.createElementNS(SVGNS, 'rect');
      bar.setAttribute('x', x);
      bar.setAttribute('y', H - pad - barH);
      bar.setAttribute('width', w);
      bar.setAttribute('height', barH);
      bar.setAttribute('fill', seed.color);
      bar.setAttribute('fill-opacity', '0.75');
      bar.setAttribute('class', 'vel-bar');
      bar.dataset.idx = i;
      bar.style.cursor = 'ns-resize';
      velocityEditorEl.appendChild(bar);
    }
  });
}

let velDrag = null;
velocityEditorEl.addEventListener('pointerdown', (e) => {
  const target = e.target.closest('[data-idx]');
  if (!target) return;
  const seed = seedById(state.selectedSeedId);
  if (!seed) return;
  const idx = parseInt(target.dataset.idx);
  velDrag = { seed, idx, rect: velocityEditorEl.getBoundingClientRect() };
  velocityEditorEl.setPointerCapture(e.pointerId);
  updateVelocityFromMouse(e);
  e.preventDefault();
});
velocityEditorEl.addEventListener('pointermove', (e) => {
  if (velDrag) updateVelocityFromMouse(e);
});
velocityEditorEl.addEventListener('pointerup', (e) => {
  if (!velDrag) return;
  takeSnapshotFn('tweaked volume curve');
  velDrag = null;
  try { velocityEditorEl.releasePointerCapture(e.pointerId); } catch (err) {}
});
function updateVelocityFromMouse(e) {
  const rect = velDrag.rect;
  const pad = 6;
  const yInSvg = (e.clientY - rect.top) / rect.height * 60;
  const usableH = 60 - pad * 2;
  let vel = 1 - (yInSvg - pad) / usableH;
  vel = Math.max(0, Math.min(1, vel));
  // Snap to "off" near the bottom so the user can clearly turn a step
  // into a rest without having to land exactly on zero.
  if (vel < 0.05) vel = 0;
  velDrag.seed.pattern[velDrag.idx].velocity = vel;
  renderVelocityEditor(velDrag.seed);
  // Also refresh the melody dots — rests render with a dim colour and
  // become hits when velocity is brought up, so the visual feedback
  // should match.
  renderPatternEditor(velDrag.seed);
}

// Pattern editor gestures:
//   - Click (no drag): toggle hit / rest. Rest → hit at default
//     velocity, offset preserved. Hit → rest.
//   - Drag (> a few px): activate as hit (if rest) and set pitch
//     based on vertical drag position. Pitch tracks the pointer.
// Distinguishing click from drag: track pointer movement distance;
// commit on pointerup based on whether movement crossed a threshold.
const PATTERN_DRAG_THRESHOLD = 4;
let patternDrag = null;
patternEditorEl.addEventListener('pointerdown', (e) => {
  if (e.target.tagName !== 'circle') return;
  const seed = seedById(state.selectedSeedId);
  if (!seed) return;
  const idx = parseInt(e.target.dataset.idx);
  patternDrag = {
    seed, idx,
    rect: patternEditorEl.getBoundingClientRect(),
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
  };
  e.preventDefault();
});
window.addEventListener('pointermove', (e) => {
  if (!patternDrag) return;
  const dx = e.clientX - patternDrag.startX;
  const dy = e.clientY - patternDrag.startY;
  if (!patternDrag.moved && Math.hypot(dx, dy) > PATTERN_DRAG_THRESHOLD) {
    patternDrag.moved = true;
    // First crossing into "drag" → make sure this step is a hit so
    // dragging actually has a visible effect.
    const step = patternDrag.seed.pattern[patternDrag.idx];
    if (step.velocity < 0.05) step.velocity = 0.85;
  }
  if (patternDrag.moved) updatePatternFromMouse(e);
});
window.addEventListener('pointerup', () => {
  if (!patternDrag) return;
  if (!patternDrag.moved) {
    // Click without drag → toggle hit ↔ rest, keep pitch as it was.
    const step = patternDrag.seed.pattern[patternDrag.idx];
    if (step.velocity < 0.05) {
      step.velocity = 0.85;
    } else {
      step.velocity = 0;
    }
    renderPatternEditor(patternDrag.seed);
    renderVelocityEditor(patternDrag.seed);
    takeSnapshotFn(step.velocity > 0 ? 'activated step' : 'rested step');
  } else {
    takeSnapshotFn('tweaked melody');
  }
  patternDrag = null;
});
function updatePatternFromMouse(e) {
  const rect = patternDrag.rect;
  const pad = 14, usableH = 100 - pad * 2;
  const yInSvg = (e.clientY - rect.top) / rect.height * 100;
  const offsetRange = 14;
  let offset = (pad + usableH / 2 - yInSvg) * offsetRange / (usableH / 2 - 4);
  offset = Math.max(-14, Math.min(14, Math.round(offset)));
  const step = patternDrag.seed.pattern[patternDrag.idx];
  const delta = offset - step.offset;
  step.offset = offset;
  if (step.extras && step.extras.length > 0 && delta !== 0) {
    for (const ex of step.extras) {
      ex.offset = Math.max(-14, Math.min(14, ex.offset + delta));
    }
  }
  renderPatternEditor(patternDrag.seed);
  // Keep the velocity-curve view in sync — turning a rest into a hit
  // changes the bar height there too.
  renderVelocityEditor(patternDrag.seed);
}

document.getElementById('insp-close').addEventListener('click', () => {
  closeInspector();
});

// Close + fully reset the inspector. Used by the close button and
// by anything that needs the panel to start cold (e.g. selecting a
// different seed after closing). Clears the inner text so a stale
// label doesn't briefly flash before the new selection rebuilds.
export function closeInspector() {
  inspectorEl.classList.remove('open');
  state.selectedSeedId = null;
  document.getElementById('insp-title').textContent = '';
  document.getElementById('insp-sub').textContent = '';
  const capInfo = document.getElementById('captured-info');
  if (capInfo) capInfo.style.display = 'none';
  syncRenderedSeeds();
  refreshSelectionLights();
  paintScreen();
}

// Re-render the inspector for the currently-selected seed. Cheap to
// call (idempotent); used to reflect external parameter changes
// (encoder twists, pad-driven mode switches, etc.) in the on-screen
// pickers and toggles.
export function refreshInspector() {
  if (state.selectedSeedId) selectSeed(state.selectedSeedId);
}
document.getElementById('pitch-slider').addEventListener('input', (e) => {
  const s = seedById(state.selectedSeedId);
  if (!s) return;
  const midi = parseInt(e.target.value);
  s.fundamental = freqFromMidi(midi);
  s.r = radiusForFundamental(s.fundamental);
  document.getElementById('pitch-val').textContent = noteName(snapToScale(midi));
  renderSeed(s);
});
document.getElementById('pitch-slider').addEventListener('change', () => takeSnapshotFn('tweaked pitch'));

document.getElementById('seed-vol-slider').addEventListener('input', (e) => {
  const s = seedById(state.selectedSeedId);
  if (!s) return;
  const pct = parseInt(e.target.value);
  s.gain = pct / 100;
  document.getElementById('seed-vol-val').textContent = pct + '%';
});
document.getElementById('seed-vol-slider').addEventListener('change', () => takeSnapshotFn('tweaked volume'));
document.getElementById('quantize-toggle').addEventListener('click', () => {
  const s = seedById(state.selectedSeedId);
  if (!s) return;
  s.quantize = !s.quantize;
  document.getElementById('quantize-toggle').classList.toggle('on', s.quantize);
  s.nextTrigger = 0;
  takeSnapshotFn(s.quantize ? 'quantize on' : 'quantize off');
});

document.getElementById('mute-toggle').addEventListener('click', () => {
  const s = seedById(state.selectedSeedId);
  if (!s) return;
  s.muted = !s.muted;
  document.getElementById('mute-toggle').classList.toggle('on', !!s.muted);
  renderSeed(s);
  takeSnapshotFn(s.muted ? 'muted' : 'unmuted');
});

document.getElementById('loop-toggle').addEventListener('click', () => {
  const s = seedById(state.selectedSeedId);
  if (!s) return;
  s.loop = !(s.loop !== false);   // default true; toggle to false
  document.getElementById('loop-toggle').classList.toggle('on', s.loop !== false);
  // If we just turned looping back ON, reset patternIdx so the seed
  // re-engages from the start on the next scheduling pass. If we
  // turned it OFF, leave patternIdx alone — current loop completes.
  if (s.loop) s.patternIdx = 0;
  takeSnapshotFn(s.loop ? 'loop on' : 'loop off');
});

document.getElementById('regen-btn').addEventListener('click', async () => {
  const s = seedById(state.selectedSeedId);
  if (!s || s.kind !== 'voice') return;
  const roleKey = s.role || 'melody';
  const role = TIMBRE_ROLES[roleKey];
  if (!role) return;
  const gen = role.generate();
  s.harmonics = gen.harmonics;
  s.decay = gen.decay;
  s.decayFrac = gen.decay / BAR_MS;
  s.attackMs = gen.attackMs;
  s.attackFrac = gen.attackMs / BAR_MS;
  s.synthesisModel = gen.synthesisModel;
  s.patch = gen.patch;
  s._cachedPatch = null;
  syncRenderedSeeds();
  selectSeed(s.id);
  takeSnapshotFn('rerolled ' + s.label);
  // Audible + visual feedback that the sound actually changed.
  await ensureAudio();
  if (audioCtx) {
    playNoteAt(s, audioCtx.currentTime + 0.02, s.fundamental, s.gain || 0.35, s.decay);
  }
  const node = document.querySelector(`[data-seed-id="${s.id}"]`);
  if (node) {
    node.classList.add('regen-pulse');
    setTimeout(() => node.classList.remove('regen-pulse'), 600);
  }
});
document.getElementById('delete-btn').addEventListener('click', () => {
  if (!state.selectedSeedId) return;
  const s = seedById(state.selectedSeedId);
  if (!s) return;
  const label = s.label;
  removeSeed(state.selectedSeedId);
  syncRenderedSeeds();
  takeSnapshotFn('removed ' + label);
});

let barDrag = null;
harmonicEditorEl.addEventListener('pointerdown', (e) => {
  const bar = e.target.closest('.h-bar');
  if (!bar) return;
  const seed = seedById(state.selectedSeedId);
  if (!seed) return;
  const idx = parseInt(bar.dataset.idx);
  barDrag = { bar, idx, seed, rect: harmonicEditorEl.getBoundingClientRect() };
  updateBarFromMouse(e);
  e.preventDefault();
});
window.addEventListener('pointermove', (e) => { if (barDrag) updateBarFromMouse(e); });
window.addEventListener('pointerup', () => {
  if (barDrag) { takeSnapshotFn('tweaked harmonics'); barDrag = null; }
});
function updateBarFromMouse(e) {
  const rect = barDrag.rect;
  const relY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
  const amp = 1 - (relY / rect.height);
  barDrag.seed.harmonics[barDrag.idx] = Math.max(0, Math.min(1, amp));
  barDrag.bar.style.height = Math.max(2, amp * rect.height) + 'px';
  barDrag.bar.style.background = amp > 0.05 ? barDrag.seed.color : '';
  renderSeed(barDrag.seed);
}
