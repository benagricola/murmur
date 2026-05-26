# murmur — agent handoff

## What this is

`murmur` is a single-file HTML web app (`murmur.html`, ~3900 lines) — a generative music production tool with a visual canvas. Seeds (sound sources) and modifiers (sphere-of-influence audio effects) sit on a 2D canvas. Voices are captured by modifiers when they fall inside their spheres. Notes play as scheduled loops. Live input via MIDI keyboard, QWERTY, or on-screen piano. The target user spans from a kid mashing keys to an adult composing arrangements, with a global "guardrails" toggle that snaps notes to scale and grid for the kid case.

The app deliberately rejects DAW conventions (no timeline, no sequencer, no track list). The mental model is closer to a garden than a workstation — you plant things on a canvas, they grow, you arrange them spatially, the music emerges from their relationships.

## Design philosophy (load-bearing)

These are decisions to inherit, not relitigate.

**Spatial geometry as the primary control.** Position on the canvas means something — it determines what modifier spheres capture a voice, what events reach it, how the eye groups related elements. Multiple modifiers can capture the same voice. Don't add tag-based filtering or category exclusions; the spatial logic is the point.

**Three visual classes of object, distinguishable at a glance by motion language:**
- **Seeds** — static position, pulse with their rhythm, shape encodes timbre
- **Modifiers** — static position, breathe slowly, have a soft sphere of influence
- **Events** — ephemeral, travel/expand/dissolve, don't persist after completing

Things that don't move are objects you place. Things that move are happenings. This is the resolution to "how do temporal and spatial things coexist on one canvas." Don't break it.

**Guardrails on by default.** New users (kids) should never hear out-of-key notes or off-grid timing by accident. Adults toggle guardrails off in the top bar. This single switch is the entire kid/adult mode distinction.

**Do real audio work, not metaphor.** Every visual concept maps to an actual audio effect: ripple is a real DelayNode with feedback, cloud is a real ConvolverNode with procedural impulse response, swing is real timing skew. Don't ship features whose audio behavior is decorative.

**Procedural timbre over preset libraries.** Six roles (kick, snare, hat, bass, melody, voice) each have a `generate()` function that produces variations within character. The 🎲 regenerate button re-rolls within the current role. Avoid the temptation to ship preset banks — generated variation is the point.

**Calibrate confidence honestly.** When something might not work in a particular environment (Android WebView audio policies, MIDI permission denials), surface the actual state in UI. The audio status indicator in the bottom-right is there because we lost half a session debugging "audio doesn't start" with no diagnostics.

## What exists right now

### Core architecture
- Single HTML file with embedded CSS + JS, no build step, no external scripts beyond Google Fonts
- Web Audio API for synthesis; SVG for all rendering
- AudioContext created at script load (suspended) to avoid Promise-hang issues on resume
- Mutable `BPM` / `BEAT_MS` / `BAR_MS`; intervals stored as bar-fractions in option arrays so tempo changes preserve musical relationships
- All inputs (MIDI, QWERTY, on-screen piano) funnel through `noteOn(midi, velocity)` / `noteOff(midi)`

### Seeds (sound sources)
Each seed has:
- `kind`: 'voice' or 'modifier'
- For voices: `role` (timbre identity), `synthesisModel` ('additive' | 'kick' | 'snare' | 'hihat'), `harmonics[12]`, `fundamental`, `decay`, `attackMs`, `intervalMs`, `pattern[]`, `gain`, `muted`, `quantize`, `capturedByIds: Set<number>`
- For modifiers: `modifierKind` (weave|ripple|cloud|poly), `sphereR`, plus kind-specific params (swing, delayMs, reverbSec, polyFactor)
- Visual: blob outline computed from harmonic spectrum (additive synthesis maps directly to shape — harmonic amplitudes = polar plot coefficients)

### Six timbre roles (procedural generators)
- **kick**: sine with pitch sweep 1.5x→0.5x over 60ms
- **snare**: triangle wave + bandpass-filtered noise (2.2kHz)
- **hat**: white noise through 7kHz highpass, 45ms decay
- **bass**: additive, strong fundamental, attack ~10ms, long decay
- **melody**: additive, smooth descending harmonic series
- **voice**: additive, vowel-formant peaks (ah/ee/oh templates), long attack/decay

Each `generate()` returns harmonics + decay + attackMs + intervalMs + fundamentalHz + synthesisModel.

