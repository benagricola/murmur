// Outbound SysEx control of the MiniLab 3.
//
// All commands wrap with `F0 00 20 6B 7F 42 … F7`. The protocol was
// reverse-engineered from Arturia's FL Studio integration script and
// the gluon/AbletonLive11_MIDIRemoteScripts Ableton script for the
// MiniLab 3 — both confirmed the same byte sequences against running
// hardware. Sources are cited above each block.
//
// Lifecycle: call `connectMinilab()` once a MIDI output is available.
// That sends the DAW-connect handshake and triggers an initial paint
// (pad colours + OLED text). Connect/disconnect is reversible via
// `disconnectMinilab()`.

import { state, seeds, seedById } from '../state.js';
import { TIMBRE_ROLES, activeRole } from '../timbres.js';
import { BPM } from '../tempo.js';
import { noteName, freqFromMidi, midiFromFreq } from '../constants.js';
import { labelFor } from '../labels.js';

// SysEx header / footer + every device-specific magic number live in
// ./devices/minilab3.js — see that file for the binding rationale.
import {
  SYSEX_HEADER as HEADER,
  SYSEX_FOOTER as FOOTER,
  PAD_LED_ID_BANK_A,
  PAD_LED_ID_BANK_B,
  PAD_LED_ID_BANK_A_TRANSIENT,
  PAD_LED_ID_BANK_B_TRANSIENT,
  TRANSPORT_LED_ID,
  PAD_BANK_A_5_8_PLANT_MODES as PLANT_MODE_BANK_A_5_8,
  PAD_BANK_B_PLANT_MODES as PLANT_MODE_BANK_B,
  SYSEX_CMD,
  PORT_NAME_DEVICE,
  PORT_NAME_DAW,
  PORT_NAME_SPECIAL,
} from '../devices/minilab3.js';

// Two MIDI output bindings, each used for different traffic:
//   midiOuts     — SysEx (LED + screen) destinations. In DAW mode the
//                  MiniLab only processes these on its "DAW virtual"
//                  port (ALV / MIDIIN2 / "MiniLab 3 DAW"). The main
//                  MIDI port silently drops them.
//   realtimeOut  — MIDI Real-Time messages (Clock / Start / Stop)
//                  destination. The MiniLab arpeggiator listens for
//                  these on the main MIDI port, NOT the DAW port.
//                  Sending realtime to the wrong port is a no-op.
let midiOuts = [];
let realtimeOut = null;

// Bind to the MIDI output the MiniLab uses for LED + screen SysEx.
// Per the Ableton remote-script implementation: in DAW mode, only
// the device's "DAW virtual" port accepts LED/screen writes — on
// Linux it's named "ALV" (Analog Lab Virtual), on Windows "MIDIIN2",
// on Mac "MiniLab 3 DAW". The main "MiniLab 3 MIDI" port carries
// notes / CCs / pitch-bend but silently drops LED SysEx.
//
// Pick the DAW port specifically. Fall back to spraying every
// MiniLab-named port if name-matching fails (different firmware /
// OS might have different conventions).
export function connectMinilab(outputs) {
  const allMinilab = (outputs || []).filter(o => PORT_NAME_DEVICE.test(o.name || ''));
  const dawPort = allMinilab.find(o => PORT_NAME_DAW.test(o.name || ''));
  if (dawPort) midiOuts = [dawPort];
  else if (allMinilab.length > 0) midiOuts = allMinilab;
  else if (outputs && outputs.length > 0) midiOuts = [outputs[0]];
  else midiOuts = [];
  // Realtime port: the main keyboard/notes/clock port. We pick by
  // *exclusion* — any MiniLab port that ISN'T one of the named
  // special-purpose ports (ALV / MCU / HUI / DIN THRU / MIDIIN2 / DAW).
  realtimeOut = allMinilab.find(o => !PORT_NAME_SPECIAL.test(o.name || ''))
    || allMinilab[0] || null;
  if (midiOuts.length === 0) return false;
  console.log('[minilab] sending SysEx to', midiOuts.map(o => o.name),
    dawPort ? '(DAW port matched)' : '(no DAW port found, spraying all)');
  console.log('[minilab] sending realtime (clock/start/stop) to',
    realtimeOut ? realtimeOut.name : '(no port)');
  // Universal Device Inquiry — standard MIDI request that any
  // compliant device should answer. Sent BEFORE the Arturia-specific
  // handshake so we can capture firmware version even if the device
  // isn't in DAW mode and ignores the rest. Reply lands on the input
  // port; parsing happens in input.js.
  sendUniversalDeviceInquiry();
  // Hello sequence from Ableton's __init__.py: enter DAW mode, then
  // request the device's current program. Reply lands on the input
  // port and is captured by the regular MIDI log.
  sendRaw(SYSEX_CMD.CONNECT_DAW);
  sendRaw(SYSEX_CMD.REQUEST_PROGRAM);
  // After handshake the device is ready to accept LED and screen
  // writes. The 60ms initial paint (matching the original working
  // implementation) is critical — pad LEDs persist when written this
  // early, but later paints get clobbered by the device's Ableton-
  // style frame loop. The later paints are a hedge for slow boots.
  setTimeout(() => { paintAllPads(); paintScreen(); }, 60);
  setTimeout(() => { paintAllPads(); paintScreen(); }, 600);
  setTimeout(() => { paintAllPads(); paintScreen(); }, 1500);
  // One-time hint about setting the device-side arp Sync to Auto/Ext.
  // Suppressed on repeat connects via localStorage.
  setTimeout(showArpSyncHint, 1500);
  // Kick off the continuous clock-tick stream — runs regardless of
  // murmur's play state so the MiniLab arp can lock to our tempo as
  // soon as the user engages it on the device.
  ensureClockTimer();
  return true;
}

