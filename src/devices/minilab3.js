// Arturia MiniLab 3 — central binding constants.
//
// Single source of truth for every device-specific magic number we
// rely on: CC numbers for encoders / faders / rotary, pad note ranges
// and channels, SysEx pad IDs for LEDs, transport LED IDs, and the
// SysEx header. Anywhere else in the codebase that needs to know
// about MiniLab specifics should import from this file rather than
// hardcoding.
//
// When we eventually grow a `Device` abstraction (driver per
// controller, generic fallback for unknown MIDI input), this file
// will be the MiniLab driver's static descriptor.

// === SysEx framing ===
// The 6-byte header is fixed for every Arturia SysEx message; 0x42
// is the MiniLab 3 product ID. 0xF7 closes every SysEx.
export const SYSEX_HEADER = [0xF0, 0x00, 0x20, 0x6B, 0x7F, 0x42];
export const SYSEX_FOOTER = [0xF7];

// === Continuous controllers ===
// Main rotary is the big knob beside the screen, in relative-1 mode.
// Display-encoder click is the same big knob's push gesture.
// Sustain CC 64 is the standard MIDI pedal — works regardless of
// device template.
export const MAIN_ROTARY_CC = 28;
export const DISPLAY_ENCODER_CLICK_CC = 118;
export const SUSTAIN_PEDAL_CC = 64;
export const MOD_STRIP_CC = 1;

// 8 panel encoders, slot 0..7, all absolute 0..127 in the user's
// template. CC numbers are device-defaults — re-confirmed from a real
// MIDI log against the user's MiniLab 3.
export const ENCODER_CCS = [86, 87, 89, 90, 110, 111, 116, 117];

// 4 faders, slot 0..3, absolute 0..127.
export const FADER_CCS = [14, 15, 30, 31];

// === Pads — note routing ===
// All pads transmit on MIDI channel 10 (drum channel by convention).
// Bank A is the default 8 pads; bank B is what the Pad B button
// selects on the device.
export const PAD_CHANNEL = 10;
export const PAD_NOTE_BANK_A_BASE = 36;   // pad 1 bank A = note 36
export const PAD_NOTE_BANK_B_BASE = 44;   // pad 1 bank B = note 44
export const PAD_NOTE_RANGE_BANK_A = [36, 43];  // inclusive
export const PAD_NOTE_RANGE_BANK_B = [44, 51];  // inclusive

// === Pads — LED SysEx IDs ===
// IDs the `02 02 16 <ID> <R> <G> <B>` LED-paint command targets. The
// 0x34..0x4B range is the "persistent" set that survives until power
// cycle; 0x04..0x1B is the "transient" set used by some firmware
// versions. We default to persistent; the diagnostic harness can
// switch.
export const PAD_LED_ID_BANK_A = [0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B];
export const PAD_LED_ID_BANK_B = [0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x4B];
export const PAD_LED_ID_BANK_A_TRANSIENT = [0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B];
export const PAD_LED_ID_BANK_B_TRANSIENT = [0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B];

// === Round transport button LEDs ===
// Mapped by name so callers can `LED.transport.play` etc. without
// remembering the hex values.
export const TRANSPORT_LED_ID = {
  loop:   0x57,
  stop:   0x58,
  play:   0x59,
  record: 0x5A,
  tap:    0x5B,
};

// === Plant-mode pad assignments (murmur-specific) ===
// Bank A pads 5-8 map to the four "effect" plant modes — quick-access
// while finger-drumming on pads 1-4. Bank B is the full picker.
// These are CONVENTIONS the rest of murmur enforces, not anything
// the device itself knows about.
export const PAD_BANK_A_5_8_PLANT_MODES = ['drop', 'muffle', 'thin', 'rise'];
export const PAD_BANK_B_PLANT_MODES = [
  'drop',   // pad 1
  'muffle', // pad 2
  'thin',   // pad 3
  'rise',   // pad 4
  'voice',  // pad 5
  'weave',  // pad 6
  'ripple', // pad 7
  'cloud',  // pad 8
];

// === Port matching ===
// Regex patterns we use to identify the device's special-purpose
// ports during enumeration. The DAW pattern matches the LED/OLED
// SysEx port; the SPECIAL pattern excludes every named non-main port
// so the main port can be picked by exclusion.
export const PORT_NAME_DEVICE = /minilab/i;
export const PORT_NAME_DAW    = /\b(alv|midiin2|daw)\b/i;
export const PORT_NAME_SPECIAL = /\b(alv|mcu|hui|din[ _-]?thru|thru|midiin2|daw)\b/i;

// === SysEx command verbs ===
// The byte after the SYSEX_HEADER that names the command. Keep all
// the named verbs we send in one table for readability — beats
// scattered hex literals.
export const SYSEX_CMD = {
  CONNECT_DAW:        [0x02, 0x00, 0x40, 0x6A, 0x21],
  DISCONNECT_DAW:     [0x02, 0x00, 0x40, 0x6A, 0x20],
  ARTURIA_MODE:       [0x02, 0x00, 0x40, 0x62, 0x02],
  DAW_MODE:           [0x02, 0x00, 0x40, 0x62, 0x01],
  REQUEST_PROGRAM:    [0x01, 0x00, 0x40, 0x01],
  LED_PAINT:          [0x02, 0x02, 0x16],   // followed by <ID> <R> <G> <B>
  SCREEN_WRITE:       [0x04, 0x02, 0x60],   // followed by mode + ascii blocks
  ENCODER_VALUE:      [0x21, 0x10, 0x00],   // followed by <enc_id> 00 <value>
};

// === Long-press threshold (display encoder click) ===
// CC 118 short press = re-roll, long press = revert from history.
// 500ms matches the device's own UI long-press feel.
export const ENCODER_LONG_PRESS_MS = 500;
