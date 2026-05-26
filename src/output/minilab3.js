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

// SysEx header constants. The `42` at the end is the MiniLab 3
// product byte and is fixed for this device family.
const HEADER = [0xF0, 0x00, 0x20, 0x6B, 0x7F, 0x42];
const FOOTER = [0xF7];

// All MiniLab outputs we've seen on this device — we send SysEx to
// every one of them and let the device pick. Different firmware
// versions route lights / screen through different ports (some use
// the main port, some the ALV port). Spamming all of them is harmless
// because the device ignores SysEx with the wrong manufacturer ID.
let midiOuts = [];

// Bind to every MIDI output whose name suggests it belongs to a
// MiniLab (case-insensitive substring match) and run the DAW
// handshake. `outputs` is the array maintained in input.js — passed
// in so this module doesn't have to import upward (cycle).
export function connectMinilab(outputs) {
  midiOuts = (outputs || []).filter(o => /minilab/i.test(o.name || ''));
  if (midiOuts.length === 0 && outputs && outputs.length > 0) {
    // No port name matched — fall back to whatever's first so test
    // hardware with unusual names still gets the handshake.
    midiOuts = [outputs[0]];
  }
  if (midiOuts.length === 0) return false;
  console.log('[minilab] sending SysEx to', midiOuts.map(o => o.name));
  // Hello sequence from Ableton's __init__.py: enter DAW mode, then
  // request the device's current program. Reply lands on the input
  // port and is captured by the regular MIDI log.
  sendRaw([0x02, 0x00, 0x40, 0x6A, 0x21]);
  sendRaw([0x01, 0x00, 0x40, 0x01]);
  // After handshake the device is ready to accept LED and screen
  // writes. Push initial state so the user sees something immediately.
  setTimeout(() => { paintAllPads(); paintScreen(); }, 60);
  return true;
}

export function disconnectMinilab() {
  if (midiOuts.length === 0) return;
  sendRaw([0x02, 0x00, 0x40, 0x6A, 0x20]);
  midiOuts = [];
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

const PAD_ID_BANK_A = [0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B];
const PAD_ID_BANK_B = [0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x4B];
const TRANSPORT_LOOP   = 0x57;
const TRANSPORT_STOP   = 0x58;
const TRANSPORT_PLAY   = 0x59;
const TRANSPORT_RECORD = 0x5A;
const TRANSPORT_TAP    = 0x5B;

function rgb7(r, g, b) {
  return [r & 0x7F, g & 0x7F, b & 0x7F];
}

function setLed(id, r, g, b) {
  sendRaw([0x02, 0x02, 0x16, id, ...rgb7(r, g, b)]);
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
// Bank A pads 1-4 (notes 36-39) are drum-style hits. We light them in
// the role colour of the currently-selected voice (or default cyan).
// Bank A pads 5-8 (notes 40-43) are transport: stop / play / record /
// tap. Their colour reflects current playing/recording state.
//
// Bank B pads 1-8 (notes 44-51) are plant-mode selectors mirroring the
// chip strip in the canvas tool palette. The active plant mode burns
// brighter than the rest.

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
const PLANT_MODE_BANK_B = ['drop', 'muffle', 'thin', 'rise', 'voice', 'weave', 'ripple', 'cloud'];

export function paintAllPads() {
  if (!midiOut) return;
  paintBankA();
  paintBankB();
  paintTransport();
}

function paintBankA() {
  // Pads 1-4: drum surface. Dim role colour from the selected voice,
  // or default cyan if nothing's selected.
  const seed = seedById(state.selectedSeedId);
  const baseHex = (seed && seed.kind === 'voice' && seed.color) ? seed.color : '#5fd2e8';
  const [r, g, b] = hex7(baseHex);
  for (let i = 0; i < 4; i++) {
    // Pads 1-4 get the dim hue.
    setLed(PAD_ID_BANK_A[i], r >> 1, g >> 1, b >> 1);
  }
  // Pads 5-8: transport markings — give them their own static palette
  // so they read as functional, not as part of the drum row.
  setLed(PAD_ID_BANK_A[4], ...hex7('#ffffff'));     // stop
  setLed(PAD_ID_BANK_A[5], ...hex7('#5af095'));     // play
  setLed(PAD_ID_BANK_A[6], ...hex7('#ff4d80'));     // record
  setLed(PAD_ID_BANK_A[7], ...hex7('#ffd84d'));     // tap
}

function paintBankB() {
  for (let i = 0; i < 8; i++) {
    const kind = PLANT_MODE_BANK_B[i];
    const isActive = state.plantMode === kind;
    let [r, g, b] = hex7(PLANT_MODE_COLORS[kind] || '#ffffff');
    if (!isActive) { r >>= 2; g >>= 2; b >>= 2; }
    setLed(PAD_ID_BANK_B[i], r, g, b);
  }
}

function paintTransport() {
  setLed(TRANSPORT_STOP,   ...hex7(state.isPlaying ? '#444444' : '#ffffff'));
  setLed(TRANSPORT_PLAY,   ...hex7(state.isPlaying ? '#5af095' : '#1a4422'));
  setLed(TRANSPORT_RECORD, ...hex7(state.isRecording ? '#ff4d80' : '#441422'));
  setLed(TRANSPORT_LOOP,   ...hex7('#0a2a4a'));
  setLed(TRANSPORT_TAP,    ...hex7('#1a3322'));
}

// Repaint just the bank-B strip + transport buttons when state changes
// — cheaper than a full repaint, and lets us call this from many call
// sites without worrying about cost.
export function refreshPadLights() {
  if (!midiOut) return;
  paintBankB();
  paintTransport();
}

// Selected seed changed — repaint bank A's role-colour drum pads too.
export function refreshSelectionLights() {
  if (!midiOut) return;
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
  if (!midiOut) return;
  const seed = seedById(state.selectedSeedId);
  let line1, line2;
  if (seed) {
    line1 = (seed.label || seed.role || 'seed').slice(0, 10);
    if (seed.kind === 'voice') {
      const noteLabel = noteName(midiFromFreq(seed.fundamental));
      line2 = `${seed.role || 'voice'} ${noteLabel} ${BPM}bpm`;
    } else {
      line2 = `${seed.modifierKind || 'mod'} ${BPM}bpm`;
    }
  } else {
    line1 = 'murmur';
    line2 = `${state.plantMode} ${BPM}bpm ${state.guardrails ? 'g' : '·'}`;
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
  if (!midiOut) return;
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
  if (!midiOut) return;
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
  if (!midiOut) return;
  sendRaw([0x21, 0x10, 0x00, encSysId & 0x7F, 0x00, value7bit & 0x7F]);
}
