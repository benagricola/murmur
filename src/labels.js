// Internal-name → user-facing-label mapping.
//
// Two-layer naming convention: internal code uses traditional
// audio-engineering terms (voice / modifier / pulse / sweep / poly)
// so anyone reading the source understands what each thing IS from
// an audio perspective. The UI uses garden-metaphor labels (seed /
// aura / bloom / wind / vine) so the user reads the app as the
// "garden of sound" it tries to be.
//
// Mapping changes are visible-text-only. Internal `kind` values
// (state.plantMode strings, seed.kind, ev.type, etc.) stay
// unchanged — only the displayed text differs.

export const KIND_LABELS = {
  // Voice / seed kinds (the one tap-plant kind)
  voice:    'seed',
  // Aura kinds (modifier subtypes)
  weave:    'weave',
  ripple:   'ripple',
  cloud:    'cloud',
  poly:     'vine',     // poly = polyrhythm (internal); vine = the look
  drive:    'drive',    // soft-clip distortion territory
  gain:     'boost',    // volume amplification territory
  mute:     'hush',     // volume reduction territory
  squash:   'squash',   // compressor — punch + pump
  wobble:   'wobble',   // LFO modulation — movement
  crush:    'crush',    // bitcrusher — lo-fi grit
  shift:    'shift',    // pattern variation roller
  lfo:      'tide',     // LFO — modulates other auras' strength over time
  // Bloom kinds (radial one-shots — internal `pulse` category)
  drop:     'drop',
  muffle:   'muffle',
  thin:     'thin',
  // Wind kinds (directional one-shots — internal `sweep` category)
  rise:     'rise',
  fade:     'fade',
};

// Category labels — used for the inspector header and other places
// that say things like "modifier · ripple" → "aura · ripple".
export const CATEGORY_LABELS = {
  voice:    'seed',
  modifier: 'aura',
  pulse:    'bloom',
  sweep:    'wind',
  // Legacy: events that came back via a pre-rename snapshot still
  // type-tag themselves as `bomb`. Map both spellings.
  bomb:     'bloom',
};

export function labelFor(kind) {
  return KIND_LABELS[kind] || kind;
}
export function categoryLabel(category) {
  return CATEGORY_LABELS[category] || category;
}