### Modifiers (persistent spatial effects)
- **weave** (orange): applies swing/shuffle timing to captured voices. Swing options: straight/light/med/hard (0.50/0.58/0.67/0.75). Math: in a step pair, odd step delayed, even step shortened, pair total preserved.
- **ripple** (pink): DelayNode + feedback, delay time options 1/16 to 3/8 of a bar
- **cloud** (pale blue): ConvolverNode reverb, sizes room/hall/cave/space (0.7s to 5.0s)
- **poly** (green): scales captured voices' interval by polyFactor for polyrhythmic feel. Ratios: 3:2, 4:3, 5:4, 7:8

### Events (ephemeral temporal effects)
Bombs (radial, expanding from tap point, 1 bar duration):
- **drop** (pink): mute bomb. Voices inside the expanding sphere are silenced. Snaps back on pop.
- **muffle** (blue): lowpass filter at 380Hz. Voices inside sound muffled.
- **thin** (yellow): highpass filter at 2.4kHz. Voices inside sound thin/transistor-radio.

Sweeps (directional, tap-and-drag for start→end, 4 bar duration, commit state changes):
- **rise** (green): unmutes voices the wavefront crosses, in order. Persists after sweep completes.
- **fade** (pink-red): mutes voices the wavefront crosses. Persists.

Visual: bombs show expanding filled sphere + bright wavefront ring, pop with outward burst flash, affected seeds get colored echo halo. Sweeps show wavefront line perpendicular to travel direction + trailing filled region.

### Input
- **Web MIDI API** for connected USB MIDI keyboards (with permission). Shows device name and activity LED in top bar.
- **QWERTY keyboard** mapped a-row + w-row to ~2 octaves of MIDI notes
- **On-screen piano** at the bottom — 2 octaves (G3-G5), responsive width with horizontal scroll on mobile
- All three converge on `noteOn(midi, velocity)` / `noteOff(midi)`
- Sustained notes work via proper `liveNoteOn` / `liveNoteOff` with attack/sustain/release envelopes
- Velocity comes from MIDI (real values), QWERTY and touch default to 0.7 (no realistic velocity capture on a phone tap — pressure APIs unreliable)

### Recording
- Hit record (or 'r' key), play a phrase, auto-finishes after 1.5s of no activity AND no held keys
- Captures noteOn time, noteOff time (for duration), and velocity
- Phrase-to-seed compression: 16th-note grid with guardrails, 32nd-note grid without. Up to 16/32 steps. Per-step dedup (keeps loudest at same pitch).
- If a voice is selected when recording finishes, the recording **overwrites that seed's pattern** instead of planting a new seed
- Chords work — multiple keys held simultaneously become a single step with primary (lowest pitch) + `extras` array for additional tones

### Pattern model
Each step in a pattern:
```js
{
  offset: 0,           // semitones above seed's fundamental
  velocity: 1.0,       // 0..1
  duration: 1.0,       // in step-fractions (multiplied by intervalMs for actual ms)
  extras: [            // OPTIONAL — for chord tones
    { offset: 4, velocity: 0.9, duration: 1.0 },
    { offset: 7, velocity: 0.85, duration: 1.0 },
  ]
}
```
The `extras` field is purely additive — single-note patterns omit it. All existing code paths work unchanged whether or not extras are present.

### Chord visualization
When a chord step plays, the seed shows concentric stroked-blob outlines, one per note in the chord. Higher pitch = smaller outline (4% shrink per semitone). Outlines fade with envelope: attack over 40ms, sustain for note duration, fade through release. Drum-synth seeds skip chord rendering since they ignore pitch.

### Inspector (per-seed editor)
Opens when a seed is selected. Shows:
- Preset picker (the 6 timbre roles) — swap to a different role
- 🎲 regenerate button — re-roll within current role
- Pitch slider (snapped to scale, displays note names)
- Rhythm picker (musical notation: 1/16, 1/8, 1/4, ... 2 bar)
- Length picker (envelope decay, musical notation)
- Quantize toggle (per-seed grid lock)
- Muted toggle (silence this seed)
- Harmonic editor (12 vertical bars for partials 2-13)
- Pattern editor (drag dots; chord steps show extras as smaller dots with vertical connector bar; dragging primary moves whole chord preserving voicing)
- For modifiers: kind-specific picker (swing for weave, delay for ripple, size for cloud, ratio for poly)
- For modifiers: sphere reach picker (tight/med/wide/huge)

