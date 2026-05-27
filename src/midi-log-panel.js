// Real-time MIDI traffic log panel.
//
// Bottom-left floating panel that shows every byte going to or from
// connected MIDI devices as it happens. Two ring buffers — one for
// outbound (LED writes, clock ticks, OLED updates), one for inbound
// (notes, CCs, sysex replies) — are unified into a single time-sorted
// stream. Updates render at 30Hz max via requestAnimationFrame so
// even a flood of clock ticks doesn't lock up the UI.
//
// Entries are classified by MIDI status byte (clock / active-sense /
// sysex / note / cc / etc.) so the user can filter noisy categories
// out via the chip strip at the top of the panel. Clock and active-
// sense are hidden by default; toggle them on via the chips.
//
// API exported for upstream hooks:
//   logOut(bytes, portName)  — call from every outbound MIDI send
//   logIn(bytes, portName)   — call from incoming message handler
//   togglePanel(visible)     — open / close the UI

const RING_CAPACITY = 400;
const entries = [];           // unified ring buffer (oldest first)
let nextId = 1;

const sessionStart = performance.now();
let dirty = false;
let rafScheduled = false;

// Default filter state — clock + active sense hidden because they
// fire 30-50× / sec and bury the rest of the traffic.
const filters = {
  clock: false,
  activeSense: false,
  sysex: true,
  note: true,
  cc: true,
  other: true,
};

let panelEl = null;
let listEl = null;
let visible = true;

// Classify a status byte into one of the filter categories. Drives
// the colour pill on each row + the filter chip visibility.
function classify(bytes) {
  const s = bytes[0] || 0;
  if (s === 0xF8) return 'clock';
  if (s === 0xFE) return 'activeSense';
  if (s === 0xF0) return 'sysex';
  if (s >= 0xF0) return 'other';        // start/stop/continue/UDI replies
  const cmd = s & 0xF0;
  if (cmd === 0x80 || cmd === 0x90) return 'note';
  if (cmd === 0xB0) return 'cc';
  return 'other';
}

// One-line decode so the user doesn't have to parse hex bytes in
// their head. Returns a short string or '' if no useful decode.
function decode(bytes) {
  const s = bytes[0] || 0;
  if (s === 0xF8) return 'clock tick';
  if (s === 0xFA) return 'start';
  if (s === 0xFB) return 'continue';
  if (s === 0xFC) return 'stop';
  if (s === 0xFE) return 'active sense';
  if (s === 0xF0) {
    // SysEx — try to identify Arturia commands.
    if (bytes[1] === 0x00 && bytes[2] === 0x20 && bytes[3] === 0x6B) {
      const verb = bytes.slice(6, 9).map(b => b.toString(16).padStart(2, '0')).join(' ');
      if (verb === '02 02 16') return `LED paint pad 0x${(bytes[9]||0).toString(16)}`;
      if (verb === '04 02 60') return 'OLED write';
      if (verb.startsWith('02 00 40')) return 'mode/connect';
      if (verb.startsWith('01 00 40')) return 'program request';
      return `Arturia sysex ${verb}`;
    }
    if (bytes[1] === 0x7E) return 'universal device inquiry';
    return 'sysex (other)';
  }
  const cmd = s & 0xF0;
  const ch = (s & 0x0F) + 1;
  if (cmd === 0x90 && bytes[2] > 0) return `noteOn ch${ch} n${bytes[1]} v${bytes[2]}`;
  if (cmd === 0x80 || (cmd === 0x90 && bytes[2] === 0)) return `noteOff ch${ch} n${bytes[1]}`;
  if (cmd === 0xB0) return `cc${bytes[1]}=${bytes[2]} ch${ch}`;
  if (cmd === 0xE0) {
    const v = ((bytes[2] << 7) | bytes[1]) - 8192;
    return `pitchBend ch${ch} ${v}`;
  }
  return '';
}

function push(direction, bytes, portName) {
  const t = +(performance.now() - sessionStart).toFixed(2);
  const cat = classify(bytes);
  entries.push({
    id: nextId++,
    t, direction, port: portName || '',
    bytes, cat,
    hex: bytes.map(b => b.toString(16).padStart(2, '0')).join(' '),
    decoded: decode(bytes),
  });
  if (entries.length > RING_CAPACITY) entries.shift();
  scheduleRender();
}

export function logOut(bytes, portName) { push('OUT', Array.from(bytes), portName); }
export function logIn(bytes, portName)  { push('IN',  Array.from(bytes), portName); }

// Render throttling — coalesce many pushes per frame into a single
// DOM update. With ~50 clock ticks/sec we'd otherwise force-layout
// the panel constantly.
function scheduleRender() {
  if (!visible || !listEl) return;
  dirty = true;
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    if (!dirty) return;
    dirty = false;
    render();
  });
}

function shouldShow(entry) {
  switch (entry.cat) {
    case 'clock':       return filters.clock;
    case 'activeSense': return filters.activeSense;
    case 'sysex':       return filters.sysex;
    case 'note':        return filters.note;
    case 'cc':          return filters.cc;
    default:            return filters.other;
  }
}

function abbreviatePort(name) {
  if (!name) return '';
  const colon = name.lastIndexOf(':');
  let s = colon >= 0 ? name.slice(colon - 16, colon) : name;
  // Strip trailing alsa client:port numbers like " 20:0"
  s = s.replace(/\s+\d+:\d+$/, '');
  return s.replace(/^.*minilab[\d ]*/i, '').trim() || 'minilab';
}

