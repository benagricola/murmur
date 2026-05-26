// Patch helpers. A "patch" is the recipe for one note:
// { layers: [{voice, params, gain}], envelope, category }.
// These helpers shim around legacy seeds (no patch field) and derive
// a representative harmonic profile from a patch for visualisation.

// Legacy seed → patch shim. Older seeds (and snapshots from before the
// voice/patch refactor) only carry the flat `harmonics + decay + attackMs
// + synthesisModel` fields. Build a one-layer patch from those so the
// new player can render them without us needing a database migration.
export function patchFromLegacySeed(seed) {
  if (seed._cachedPatch) return seed._cachedPatch;
  const model = seed.synthesisModel || 'additive';
  let layers;
  if (model === 'kick')       layers = [{ voice: 'kick',   gain: 1, params: {} }];
  else if (model === 'snare') layers = [{ voice: 'snare',  gain: 1, params: {} }];
  else if (model === 'hihat') layers = [{ voice: 'hihat',  gain: 1, params: {} }];
  else                        layers = [{ voice: 'additive', gain: 1, params: { harmonics: seed.harmonics } }];
  const category = (model === 'kick' || model === 'snare' || model === 'hihat') ? 'drum' : 'tonal';
  const patch = {
    layers,
    envelope: { attackMs: seed.attackMs || 8, releaseMs: seed.decay || 400 },
    category,
  };
  seed._cachedPatch = patch;
  return patch;
}

// Build a representative 12-element harmonic profile from a patch for
// the visual blob shape. Reads the first additive layer if present,
// otherwise picks a tasteful default based on the dominant voice type.
export function harmonicsForPatch(patch) {
  if (!patch || !patch.layers) return [0.4, 0.2, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const layer of patch.layers) {
    if (layer.voice === 'additive' && layer.params && layer.params.harmonics) {
      return layer.params.harmonics.slice();
    }
  }
  const first = patch.layers[0];
  if (!first) return [0.4, 0.2, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0];
  if (first.voice === 'subtractive') return [0.5, 0.25, 0.15, 0.10, 0.07, 0.05, 0.03, 0.02, 0.01, 0, 0, 0];
  if (first.voice === 'fm')          return [0.3, 0.18, 0.12, 0.08, 0.10, 0.06, 0.08, 0.04, 0.06, 0.03, 0, 0];
  if (first.voice === 'supersaw')    return [0.45, 0.22, 0.14, 0.09, 0.06, 0.04, 0.03, 0.02, 0.01, 0, 0, 0];
  if (first.voice === 'noise')       return [0.10, 0.08, 0.06, 0.06, 0.08, 0.10, 0.06, 0.05, 0.04, 0.03, 0.02, 0.01];
  if (first.voice === 'kick')        return [0.7, 0.15, 0.05, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  if (first.voice === 'snare')       return [0.15, 0.12, 0.10, 0.20, 0.15, 0.10, 0.08, 0.06, 0.04, 0, 0, 0];
  if (first.voice === 'hihat')       return [0.02, 0.03, 0.04, 0.05, 0.08, 0.12, 0.18, 0.20, 0.15, 0.10, 0.06, 0.04];
  return [0.4, 0.2, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0];
}