### Snapshot history
- Auto-snapshot after any meaningful change (200ms debounce)
- 16-snapshot ring buffer in the bottom timeline
- Click to revert (full state replacement)
- Snapshots include: all seed properties, captures, modifier params, role, swing, polyFactor, extras, durations

### Tempo
- Slider 60-180 BPM in top bar (default 120)
- `setBPM()` rescales every seed's intervalMs/decay/attackMs/delayMs to preserve bar-fractions

### Demo composition (loaded on page load)
- Four-on-floor groove at 120 BPM in G minor pentatonic
- kick (1+3), snare (2+4), hat (every 8th), bass (walking), lead (melodic), pad (two-chord progression)
- weave (light swing) and ripple modifiers, lead and pad captured by both

### Mobile responsiveness
- Top bar wraps to multiple rows on narrow screens
- Plant-group claims a full row of its own when wrapping (so the 11 chips don't overflow)
- Piano scrolls horizontally with a 580px minimum width
- Inspector becomes a bottom-sheet drawer (transform-based slide-up)
- Audio status indicator in bottom-right, small, doesn't block UI

### Audio robustness for restrictive environments
- AudioContext created at script load in suspended state
- `await audioCtx.resume()` wrapped in 1.5s timeout (some browsers return non-resolving Promises)
- PeriodicWave support tested on init; falls back to standard oscillator types (sawtooth/triangle/sine) chosen by harmonic content if unavailable
- Status indicator surfaces actual state at each init step
- Pre-init triggered by first user interaction via capture-phase listeners

## What's known to need work

### Deferred features (would be obvious next-iteration candidates)
- **Per-extra editing in pattern editor** — currently dragging a primary moves the whole chord; individual chord-note editing requires re-recording. Would need draggable extra dots without losing the "primary is obvious" affordance.
- **Pitch satellite handles** — discussed but not built. The idea: a small orbiting handle on selected seeds that you drag for a parameter (pitch, velocity, swing amount), with the parameter selectable from the inspector. Touch-friendly fine-tune mechanism.
- **Chord template buttons** — tap a button to convert the selected step to major/minor/sus4/dim chord based on its current root. Faster than recording chords by hand.
- **Held-note recording for chords with independent durations** — works for chords but all notes in a chord share the primary's sustain envelope behavior; per-extra duration tracking exists in the data model but might not perfectly preserve "play C, hold C, play E, release C, release E" patterns.
- **Voice-voice magnetism** — never built. Idea was louder voices duck quieter ones when nearby (sidechain-style). Would need continuous distance-based gain modulation rather than discrete capture.
- **Build/drop modifier variants** that don't fit bomb/sweep cleanly — pump-style sidechain compression, riser sweeps with pitch automation.

### Known limitations to flag (not bugs, but design corners)
- **Drum chord patterns** — visualization is now suppressed, but if someone records a chord while a drum role is selected, the resulting pattern has extras the synth ignores. Mild waste of pattern data, not broken.
- **Single chord-note can't be muted** — extras are part of a single step's data; you can't say "play this chord but not the 5th". Would need per-extra velocity gating.
- **Recording auto-finish on releasing all keys** is a 1.5s delay. If the user is composing and pauses between phrases, they get an unwanted finish. There's no manual "i'm done" alternative besides hitting the record button again.
- **Pattern editor doesn't show rests visually distinct from very quiet notes** — both render as faint dots. Acceptable but could be clearer.
- **No undo for recording a phrase you don't like** — only recourse is snapshot timeline or seed deletion.

### Untested / suspected fragility
- **Android WebView audio** — tested via fallbacks but the user's reports were inconclusive. The status indicator was specifically added so audio failures surface diagnostically. If audio doesn't start, the indicator text is the starting point for debugging.
- **Web MIDI permission flow on iOS Safari** — Web MIDI is not supported on Safari at all; the status will show "no midi support". QWERTY and piano work.
- **Tempo changes mid-playback** — should work musically (intervals rescale) but seeds re-phase at next schedule pass; might cause a one-step glitch.
- **Many concurrent chord visualizations** — capped at 30 voices per seed; beyond that older voices get dropped. Probably fine for any realistic usage.

## Decisions explicitly considered and rejected

These were thought through carefully — don't re-implement them without strong reason:

- **Build modifier as a separate object type with its own sphere.** Considered when discussing build/drop. Rejected because events should travel, not sit. Bombs (radial) and sweeps (directional) cover the cases.
- **Ableton-style scenes** with save/recall and crossfade timing. Considered when discussing progression. Rejected for now because it adds significant UI and assumes a compose-then-perform workflow; murmur's identity is more performative.
- **Tag-based event filters** ("this drop ignores drums"). Considered when discussing how events choose what to affect. Rejected because spatial position is already the filter — place the bomb where the drama is. Don't undermine the spatial model with another control axis.
- **MIDI Learn for hardware controls** (turn a knob, click a UI setting, knob is now bound). Discussed, deferred indefinitely. The use case is rare enough and the architecture investment large enough that it doesn't pay back.
- **Velocity capture from touch tap.** Browsers don't reliably expose pressure data on touch; we'd be guessing. QWERTY and touch use a fixed 0.7. Real velocity comes only from MIDI.
- **Per-seed mute via tap gesture.** Considered when discussing progression. Rejected because tap is already "open inspector" and double-tap on a small target on mobile is fiddly. Mute lives in the inspector instead, which keeps gestures unambiguous.

## File structure (one HTML file, sections in order)

Starting from line 1:
1. HTML head + Google Fonts link
2. CSS (lines ~10-770): all styling including mobile responsive rules
3. HTML body (lines ~750-940): top bar, canvas, piano, inspector, timeline
4. JS (lines ~950-3870):
   - Constants and musical units (BPM, intervals, scale, color palettes)
   - Timbre role generators
   - State (seeds[], activeEvents[], plantMode, etc.)
   - Audio: context creation, drum synth, additive synth, live note on/off, modifier audio chains, event audio (filter bombs)
   - Routing helper: `routeFinalOutput(seed, node)` — single entry point for note output, handles bombs/modifiers/master
   - Seed model: makeSeed, removeSeed, blob path, peak attachments
   - Render: per-seed nodes, spheres, tethers, events, chord outlines
   - Scheduler: per-frame note scheduling with swing and polyrhythm
   - Visual tick: pulse animations, chord outline rendering, event updates
   - Canvas pointer: tap/drag dispatch, planting voices/modifiers/events
   - Inspector: preset/regenerate, pitch/rhythm/length/swing/delay/size/ratio pickers, quantize/mute toggles, pattern editor, harmonic editor
   - Recording: noteOn capture, phraseFromRecording compression with chord support
   - Snapshots: state serialization and revert
   - Demo composition (lines ~3700-3780): all initial seeds and captures
   - Init: tryCreateContext, setupMIDI

## How to deploy

The file is self-contained — single HTML, no build step. Host anywhere static (GitHub Pages, Netlify, S3, anywhere). Web MIDI requires HTTPS (works on localhost too). Google Fonts loads from CDN at runtime, no bundling needed.

## User preferences (recurring across the conversation)

The user values:
- Cheap-for-them, expensive-for-the-agent tradeoffs (do the work, don't ask)
- No silent failures (visible diagnostics for things that might break)
- Honest confidence calibration (say "I'm not sure" when uncertain)
- Tight responses; no recap of what they already know
- Mobile usability (they were testing in Android WebView and on phones)
- Both the kid AND the adult use case — neither alone is sufficient

The user is technically literate and designs alongside the agent — explicitly says "I'd love ideas" when they want brainstorming, gives concrete musical context (D&B, jungle, reggae, ska, pop as target genres), and pushes back on weak design (e.g. "weave doesn't earn its place" led to swing). Treat them as a collaborator, not a customer.

## What to ask the user when picking up

1. **Did the GitHub Pages deploy work?** They mentioned wanting to try it on a computer with a MIDI device. The Web MIDI access requires HTTPS, which Pages provides.
2. **What worked and what didn't with real MIDI hardware?** Velocity, sustain, recording with held notes — these only get a real test with hardware.
3. **What musical use case is next?** They mentioned wanting to make D&B, jungle, reggae, ska, pop. If they tried one of those and hit a wall, that's the next thread.
4. **Anything broken in real-world use vs the prototype tests?** The Android WebView audio history suggests reality might differ from what tests show.

## Tonal pitfalls to avoid

- Don't suggest building "a timeline" or "a track view" — those would break the canvas model.
- Don't add complexity to make features "more pro" — the kid case is load-bearing.
- Don't pad responses with structure for its own sake — the user pushed back on this directly. Prose, brief, direct.
- Don't restate decisions just made. If something already shipped, don't recap it back.
- Don't ask permission before doing the work. If a decision needs to be made and you can make it defensibly, make it and explain.