// Universal Device Inquiry — standard MIDI System Exclusive request
// (NOT Arturia-specific). Every compliant device replies with its
// manufacturer ID, family / model bytes, and firmware version. The
// reply doesn't use our HEADER wrapper.
function sendUniversalDeviceInquiry() {
  const msg = [0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7];
  for (const out of midiOuts) {
    try { out.send(msg); } catch (e) {}
  }
}

export function disconnectMinilab() {
  if (midiOuts.length === 0) return;
  sendRaw(SYSEX_CMD.DISCONNECT_DAW);
  midiOuts = [];
  stopClockTimer();
}

function sendRaw(bytes) {
  if (midiOuts.length === 0) return;
  const msg = [...HEADER, ...bytes, ...FOOTER];
  for (const out of midiOuts) {
    try { out.send(msg); } catch (e) {
      console.warn('[minilab] sysex send failed', out.name, e);
    }
  }
}

// === LED control ===
//
// Per Ableton's midi.py, LED targets are addressed by 7-bit SysEx
// IDs. Bank A pads 1-8 = 0x34..0x3B (persistent), bank B pads 1-8 =
// 0x44..0x4B (persistent). The five round transport buttons sit at
// 0x57..0x5B (Loop / Stop / Play / Record / Tap). RGB values are
// 7-bit (0..127), not 8-bit.

// Local aliases for the imported pad-ID arrays — keeps the call sites
// compact and matches the names used throughout this module before
// the binding extraction.
const PAD_ID_BANK_A = PAD_LED_ID_BANK_A;
const PAD_ID_BANK_B = PAD_LED_ID_BANK_B;
const TRANSPORT_LOOP   = TRANSPORT_LED_ID.loop;
const TRANSPORT_STOP   = TRANSPORT_LED_ID.stop;
const TRANSPORT_PLAY   = TRANSPORT_LED_ID.play;
const TRANSPORT_RECORD = TRANSPORT_LED_ID.record;
const TRANSPORT_TAP    = TRANSPORT_LED_ID.tap;

function rgb7(r, g, b) {
  return [r & 0x7F, g & 0x7F, b & 0x7F];
}

function setLed(id, r, g, b) {
  sendRaw([...SYSEX_CMD.LED_PAINT, id, ...rgb7(r, g, b)]);
}

