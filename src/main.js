// murmur — entry point.
// All real logic lives in the imported modules. This file orders the
// boot sequence so audio + UI subsystems mount before the demo
// composition lands and the AudioContext is requested.
//
// Import-order rationale:
//   1. state / constants / tempo — pure data, no side effects
//   2. audio/* — registers the onContextCreated hook for modifier chains
//   3. seeds + scheduler + inspector + snapshots + recording + transport
//      + input + pointer — each mounts its own DOM listeners on import
//   4. demo — plants the initial composition, calls tryCreateContext +
//      setupMIDI to kick everything off
//
// Cross-module function references (e.g. inspector calling takeSnapshot,
// snapshots calling liveNoteOff) go through registered handlers so
// nothing has to import from main.js.

'use strict';

import './state.js';
import './constants.js';
import './tempo.js';
import './timbres.js';

import './audio/patches.js';
import './audio/context.js';
import './audio/voices.js';
import './audio/chains.js';
import './audio/events.js';
import './audio/drum-kit.js';

import './seeds.js';
import './scheduler.js';

import { setTakeSnapshotFn, setReevaluateAllCapturesFn, showLiveTemplate } from './inspector.js';
import { takeSnapshot, setLiveNoteOffFn } from './snapshots.js';
import { liveNoteOff, setupMIDI } from './input.js';
import { reevaluateAllCaptures } from './pointer.js';
import { tryCreateContext } from './audio/context.js';
import { rollDemo, wireDemoControls } from './demo.js';

import './recording.js';
import './transport.js';
import './bloom-wind-config.js';
import './midi-log-panel.js';
import './metronome.js';
import './aura-tooltip.js';

// === Explicit boot sequence ===
// Most modules only attach DOM listeners at import time (which fire on
// later user events, so their relative order is irrelevant). The steps
// that do immediate, order-sensitive work are gathered here so the
// startup story reads top-to-bottom in one place rather than hiding at
// the bottom of demo.js.

// 1. Cross-module handlers that break would-be import cycles.
setTakeSnapshotFn(takeSnapshot);
setReevaluateAllCapturesFn(reevaluateAllCaptures);
setLiveNoteOffFn(liveNoteOff);

// 2. Plant the first composition (needs the snapshot handler above).
rollDemo();

// 3. Create the AudioContext now — it stays suspended until a user
//    gesture, but having it exist avoids hangs in resume() later.
tryCreateContext();

// 4. Request MIDI access + start device detection.
setupMIDI();

// 5. Wire the demo button / keyboard toggle / DevTools handle.
wireDemoControls();

// 6. Open the inspector to the live-timbre template so the user can
//    see and shape what the next plant will be.
showLiveTemplate();
