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
import { setupModifierChain } from './audio/chains.js';
import { inspectorEl, selectSeed } from './inspector.js';

const MAX_SNAPSHOTS = 16;
let snapAutoTimer = null;

let liveNoteOffFn = () => {};
export function setLiveNoteOffFn(fn) { liveNoteOffFn = fn; }

export function takeSnapshot(label, immediate = false) {
  clearTimeout(snapAutoTimer);
  const capture = () => {
    const snap = {
      label, ts: new Date(),
      seeds: seeds.map(s => ({
        id: s.id, kind: s.kind, modifierKind: s.modifierKind,
        cx: s.cx, cy: s.cy, r: s.r, color: s.color,
        fundamental: s.fundamental,
        decay: s.decay, decayFrac: s.decayFrac,
        intervalMs: s.intervalMs, intervalFrac: s.intervalFrac,
        attackMs: s.attackMs, attackFrac: s.attackFrac,
        delayMs: s.delayMs, delayFrac: s.delayFrac,
        harmonics: s.harmonics.slice(), gain: s.gain, label: s.label,
        pattern: s.pattern.map(p => ({
          offset: p.offset, velocity: p.velocity,
          duration: p.duration,
          tOffset: p.tOffset,
          extras: p.extras ? p.extras.map(e => ({ offset: e.offset, velocity: e.velocity, duration: e.duration })) : undefined,
        })),
        quantize: s.quantize,
        loop: s.loop,
        blobPhases: s.blobPhases ? s.blobPhases.slice() : undefined,
        capturedByIds: [...(s.capturedByIds || [])],
        capturedSeedIds: [...s.capturedSeedIds],
        sphereR: s.sphereR,
        edgeIntensity:   s.edgeIntensity,
        centerIntensity: s.centerIntensity,
        falloffCurve:    s.falloffCurve,
        reverbSec: s.reverbSec,
        role: s.role,
        swing: s.swing,
        synthesisModel: s.synthesisModel,
        polyFactor: s.polyFactor,
        patch: s.patch ? JSON.parse(JSON.stringify(s.patch)) : null,
      })),
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
    const newSeed = {
      ...s,
      harmonics: s.harmonics.slice(),
      pattern: s.pattern.map(p => ({
          offset: p.offset, velocity: p.velocity,
          duration: p.duration,
          extras: p.extras ? p.extras.map(e => ({ offset: e.offset, velocity: e.velocity, duration: e.duration })) : undefined,
        })),
      capturedByIds: new Set(s.capturedByIds || []),
      capturedSeedIds: new Set(s.capturedSeedIds || []),
      patternIdx: 0, currentStep: -1, nextTrigger: 0, lastPulseAt: 0,
      delayInput: null, delayNode: null,
    };
    seeds.push(newSeed);
    setupModifierChain(newSeed);
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