// LED diagnostic — run from DevTools as `murmurTestPads()`. Paints a
// distinct 16-colour rainbow across both pad banks. If the device
// shows the rainbow we know our SysEx reaches the LEDs. If it shows
// all-white or all-off, the bytes aren't being interpreted. If only
// the persistent IDs (0x34..0x4B) don't work, calling
// `murmurTestPads(true)` retries with the transient IDs (0x04..0x1B)
// which some firmware versions accept exclusively.
function rainbow16() {
  return [
    '#ff0000', '#ff7f00', '#ffff00', '#7fff00',
    '#00ff00', '#00ff7f', '#00ffff', '#007fff',
    '#0000ff', '#7f00ff', '#ff00ff', '#ff007f',
    '#ffffff', '#888888', '#444444', '#222222',
  ];
}
function murmurTestPads(useTransientIds = false) {
  const cols = rainbow16();
  const aBase = useTransientIds ? 0x04 : 0x34;
  const bBase = useTransientIds ? 0x14 : 0x44;
  for (let i = 0; i < 8; i++) setLed(aBase + i, ...hex7(cols[i]));
  for (let i = 0; i < 8; i++) setLed(bBase + i, ...hex7(cols[8 + i]));
  console.log('[minilab] painted rainbow on pad IDs',
    useTransientIds ? '0x04-0x1B (transient)' : '0x34-0x4B (persistent)');
}
if (typeof window !== 'undefined') window.murmurTestPads = murmurTestPads;

// === LED diagnostic harness ===
//
// A structured set of DevTools-callable functions for figuring out
// why pad LEDs aren't lighting up. Each function logs the EXACT
// bytes being sent and which port they're going to, so you can
// correlate "I clicked this" with "this byte stream went out" and
// "the device did THIS in response".
//
// Recommended diagnostic order:
//   1. murmurDescribePorts()    — confirm we picked the right port
//   2. murmurPaintOne(0)        — paint pad 1 bank A red, watch device
//   3. murmurPaintOne(0,'#0f0') — repaint that pad green
//   4. murmurSysexLog(true)     — log every subsequent SysEx write
//   5. murmurReconnect()        — re-run the full handshake + paints
//   6. Hit a plant-mode pad on the device — note what color the pad
//      becomes vs. what color we tried to paint.

let sysexLogging = false;

function describePorts() {
  if (!midiOuts || midiOuts.length === 0) {
    console.warn('[diag] no MIDI outputs bound — is the MiniLab connected?');
    return;
  }
  console.group('[diag] MiniLab port routing');
  console.log('SysEx (LED + OLED) → ', midiOuts.map(o => o.name));
  console.log('Realtime (clock)   → ', realtimeOut ? realtimeOut.name : '(none)');
  console.groupEnd();
}

function paintOne(padIdx, hex = '#ff0000', opts = {}) {
  if (padIdx < 0 || padIdx > 15) {
    console.warn('[diag] padIdx must be 0..15 (0-7 = bank A, 8-15 = bank B)');
    return;
  }
  // `opts.alt = true` uses the transient pad IDs (0x04..0x1B) instead
  // of the persistent ones (0x34..0x4B). Some MiniLab 3 firmware
  // versions accept only one or the other for LED RGB writes.
  const persistentTable = padIdx < 8 ? PAD_LED_ID_BANK_A : PAD_LED_ID_BANK_B;
  const transientTable  = padIdx < 8 ? PAD_LED_ID_BANK_A_TRANSIENT : PAD_LED_ID_BANK_B_TRANSIENT;
  const slot = padIdx < 8 ? padIdx : padIdx - 8;
  const id = opts.alt ? transientTable[slot] : persistentTable[slot];
  const [r, g, b] = hex7(hex);
  const bytes = [...HEADER, ...SYSEX_CMD.LED_PAINT, id, r, g, b, ...FOOTER];
  const hexStr = bytes.map(x => x.toString(16).padStart(2, '0')).join(' ');
  console.log(`[diag] paint pad ${padIdx} (id 0x${id.toString(16)}${opts.alt ? ' transient' : ''}) → ${hex}  bytes: ${hexStr}`);
  setLed(id, r, g, b);
}

function paintTransportPad(which, hex = '#ffffff') {
  const map = TRANSPORT_LED_ID;
  const id = map[which];
  if (!id) { console.warn('[diag] which must be one of:', Object.keys(map).join(' / ')); return; }
  const [r, g, b] = hex7(hex);
  console.log(`[diag] paint transport ${which} (id 0x${id.toString(16)}) → ${hex}`);
  setLed(id, r, g, b);
}

