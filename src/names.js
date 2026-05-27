// Generative names for sounds / seeds. Two-word "adjective + noun"
// combinations from a deliberately small dictionary so the names
// feel coherent (everything is a little woodland-meets-twilight)
// rather than chaotic. About 50 × 50 = 2,500 unique names — plenty
// without crossing into forgettable territory.
//
// Used as a quick visual marker on the inspector / OLED so a user
// can tell at a glance whether a 🎲 re-roll actually produced a new
// patch vs. one they've heard before.

const ADJECTIVES = [
  'amber', 'twilit', 'glass', 'velvet', 'silver', 'mossy', 'dewy',
  'soft', 'pearl', 'cobalt', 'rust', 'lichen', 'fern', 'sable',
  'paper', 'cedar', 'gilded', 'frosted', 'inky', 'wild', 'crisp',
  'low', 'hollow', 'dusty', 'bronze', 'jade', 'satin', 'thawed',
  'lit', 'still', 'distant', 'closer', 'humid', 'shy', 'bright',
  'warm', 'cool', 'quiet', 'tin', 'patient', 'lazy', 'old',
  'new', 'pale', 'ember', 'mist', 'shorn', 'spry', 'tender', 'rough',
];

const NOUNS = [
  'willow', 'fox', 'moth', 'finch', 'reed', 'thrush', 'lark',
  'mantle', 'pebble', 'lantern', 'thistle', 'briar', 'bramble',
  'fawn', 'otter', 'sparrow', 'beech', 'sycamore', 'elder',
  'cobble', 'kestrel', 'wren', 'badger', 'meadow', 'orchard',
  'gable', 'eave', 'thatch', 'cinder', 'spire', 'tarn', 'cove',
  'glen', 'copse', 'mound', 'furrow', 'shoal', 'cairn', 'rookery',
  'shanty', 'bothy', 'gully', 'rivulet', 'spinney', 'holler',
  'hollow', 'thicket', 'henge', 'fold', 'hush',
];

export function generateName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a} ${n}`;
}
