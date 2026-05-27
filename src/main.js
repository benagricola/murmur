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

import './seeds.js';
import './scheduler.js';

import { setTakeSnapshotFn, setReevaluateAllCapturesFn } from './inspector.js';
import { takeSnapshot, setLiveNoteOffFn } from './snapshots.js';
import { liveNoteOff } from './input.js';
import { reevaluateAllCaptures } from './pointer.js';

import './recording.js';
import './transport.js';
import './bloom-wind-config.js';
import './midi-log-panel.js';

// Wire the cross-module handlers that break import cycles.
setTakeSnapshotFn(takeSnapshot);
setReevaluateAllCapturesFn(reevaluateAllCaptures);
setLiveNoteOffFn(liveNoteOff);

import './demo.js';