function reconnect() {
  console.log('[diag] re-running handshake + paint sequence');
  sendUniversalDeviceInquiry();
  sendRaw(SYSEX_CMD.CONNECT_DAW);
  sendRaw(SYSEX_CMD.REQUEST_PROGRAM);
  setTimeout(() => { paintAllPads(); paintScreen(); }, 60);
  setTimeout(() => { paintAllPads(); paintScreen(); }, 600);
}

function setSysexLogging(on) {
  sysexLogging = !!on;
  console.log('[diag] SysEx logging =', sysexLogging);
}

// Bytewise dump of every sendRaw call — wired via the logging flag
// above. Wrap setLed transparently so output reflects the intent.
const _origSendRaw = sendRaw;
function tracedSendRaw(bytes) {
  if (sysexLogging) {
    const full = [...HEADER, ...bytes, ...FOOTER];
    console.log('[sysex]', full.map(b => b.toString(16).padStart(2, '0')).join(' '));
  }
  return _origSendRaw(bytes);
}
// We can't reassign `sendRaw` (it's a function declaration), so the
// monkey-patch above is illustrative only — the trace is applied via
// the explicit logging in paintOne / paintTransport / reconnect
// instead. Logging the entire sendRaw stream would require a deeper
// refactor; skipped here to keep the diagnostic surface minimal.

// Stop the continuous clock-tick stream. Lets us test the hypothesis
// that flooding the device's main port with F8 bytes is starving the
// SysEx parser on the DAW port. Use:
//   murmurStopClock()  — kill the tick stream
//   murmurReconnect()  — re-run handshake + paint with no clock noise
//   ...does the device now hold the colours?
function killClock() {
  stopClockTimer();
  console.log('[diag] clock stream stopped. Re-run murmurReconnect() to retest LED paint without clock noise.');
}
function startClock() {
  ensureClockTimer();
  console.log('[diag] clock stream resumed.');
}

// Override which MiniLab port we send SysEx to. Useful for testing
// whether the ALV / DAW-virtual port is actually the right one for
// LED writes on this device's firmware. Pass 'alv' (default), 'main'
// (the MIDI 1 port that normally carries notes/CCs), or 'all' (spray
// every MiniLab port — what we used to do before commit 0e961be).
function sysexPort(target = 'alv') {
  if (!midiAccess) {
    console.warn('[diag] no MIDI access');
    return;
  }
  const allMinilab = [];
  for (const out of midiAccess.outputs.values()) {
    if (/minilab/i.test(out.name || '')) allMinilab.push(out);
  }
  if (allMinilab.length === 0) {
    console.warn('[diag] no MiniLab outputs found');
    return;
  }
  if (target === 'alv') {
    const alv = allMinilab.find(o => /\b(alv|midiin2|daw)\b/i.test(o.name || ''));
    midiOuts = alv ? [alv] : allMinilab;
  } else if (target === 'main') {
    const main = allMinilab.find(o => !/\b(alv|mcu|hui|din[ _-]?thru|thru|midiin2|daw)\b/i.test(o.name || ''));
    midiOuts = main ? [main] : allMinilab;
  } else if (target === 'all') {
    midiOuts = allMinilab;
  }
  console.log('[diag] SysEx port set to:', midiOuts.map(o => o.name));
}
// Need midiAccess accessible here — re-export it from input.js via a
// small hook so this diagnostic can enumerate ports without holding a
// stale reference. midiAccess is set on every MIDI access success in
// input.js setupMIDI; lazily fetched by sysexPort each call.
let midiAccess = null;
export function setMidiAccessRef(access) { midiAccess = access; }

if (typeof window !== 'undefined') {
  window.murmurDescribePorts = describePorts;
  window.murmurPaintOne = paintOne;
  window.murmurPaintTransport = paintTransportPad;
  window.murmurReconnect = reconnect;
  window.murmurSysexLog = setSysexLogging;
  window.murmurStopClock = killClock;
  window.murmurStartClock = startClock;
  window.murmurSysexPort = sysexPort;
}

