// Snapshot history + revert.
//
// Auto-snapshots take a serialisable copy of every seed (and the next-
// seed-id counter) and store it in a 16-entry ring buffer. Reverting
// rehydrates seeds from that copy, restoring modifier audio chains
// and reselecting the previously-selected seed via inspector.
//
// clearCanvas lives here too: it's basically "snapshot first, then
// wipe" — the clear is recoverable via the timeline.

import { seeds, activeEvents, snapshots, activeLiveNotes, state, seedById } from './state.js';
import { SVGNS, syncRenderedSeeds } from './seeds.js';
import { setupAuraChain } from './auras/registry.js';
import { inspectorEl, selectSeed } from './inspector.js';

const MAX_SNAPSHOTS = 16;
let snapAutoTimer = null;

let liveNoteOffFn = () => {};
export function setLiveNoteOffFn(fn) { liveNoteOffFn = fn; }

// === Seed serialisation manifest ===
//
// Every persistent seed property is declared ONCE here. serializeSeed
// and deserializeSeed both iterate these lists, so adding a new seed
// field can't silently vanish on undo — the old code enumerated every
// field by hand in two places and they had already drifted (top-level
// pattern lost tOffset/drumSlot on restore; `muted` was never saved).
//
// SCALAR_FIELDS round-trip verbatim. Structured fields (arrays, Sets,
// patterns, the patch graph) get their own clone helpers below.
// RUNTIME_RESET fields are never serialised — they're rebuilt fresh on
// restore (scheduler cursors, physics velocity, audio node handles).
const SCALAR_FIELDS = [
  'id', 'kind', 'modifierKind', 'cx', 'cy', 'r', 'color', 'fundamental',
  'decay', 'decayFrac', 'intervalMs', 'intervalFrac', 'attackMs', 'attackFrac',
  'delayMs', 'delayFrac', 'gain', 'label', 'quantize', 'loop', 'wanderlust',
  'muted', 'sphereR', 'edgeIntensity', 'centerIntensity', 'falloffCurve',
  'driveAmount', 'gainAmount', 'squashAmount', 'wobbleRate', 'wobbleDepth',
  'crushBits', 'crushRate', 'reverbSec', 'role', 'swing', 'synthesisModel',
  'polyFactor', 'patternBankIdx',
];
const RUNTIME_RESET = {
  patternIdx: 0, currentStep: -1, nextTrigger: 0, lastPulseAt: 0,
  vx: 0, vy: 0, delayInput: null, delayNode: null,
};

function clonePattern(steps) {
  return steps.map(p => {
    const c = { offset: p.offset, velocity: p.velocity, duration: p.duration, tOffset: p.tOffset };
    if (p.drumSlot !== undefined) c.drumSlot = p.drumSlot;
    if (p.extras && p.extras.length) {
      c.extras = p.extras.map(e => {
        const ec = { offset: e.offset, velocity: e.velocity, duration: e.duration };
        if (e.drumSlot !== undefined) ec.drumSlot = e.drumSlot;
        return ec;
      });
    }
    return c;
  });
}
function cloneBank(bank) {
  return bank.map(b => ({ id: b.id, weight: b.weight, steps: clonePattern(b.steps) }));
}

function serializeSeed(s) {
  const out = {};
  for (const f of SCALAR_FIELDS) out[f] = s[f];
  out.harmonics = s.harmonics ? s.harmonics.slice() : undefined;
  out.blobPhases = s.blobPhases ? s.blobPhases.slice() : undefined;
  out.pattern = s.pattern ? clonePattern(s.pattern) : undefined;
  out.patternBank = s.patternBank ? cloneBank(s.patternBank) : undefined;
  out.capturedByIds = [...(s.capturedByIds || [])];
  out.capturedSeedIds = [...(s.capturedSeedIds || [])];
  out.patch = s.patch ? JSON.parse(JSON.stringify(s.patch)) : null;
  return out;
}

function deserializeSeed(snap) {
  const seed = { ...RUNTIME_RESET };
  for (const f of SCALAR_FIELDS) seed[f] = snap[f];
  seed.harmonics = snap.harmonics ? snap.harmonics.slice() : [];
  seed.blobPhases = snap.blobPhases ? snap.blobPhases.slice() : undefined;
  seed.pattern = snap.pattern ? clonePattern(snap.pattern) : [];
  seed.capturedByIds = new Set(snap.capturedByIds || []);
  seed.capturedSeedIds = new Set(snap.capturedSeedIds || []);
  seed.patch = snap.patch ? JSON.parse(JSON.stringify(snap.patch)) : null;
  // Pattern bank: rebuild from the snapshot, or (pre-bank snapshots /
  // voices without one) wrap the pattern as a single-entry bank so the
  // variation features have something to operate on.
  if (snap.patternBank && snap.patternBank.length > 0) {
    seed.patternBank = cloneBank(snap.patternBank);
    seed.patternBankIdx = Math.min(snap.patternBankIdx || 0, seed.patternBank.length - 1);
    seed.pattern = seed.patternBank[seed.patternBankIdx].steps;
  } else if (seed.kind === 'voice') {
    seed.patternBank = [{ id: 'orig', weight: 1, steps: seed.pattern }];
    seed.patternBankIdx = 0;
  }
  return seed;
}