function render() {
  if (!listEl) return;
  // Preserve scroll state across the diff-render. Only auto-scroll to
  // the newest entry if the user was already pinned to the bottom — if
  // they've scrolled up to read history, leave their position alone.
  const wasPinned = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 30;
  // Find the slice of entries that pass the current filters. We trim
  // to last 200 visible.
  const visibleEntries = [];
  for (let i = entries.length - 1; i >= 0 && visibleEntries.length < 200; i--) {
    if (shouldShow(entries[i])) visibleEntries.unshift(entries[i]);
  }
  // Diff-render by clearing + rebuilding.
  const frag = document.createDocumentFragment();
  visibleEntries.forEach((e, idx) => {
    const row = document.createElement('div');
    row.className = `mlog-row mlog-${e.direction.toLowerCase()} mlog-cat-${e.cat}`;
    // Mark the very last (most recent) row so the user can see at a
    // glance which row appeared most recently — easier to diagnose
    // order-of-events questions.
    if (idx === visibleEntries.length - 1) row.classList.add('mlog-latest');
    const tEl = document.createElement('span');
    tEl.className = 'mlog-t';
    tEl.textContent = `+${(e.t / 1000).toFixed(2)}`;
    row.appendChild(tEl);
    const dirEl = document.createElement('span');
    dirEl.className = 'mlog-dir';
    dirEl.textContent = e.direction;
    row.appendChild(dirEl);
    const portEl = document.createElement('span');
    portEl.className = 'mlog-port';
    portEl.textContent = abbreviatePort(e.port);
    row.appendChild(portEl);
    const decodedEl = document.createElement('span');
    decodedEl.className = 'mlog-decoded';
    decodedEl.textContent = e.decoded;
    row.appendChild(decodedEl);
    const hexEl = document.createElement('span');
    hexEl.className = 'mlog-hex';
    // Truncate very long sysex hex to first 8 + ... + last 1 bytes
    if (e.bytes.length > 14) {
      const head = e.bytes.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join(' ');
      const tail = e.bytes[e.bytes.length - 1].toString(16).padStart(2, '0');
      hexEl.textContent = `${head} … ${tail}`;
    } else {
      hexEl.textContent = e.hex;
    }
    row.appendChild(hexEl);
    frag.appendChild(row);
  });
  listEl.innerHTML = '';
  listEl.appendChild(frag);
  if (wasPinned) listEl.scrollTop = listEl.scrollHeight;
}

// === DOM scaffolding ===

function buildPanel() {
  const root = document.createElement('div');
  root.className = 'mlog-panel';
  root.id = 'mlog-panel';
  const header = document.createElement('div');
  header.className = 'mlog-header';
  header.innerHTML = `
    <span class="mlog-title">midi log</span>
    <span class="mlog-chips">
      <button class="mlog-chip" data-cat="clock" title="MIDI Clock (0xF8) — 24× / beat">clock</button>
      <button class="mlog-chip on" data-cat="note" title="noteOn / noteOff">notes</button>
      <button class="mlog-chip on" data-cat="cc" title="continuous controllers">cc</button>
      <button class="mlog-chip on" data-cat="sysex" title="System Exclusive (LED + OLED + handshake)">sysex</button>
      <button class="mlog-chip" data-cat="activeSense" title="Active Sense (0xFE)">sense</button>
      <button class="mlog-chip on" data-cat="other" title="Start/Stop/Continue/UDI replies">other</button>
    </span>
    <button class="mlog-btn" id="mlog-clear" title="Clear the log">clear</button>
    <button class="mlog-btn" id="mlog-close" title="Hide (toggle from top bar)">×</button>
  `;
  root.appendChild(header);
  const list = document.createElement('div');
  list.className = 'mlog-list';
  root.appendChild(list);
  document.body.appendChild(root);
  // Wire chips
  header.querySelectorAll('.mlog-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const cat = chip.dataset.cat;
      filters[cat] = !filters[cat];
      chip.classList.toggle('on', filters[cat]);
      scheduleRender();
    });
  });
  header.querySelector('#mlog-clear').addEventListener('click', () => {
    entries.length = 0;
    render();
  });
  header.querySelector('#mlog-close').addEventListener('click', () => {
    togglePanel(false);
  });
  return { root, list };
}

export function togglePanel(want) {
  if (!panelEl) {
    const built = buildPanel();
    panelEl = built.root;
    listEl = built.list;
  }
  visible = want != null ? !!want : !visible;
  panelEl.classList.toggle('open', visible);
  if (visible) scheduleRender();
}

// Auto-build the panel on first import so logOut/logIn can render
// immediately. Default visible — the user explicitly asked for an
// always-visible diagnostic.
togglePanel(true);

// Top-bar "midi log" button repurpose: short click toggles panel,
// shift+click runs the existing download. Keeps the top bar tidy.
const btn = document.getElementById('midi-log-btn');
if (btn) {
  btn.addEventListener('click', (e) => {
    if (e.shiftKey) return;   // let the existing JSON-download handler run
    e.stopImmediatePropagation();
    togglePanel();
  }, true);   // capture phase so we intercept before the JSON handler
  btn.title = 'Toggle MIDI log panel (shift+click: download JSON)';
}

if (typeof window !== 'undefined') {
  window.murmurToggleMidiLog = togglePanel;
}