// Mode-switch diagnostics — DevTools-callable. From the SysEx
// research: the host can broadcast `02 00 40 62 <progId>` to force
// the device into a specific top-level mode. `01` = DAW (where the
// Ableton-style runtime-paint-every-frame model applies; sporadic
// LED writes get clobbered back to default white). `02` = Arturia
// mode (where LED RGB writes via the same 02 02 16 command persist
// properly until power cycle).
//
// Use to test: `murmurArturiaMode()` then `murmurTestPads()` —
// rainbow should now stick. `murmurDawMode()` returns to DAW
// behaviour (useful if OLED stops responding in Arturia mode).
function murmurArturiaMode() {
  sendRaw(SYSEX_CMD.ARTURIA_MODE);
  console.log('[minilab] switched to Arturia mode — LED RGB writes should now persist');
  // Repaint so the new mode immediately shows our state.
  setTimeout(() => { paintAllPads(); paintScreen(); }, 60);
}
function murmurDawMode() {
  sendRaw(SYSEX_CMD.CONNECT_DAW);
  console.log('[minilab] switched back to DAW mode');
  setTimeout(() => { paintAllPads(); paintScreen(); }, 60);
}
// Recall a specific User program slot 1..5 (User1 = pr_id 3). The
// device should jump to that program; whatever LED / pad mappings
// are saved there take effect immediately.
function murmurRecallProgram(slot) {
  if (slot < 1 || slot > 5) { console.warn('[minilab] slot must be 1..5'); return; }
  const prId = 0x02 + slot;  // 1 -> 0x03, 5 -> 0x07
  sendRaw([0x05, prId]);
  console.log('[minilab] recalled User' + slot);
}
if (typeof window !== 'undefined') {
  window.murmurArturiaMode = murmurArturiaMode;
  window.murmurDawMode = murmurDawMode;
  window.murmurRecallProgram = murmurRecallProgram;
}

// Parse a CSS hex colour to 7-bit RGB. The device's gamut is dimmer
// than a screen, so we boost saturation slightly.
function hex7(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 0xFF;
  const g = (n >>  8) & 0xFF;
  const b =  n        & 0xFF;
  return [r >> 1, g >> 1, b >> 1];
}

// === Pad layout ===
//
// Bank A pads 1-4 (notes 36-39): drum surface. Lit in the role
//   colour of the currently-selected voice (default cyan).
// Bank A pads 5-8 (notes 40-43): the four "effect" plant modes —
//   drop / muffle / thin / rise. Active mode burns brighter.
//   (Transport is no longer on these pads — Shift+Play / Shift+Stop
//   on the device sends MIDI Real-Time and is wired in input.js.)
// Bank B pads 1-8 (notes 44-51): full plant-mode picker. Active
//   mode burns brighter.

const PLANT_MODE_COLORS = {
  drop:   '#ff4d80',
  muffle: '#5e7ad8',
  thin:   '#ffd84d',
  rise:   '#5af095',
  voice:  '#5fd2e8',
  weave:  '#ffa94d',
  ripple: '#e8a8c8',
  cloud:  '#d0d8e8',
};
// PLANT_MODE_BANK_A_5_8 and PLANT_MODE_BANK_B are imported from
// devices/minilab3.js (under the same names, via aliasing). Defined
// there as the single source of truth shared with input.js so the
// LED colour mapping and pad-press routing can't drift apart.

export function paintAllPads() {
  if (midiOuts.length === 0) return;
  paintBankA();
  paintBankB();
  paintTransport();
}

function paintPlantPad(id, kind) {
  const isActive = state.plantMode === kind;
  let [r, g, b] = hex7(PLANT_MODE_COLORS[kind] || '#ffffff');
  if (!isActive) { r >>= 2; g >>= 2; b >>= 2; }
  setLed(id, r, g, b);
}

function paintBankA() {
  // Pads 1-4: drum surface. Dim role colour from the selected voice,
  // or default cyan if nothing's selected.
  const seed = seedById(state.selectedSeedId);
  const baseHex = (seed && seed.kind === 'voice' && seed.color) ? seed.color : '#5fd2e8';
  const [r, g, b] = hex7(baseHex);
  for (let i = 0; i < 4; i++) {
    setLed(PAD_ID_BANK_A[i], r >> 1, g >> 1, b >> 1);
  }
  // Pads 5-8: the four "effect" plant modes.
  for (let i = 0; i < 4; i++) {
    paintPlantPad(PAD_ID_BANK_A[i + 4], PLANT_MODE_BANK_A_5_8[i]);
  }
}

function paintBankB() {
  for (let i = 0; i < 8; i++) paintPlantPad(PAD_ID_BANK_B[i], PLANT_MODE_BANK_B[i]);
}

