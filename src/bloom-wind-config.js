// Floating config panel for bloom (pulse) and wind (sweep) tools.
//
// Blooms and winds are ephemeral one-shots, not persistent seeds, so
// their tunables live as per-kind defaults on state.bloomSettings /
// state.windSettings (populated in state.js). spawnPulse / spawnSweep
// in audio/events.js read those overrides every firing, so live edits
// take effect on the next placement.
//
// The panel appears next to the tool palette whenever state.plantMode
// is a bloom (drop/muffle/thin) or wind (rise/fade) kind and hides
// otherwise. Listens for the `plant-mode-changed` event broadcast by
// pointer.js setPlantMode().

import { state } from './state.js';
import { PULSE_KINDS, SWEEP_KINDS } from './audio/events.js';
import { labelFor } from './labels.js';

const BLOOM_KINDS = Object.keys(PULSE_KINDS);   // drop / muffle / thin
const WIND_KINDS  = Object.keys(SWEEP_KINDS);   // rise / fade

// Build the panel and append it to the document. Position is `fixed`
// so it sits over the canvas next to the tool palette; CSS owns the
// exact placement.
const panel = document.createElement('div');
panel.className = 'bloom-wind-config';
panel.id = 'bloom-wind-config';
panel.style.display = 'none';
document.body.appendChild(panel);

function renderForKind(kind) {
  let html = '';
  if (BLOOM_KINDS.includes(kind)) {
    const s = state.bloomSettings[kind];
    html = `
      <div class="bw-title">${labelFor(kind)} <span class="bw-tag">bloom</span></div>
      <div class="bw-row">
        <label>radius</label>
        <input type="range" id="bw-radius" min="80" max="700" step="10" value="${s.maxRadius}">
        <span class="bw-val" id="bw-radius-val">${s.maxRadius}px</span>
      </div>
      <div class="bw-row">
        <label>expand</label>
        <input type="range" id="bw-expand" min="0.0625" max="2" step="0.0625" value="${s.expandBars}">
        <span class="bw-val" id="bw-expand-val">${formatBars(s.expandBars)}</span>
      </div>
      <div class="bw-row">
        <label>duration</label>
        <input type="range" id="bw-duration" min="0.25" max="8" step="0.25" value="${s.durationBars}">
        <span class="bw-val" id="bw-duration-val">${formatBars(s.durationBars)}</span>
      </div>
    `;
  } else if (WIND_KINDS.includes(kind)) {
    const s = state.windSettings[kind];
    html = `
      <div class="bw-title">${labelFor(kind)} <span class="bw-tag">wind</span></div>
      <div class="bw-row">
        <label>speed</label>
        <input type="range" id="bw-duration" min="1" max="8" step="0.5" value="${s.durationBars}">
        <span class="bw-val" id="bw-duration-val">${formatBars(s.durationBars)}</span>
      </div>
    `;
  } else {
    return;
  }
  panel.innerHTML = html;
  wireInputs(kind);
}

function formatBars(b) {
  if (b < 1) return `1/${Math.round(1 / b)} bar`;
  return b === 1 ? '1 bar' : `${b} bars`;
}

function wireInputs(kind) {
  const radius = panel.querySelector('#bw-radius');
  const expand = panel.querySelector('#bw-expand');
  const dur = panel.querySelector('#bw-duration');
  if (radius) {
    radius.addEventListener('input', (e) => {
      const v = parseInt(e.target.value);
      state.bloomSettings[kind].maxRadius = v;
      panel.querySelector('#bw-radius-val').textContent = v + 'px';
    });
  }
  if (expand) {
    expand.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      state.bloomSettings[kind].expandBars = v;
      panel.querySelector('#bw-expand-val').textContent = formatBars(v);
      // Duration can't be shorter than expansion — bump it up if the
      // user dragged expand past current duration.
      if (state.bloomSettings[kind].durationBars < v) {
        state.bloomSettings[kind].durationBars = v;
        const durInput = panel.querySelector('#bw-duration');
        const durVal = panel.querySelector('#bw-duration-val');
        if (durInput) durInput.value = v;
        if (durVal) durVal.textContent = formatBars(v);
      }
    });
  }
  if (dur) {
    dur.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const bag = BLOOM_KINDS.includes(kind) ? state.bloomSettings : state.windSettings;
      bag[kind].durationBars = v;
      panel.querySelector('#bw-duration-val').textContent = formatBars(v);
    });
  }
}

function refreshVisibility() {
  const kind = state.plantMode;
  if (BLOOM_KINDS.includes(kind) || WIND_KINDS.includes(kind)) {
    renderForKind(kind);
    panel.style.display = '';
  } else {
    panel.style.display = 'none';
  }
}

window.addEventListener('plant-mode-changed', refreshVisibility);
// Reflect the initial state once on boot (in case the default plant
// mode is ever changed from 'voice' to a bloom/wind).
refreshVisibility();