export function takeSnapshot(label, immediate = false) {
  clearTimeout(snapAutoTimer);
  const capture = () => {
    const snap = {
      label, ts: new Date(),
      seeds: seeds.map(serializeSeed),
      nextSeedId: state.nextSeedId,
    };
    snapshots.push(snap);
    if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
    renderTimeline();
  };
  if (immediate) capture();
  else snapAutoTimer = setTimeout(capture, 200);
}

export function clearCanvas() {
  takeSnapshot('before clear', true);
  // Release any held live notes so their oscillators don't sustain forever.
  for (const m of [...activeLiveNotes.keys()]) liveNoteOffFn(m);
  // Disconnect modifier-chain inputs so dangling delay/reverb graphs go
  // quiet (the rest of each chain has no input source and will be GC'd).
  for (const s of seeds) {
    if (s.delayInput)  { try { s.delayInput.disconnect();  } catch (e) {} }
    if (s.reverbInput) { try { s.reverbInput.disconnect(); } catch (e) {} }
  }
  seeds.length = 0;
  activeEvents.length = 0;
  state.selectedSeedId = null;
  inspectorEl.classList.remove('open');
  syncRenderedSeeds();
  takeSnapshot('cleared');
}

export function revertToSnapshot(i) {
  const snap = snapshots[i];
  if (!snap) return;
  seeds.length = 0;
  for (const s of snap.seeds) {
    const newSeed = deserializeSeed(s);
    seeds.push(newSeed);
    setupAuraChain(newSeed);
  }
  state.nextSeedId = snap.nextSeedId;
  if (!seedById(state.selectedSeedId)) {
    state.selectedSeedId = null;
    inspectorEl.classList.remove('open');
  }
  syncRenderedSeeds();
  if (state.selectedSeedId) selectSeed(state.selectedSeedId);
  renderTimeline(i);
}

function renderTimeline(currentIdx = -1) {
  const strip = document.getElementById('tl-strip');
  strip.innerHTML = '';
  snapshots.forEach((snap, i) => {
    const el = document.createElement('div');
    el.className = 'snap';
    if (i === currentIdx) el.classList.add('current');
    el.title = snap.label + ' · ' + snap.ts.toLocaleTimeString();
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 1400 800');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    for (const s of snap.seeds) {
      if (s.kind === 'modifier' && s.sphereR) {
        const c = document.createElementNS(SVGNS, 'circle');
        c.setAttribute('cx', s.cx); c.setAttribute('cy', s.cy);
        c.setAttribute('r', s.sphereR); c.setAttribute('fill', s.color);
        c.setAttribute('opacity', '0.06');
        svg.appendChild(c);
      }
    }
    for (const s of snap.seeds) {
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('cx', s.cx); c.setAttribute('cy', s.cy);
      c.setAttribute('r', s.r); c.setAttribute('fill', s.color);
      c.setAttribute('opacity', '0.7');
      svg.appendChild(c);
    }
    el.appendChild(svg);
    const lbl = document.createElement('div');
    lbl.className = 'snap-label';
    lbl.textContent = snap.label;
    el.appendChild(lbl);
    el.addEventListener('click', () => revertToSnapshot(i));
    strip.appendChild(el);
  });
  strip.scrollLeft = strip.scrollWidth;
}

// Top-bar buttons
document.getElementById('snap-btn').addEventListener('click', () => takeSnapshot('manual'));

const clearBtn = document.getElementById('clear-btn');
let clearConfirmTimer = null;
clearBtn.addEventListener('click', () => {
  if (clearBtn.dataset.armed === '1') {
    clearTimeout(clearConfirmTimer);
    clearBtn.dataset.armed = '0';
    clearBtn.textContent = 'clear';
    clearBtn.classList.remove('danger');
    clearCanvas();
    return;
  }
  clearBtn.dataset.armed = '1';
  clearBtn.textContent = 'confirm?';
  clearBtn.classList.add('danger');
  clearConfirmTimer = setTimeout(() => {
    clearBtn.dataset.armed = '0';
    clearBtn.textContent = 'clear';
    clearBtn.classList.remove('danger');
  }, 2000);
});