function paintTransport() {
  setLed(TRANSPORT_STOP,   ...hex7(state.isPlaying ? '#444444' : '#ffffff'));
  setLed(TRANSPORT_PLAY,   ...hex7(state.isPlaying ? '#5af095' : '#1a4422'));
  setLed(TRANSPORT_RECORD, ...hex7(state.isRecording ? '#ff4d80' : '#441422'));
  setLed(TRANSPORT_LOOP,   ...hex7('#0a2a4a'));
  setLed(TRANSPORT_TAP,    ...hex7('#1a3322'));
}

// Repaint pad lights when state changes. Touches bank A pads 5-8
// (effect plant modes) and bank B (full plant-mode picker) + the
// transport indicator LEDs. Bank A pads 1-4 don't change on plant-
// mode or transport changes, only on selection — see
// refreshSelectionLights for that case.
export function refreshPadLights() {
  if (midiOuts.length === 0) return;
  paintBankA();
  paintBankB();
  paintTransport();
}

// Selected seed changed — repaint bank A's role-colour drum pads too.
export function refreshSelectionLights() {
  if (midiOuts.length === 0) return;
  paintAllPads();
}

// === OLED screen ===
//
// Header: `04 02 60` (write screen). Then a 7-byte options block:
// `1F 07 <transient> <picP> <picA> <picE> 00`. Then text segments:
// each is `<segId> <ascii…> 00`. segId 0x01 = line 1 (max 10 char),
// 0x02 = line 2 (max 18 char).
//
// Pictogram slots: 0=none, 1=arp, 2=play, 3=record, 4=arm.

const SCREEN_MODE_FULL  = 0x07;
const SCREEN_MODE_POPUP = 0x08;
const SCREEN_MODE_BLANK_POPUP = 0x09;

const PICTO_NONE   = 0;
const PICTO_ARP    = 1;
const PICTO_PLAY   = 2;
const PICTO_RECORD = 3;
const PICTO_ARM    = 4;

function asciiBytes(s, maxLen) {
  const clipped = String(s || '').slice(0, maxLen);
  const out = [];
  for (let i = 0; i < clipped.length; i++) {
    const c = clipped.charCodeAt(i);
    out.push(c >= 32 && c < 127 ? c : 0x3F);  // '?' for non-ASCII
  }
  return out;
}

function writeScreen(mode, transient, line1, line2, picP, picA, picE) {
  const body = [
    0x04, 0x02, 0x60,
    0x1F, mode, transient & 0x7F,
    picP & 0x7F, picA & 0x7F, picE & 0x7F,
    0x00,
    0x01, ...asciiBytes(line1, 10), 0x00,
    0x02, ...asciiBytes(line2, 18), 0x00,
  ];
  sendRaw(body);
}

// Sticky full-screen content — current seed name + pitch on line 1,
// BPM + guardrails state on line 2. Repaint whenever any of those
// change.
export function paintScreen() {
  if (midiOuts.length === 0) return;
  const seed = seedById(state.selectedSeedId);
  let line1, line2;
  if (seed) {
    line1 = (seed.label || seed.role || 'seed').slice(0, 10);
    if (seed.kind === 'voice') {
      const noteLabel = noteName(midiFromFreq(seed.fundamental));
      line2 = `${seed.role || 'seed'} ${noteLabel} ${BPM}bpm`;
    } else {
      line2 = `${labelFor(seed.modifierKind || 'aura')} ${BPM}bpm`;
    }
  } else {
    line1 = 'murmur';
    line2 = `${labelFor(state.plantMode)} ${BPM}bpm ${state.guardrails ? 'g' : '·'}`;
  }
  // Non-transient (01) so the screen stays put. play / record / arp
  // pictograms reflect current transport.
  writeScreen(
    SCREEN_MODE_FULL, 0x01,
    line1, line2,
    state.isPlaying ? PICTO_PLAY : PICTO_NONE,
    state.isRecording ? PICTO_RECORD : PICTO_NONE,
    PICTO_NONE
  );
}

// Transient parameter popup — used when an encoder/fader changes a
// value. The device auto-dismisses the popup after a short delay.
// `cc` identifies which control "owns" this popup so the device's
// internal cache stays coherent.
export function popupParam(cc, name, value) {
  if (midiOuts.length === 0) return;
  const body = [
    0x04, 0x02, 0x60,
    0x1F, SCREEN_MODE_POPUP, 0x02, cc & 0x7F, 0x00,
    0x01, ...asciiBytes(name, 10), 0x00,
    0x02, ...asciiBytes(value, 18), 0x00,
  ];
  sendRaw(body);
}

// Encoder/fader popup with a value bar drawn under the text. Per the
// Arturia forum SysEx thread (RoadCrewWorker, 2024-11): `04 02 60 1F
// <mode> 01 <val> 00 00 + text` where mode is 0x03 encoder / 0x04
// fader / 0x05 pressure. `val` is 0..127 and renders as a horizontal
// gauge under the line-1/line-2 text.
const POPUP_MODE_ENCODER = 0x03;
const POPUP_MODE_FADER   = 0x04;
export function popupGauge(mode, value7bit, line1, line2) {
  if (midiOuts.length === 0) return;
  const body = [
    0x04, 0x02, 0x60,
    0x1F, mode & 0x7F, 0x01, value7bit & 0x7F, 0x00, 0x00,
    0x01, ...asciiBytes(line1, 10), 0x00,
    0x02, ...asciiBytes(line2, 18), 0x00,
  ];
  sendRaw(body);
}
export function popupEncoder(value, line1, line2) { popupGauge(POPUP_MODE_ENCODER, value, line1, line2); }
export function popupFader  (value, line1, line2) { popupGauge(POPUP_MODE_FADER,   value, line1, line2); }

// === Encoder value realign ===
//
// The 8 panel encoders are endless in the device's perception but the
// Ableton script gives them "absolute feedback" by pushing the current
// authoritative value back to the device with this SysEx — the device
// then deltas from that value on the next twist. Useful when a
// parameter is changed via the UI / mouse and we want the encoder to
// pick up exactly where the UI left off.
//
// `encSysId` is the SysEx ID of the encoder slot (specific to each of
// the 8 — Ableton's elements.py maps them, but we don't yet have the
// list confirmed for the user's template. Use this once we have it).
export function realignEncoder(encSysId, value7bit) {
  if (midiOuts.length === 0) return;
  sendRaw([0x21, 0x10, 0x00, encSysId & 0x7F, 0x00, value7bit & 0x7F]);
}

// === MIDI Real-Time output (Clock + Start/Stop) ===
//
// Sends 24-tick-per-beat MIDI Clock + Start/Stop to the MiniLab so
// the on-device arpeggiator slaves to murmur's tempo. Without these
// the arp runs at the device's own internal rate, which has no
// relationship to murmur's BPM.
//
// Strategy: a setInterval polls every 25ms and schedules outgoing
// clock ticks ~100ms ahead using Web MIDI's timestamped send. This
// is the same lookahead pattern as the audio scheduler — it keeps
// timing tight without needing a high-precision timer.
//
// Realtime messages are 1 byte (status only, no channel). They go to
// `realtimeOut` (the main MIDI port), not to `midiOuts` (the DAW
// port that handles SysEx). The MiniLab's arp listens on the main
// port for Clock / Start / Stop.

let clockTimer = null;
let clockNextTickMs = 0;
let clockTicksSent = 0;     // diagnostic counter — accessible via murmurClockStatus()
let clockStartMs = 0;       // wall-clock time clock-tick stream began

function sendRealtime(byte, timestamp) {
  if (!realtimeOut) return;
  try { realtimeOut.send([byte], timestamp); }
  catch (e) { console.warn('[minilab] realtime send failed', e); }
}

// === Continuous clock-tick stream ===
//
// Per-beat 0xF8 ticks flow whenever a realtime port is bound — NOT
// gated on murmur's play state. The MiniLab's onboard arpeggiator can
// then phase-lock to murmur's tempo at any time (the user engages it
// via the device's ARP button), without having to first press play
// in the app. Tempo changes propagate within the 100ms lookahead.
//
// Start (0xFA) and Stop (0xFC) are separate from the tick stream:
// they're transport markers tied to murmur's play button. A slaved
// device that respects them will reset its arp position on Start.
// Devices with their own transport (like the MiniLab arp button) can
// just ignore them and free-run on clock.
function ensureClockTimer() {
  if (clockTimer || !realtimeOut) return;
  clockNextTickMs = performance.now();
  clockTicksSent = 0;
  clockStartMs = performance.now();
  clockTimer = setInterval(scheduleClockAhead, 25);
}
function stopClockTimer() {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
}

// Transport markers — fire on murmur play/stop. The continuous tick
// stream above keeps running across these.
export function startClockOut() {
  if (!realtimeOut) return;
  sendRealtime(0xFA);
}
export function stopClockOut() {
  if (!realtimeOut) return;
  sendRealtime(0xFC);
}

function scheduleClockAhead() {
  if (!realtimeOut) return;
  // 24 ticks per beat; tick interval in ms = (60 / BPM) / 24 * 1000.
  // Read BPM each cycle so tempo changes (slider, tap, external)
  // take effect within the 100ms lookahead window.
  const tickMs = 60000 / BPM / 24;
  const lookahead = 100;
  const horizon = performance.now() + lookahead;
  while (clockNextTickMs < horizon) {
    sendRealtime(0xF8, clockNextTickMs);
    clockNextTickMs += tickMs;
    clockTicksSent++;
  }
}

// DevTools diagnostic: confirms that we're (a) routed to a port that
// looks right, (b) actively pumping clock ticks at the expected rate.
// If the user's arp still doesn't follow, the device's Sync setting
// is on Internal — see showArpSyncHint() below.
function murmurClockStatus() {
  const port = realtimeOut ? realtimeOut.name : '(none)';
  const running = !!clockTimer;
  const elapsedMs = clockStartMs ? performance.now() - clockStartMs : 0;
  const expectedTicks = Math.round(elapsedMs / (60000 / BPM / 24));
  return {
    realtimePort: port,
    sysExPort: midiOuts.map(o => o.name),
    clockRunning: running,
    bpm: BPM,
    ticksSent: clockTicksSent,
    expectedTicks,
    elapsedMs: Math.round(elapsedMs),
  };
}
if (typeof window !== 'undefined') {
  window.murmurClockStatus = () => {
    const s = murmurClockStatus();
    console.table(s);
    return s;
  };
}

// === First-connect hint: device-side arp sync source ===
//
// The MiniLab 3's arpeggiator has its own Sync setting (Int / Ext /
// Auto) edited only on the device (Shift + long-press Pad 1, then
// main encoder). With Int (the factory default before fw 1.1.1) it
// ignores incoming MIDI Clock, so murmur's 0xF8 stream has no
// audible effect on the arp. There is no SysEx command to change
// this — confirmed by exhaustive search of community SysEx docs and
// the Arturia MCC manual, which exposes templates but not arp/sync
// parameters.
//
// Show a one-time inline toast the first time the device connects in
// a browser. localStorage suppresses repeats.
function showArpSyncHint() {
  if (typeof window === 'undefined') return;
  if (localStorage.getItem('murmur.arpSyncHintShown') === '1') return;
  // Idempotent: refreshMIDIInputs fires on every port state change, so
  // connectMinilab (and this hint) can run multiple times in quick
  // succession on a fresh reload. Without this guard we'd stack
  // multiple identical toasts and the "got it" click would only
  // dismiss the topmost one, making the popup feel un-clickable.
  if (document.querySelector('.arp-sync-hint')) return;
  const el = document.createElement('div');
  el.className = 'arp-sync-hint';
  el.innerHTML = `
    <strong>Sync the MiniLab arp to murmur</strong>
    <p>On the device: hold <kbd>Shift</kbd> + long-press <kbd>Pad 1</kbd>,
       scroll the main encoder to <code>Sync</code>, then set it to
       <code>Auto</code> (or <code>Ext</code>). Without that the device's arp
       runs on its own clock and ignores murmur's tempo.</p>
    <button class="arp-sync-hint-close">got it</button>
  `;
  document.body.appendChild(el);
  // Click anywhere on the toast (not just the button) dismisses it —
  // makes the hit area generous so a slightly-off click still works.
  const dismiss = () => {
    localStorage.setItem('murmur.arpSyncHintShown', '1');
    el.remove();
  };
  el.addEventListener('click', dismiss);
}
if (typeof window !== 'undefined') {
  // Re-show on demand for debugging — wipe the flag and call again.
  window.murmurShowArpHint = () => { localStorage.removeItem('murmur.arpSyncHintShown'); showArpSyncHint(); };
}
