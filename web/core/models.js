// Per-model capabilities, keyed by the product name the earbuds advertise
// over Bluetooth. Capability data referenced from ear-web.

import { eqCapabilities } from './eq-presets.js';
import { spatialModesForMask } from './commands.js';
import { gestureCapabilities } from './gesture-profiles.js';

const ANC_BIT = {
  STRENGTH_MID: 0x02, // adds Mid (Low / Mid / High)
  STRENGTH_BASE: 0x04, // Low / High
  ADAPTIVE: 0x08,
  TRANSPARENCY: 0x10,
};

const FULL = 63;

// anc:     noise-control capability bits
// bass:    Bass Enhance level count (5, or 3 steps where the lowest is off); 0 = none
// inEar:   has in-ear detection
// ring:    find-my-earbuds style: 'buds' (left/right), 'headphone' or 'single' (one sound)
// eq:      equalizer preset profile (see eq-presets.js); treble: custom EQ treble band in Hz
// spatial: spatial audio capability mask (see SPATIAL_MODES in commands.js); 0 = none
// dual:    dual connection: 'yes', 'restart' (switching it restarts the earbuds) or 'none'
// sound:   Personal Sound Profile backend: 'mimi', 'audiodo' or null
// gestures: gesture layout (see gesture-profiles.js) or null if not supported yet
// Some names cover two hardware revisions (e.g. CMF Buds 2 / Buds Pro 2 come in
// 5-level and 3-step bass versions); the device layer corrects bass from the
// first report.
const MODELS = [
  { name: 'Nothing Headphone (1) Pro', id: 'B192', anc: FULL, bass: 0, inEar: true, ring: 'headphone', eq: 'headphonePro', treble: 3500, spatial: 0, dual: 'yes', sound: 'audiodo', gestures: null },
  { name: 'Nothing Headphone (1)', anc: FULL, bass: 5, inEar: true, ring: 'headphone', eq: 'nothing', treble: 3500, spatial: 7, dual: 'yes', sound: 'audiodo', gestures: null },
  { name: 'Nothing Headphone (a)', anc: FULL, bass: 3, inEar: false, ring: 'headphone', eq: 'nothing', treble: 3500, spatial: 28, dual: 'yes', sound: null, gestures: null },
  { name: 'Nothing Ear (open)', anc: FULL, bass: 0, inEar: false, ring: 'buds', eq: 'nothing', treble: 3400, spatial: 0, dual: 'yes', sound: null, gestures: null },
  { name: 'CMF Headphone Pro', anc: FULL, bass: 0, inEar: false, ring: 'headphone', eq: 'cmfNoDirac', treble: 3500, spatial: 28, dual: 'yes', sound: 'audiodo', gestures: null },
  { name: 'CMF Buds 2 Plus', anc: FULL, bass: 5, inEar: true, ring: 'buds', eq: 'cmfNoDirac', treble: 6900, spatial: 6, dual: 'yes', sound: 'audiodo', gestures: 'cmfTap' },
  { name: 'CMF Buds Pro 2', anc: FULL, bass: 5, inEar: true, ring: 'buds', eq: 'cmf', treble: 6900, spatial: 6, dual: 'restart', sound: null, gestures: 'cmfTap' },
  { name: 'Nothing Ear (3a)', anc: FULL, bass: 0, inEar: true, ring: 'buds', eq: 'nothing', treble: 3400, spatial: 6, dual: 'yes', sound: null, gestures: null },
  { name: 'Nothing Ear (a)', anc: FULL, bass: 5, inEar: true, ring: 'buds', eq: 'nothing', treble: 3400, spatial: 0, dual: 'yes', sound: null, gestures: null },
  { name: 'Nothing Ear (3)', anc: FULL, bass: 5, inEar: true, ring: 'buds', eq: 'nothing', treble: 3400, spatial: 6, dual: 'yes', sound: 'audiodo', gestures: null },
  { name: 'Nothing ear (1)', anc: 53, bass: 0, inEar: true, ring: 'single', eq: 'nothingNoCustom', treble: 3400, spatial: 0, dual: 'none', sound: null, gestures: null },
  { name: 'CMF Clip Pro', anc: FULL, bass: 3, inEar: false, ring: 'buds', eq: 'cmfNoDirac', treble: 3400, spatial: 6, dual: 'yes', sound: null, gestures: null },
  { name: 'Neckband Pro', form: 'neckband', anc: FULL, bass: 5, inEar: false, ring: 'headphone', eq: 'nothing', treble: 6900, spatial: 6, dual: 'restart', sound: null, gestures: null },
  { name: 'Ear (Stick)', anc: 33, bass: 0, inEar: true, ring: 'buds', eq: 'nothing', treble: 3500, spatial: 0, dual: 'none', sound: null, gestures: null },
  { name: 'CMF Buds 2a', anc: 49, bass: 5, inEar: false, ring: 'buds', eq: 'cmfDirac7', treble: 6900, spatial: 0, dual: 'yes', sound: null, gestures: null },
  { name: 'CMF Buds 2', anc: FULL, bass: 5, inEar: true, ring: 'buds', eq: 'cmf', treble: 6900, spatial: 6, dual: 'yes', sound: null, gestures: 'cmfTap' },
  { name: 'Nothing Ear', anc: FULL, bass: 5, inEar: true, ring: 'buds', eq: 'nothing', treble: 3400, spatial: 0, dual: 'yes', sound: 'mimi', gestures: null },
  { name: 'CMF Buds', anc: 49, bass: 5, inEar: true, ring: 'buds', eq: 'cmf', treble: 6900, spatial: 0, dual: 'restart', sound: null, gestures: null },
  { name: 'Buds Pro', anc: 55, bass: 0, inEar: true, ring: 'buds', eq: 'nothing', treble: 3400, spatial: 0, dual: 'none', sound: null, gestures: null },
  { name: 'Ear (2)', anc: FULL, bass: 0, inEar: true, ring: 'buds', eq: 'nothing', treble: 3400, spatial: 0, dual: 'restart', sound: 'mimi', gestures: null },
].sort((a, b) => b.name.length - a.name.length); // longest first: "CMF Buds 2 Plus" before "CMF Buds"

// Google Fast Pair model IDs (reported by the device over the Fast Pair
// message stream) -> model name in MODELS and the product colour.
// Identifies a renamed device and lets the panel draw it in its real colour.
const FAST_PAIR_MODELS = {
  '4DFC4A': { name: 'Neckband Pro', color: 'orange' },
  '26C190': { name: 'Neckband Pro', color: 'white' },
  'AE35FD': { name: 'Neckband Pro', color: 'black' },
};

// Unknown or renamed device: assume what current earbuds support.
const DEFAULT_MODEL = { anc: FULL, bass: 5, inEar: true, ring: 'buds', eq: 'nothing', treble: 3400, spatial: 0, dual: 'yes', sound: null, gestures: null };

function modelForName(name = '') {
  const lower = name.toLowerCase();
  if (/\bheadphones?\s*\(?1\)?\s*pro\b/i.test(name)) return MODELS.find((m) => m.id === 'B192');
  return MODELS.find((m) => lower.includes(m.name.toLowerCase())) ?? DEFAULT_MODEL;
}

// -> {
//   transparency, strengths: ['low','mid','high'] | ['low','high'] | [], adaptive,
//   bassSteps: 5 | 3 | 0,
//   inEar, lowLatency, ring: 'buds' | 'headphone' | 'single',
//   eq: { style, presets, customId, trebleHz },
//   spatialModes: [{ key, label }] ([] if none),
//   dualConnection, dualRestarts, personalSound: 'mimi' | 'audiodo' | null,
//   gestures: { sides, slots } | null,
//   form: 'neckband' | null, color: 'orange' | 'white' | 'black' | null,
// }
function capabilitiesForName(name, modelId) {
  const fastPair = FAST_PAIR_MODELS[modelId?.toUpperCase?.()] ?? null;
  const model = modelId === 'B192'
    ? MODELS.find((m) => m.id === modelId)
    : (fastPair && MODELS.find((m) => m.name === fastPair.name)) ?? modelForName(name);
  const { anc, bass, inEar, ring, eq, treble, spatial, dual, sound, gestures } = model;
  const hasBase = Boolean(anc & ANC_BIT.STRENGTH_BASE);
  const hasMid = Boolean(anc & ANC_BIT.STRENGTH_MID);

  let strengths = [];
  if (hasBase) strengths = hasMid ? ['low', 'mid', 'high'] : ['low', 'high'];

  return {
    pro: model.id === 'B192',
    form: model.form ?? null,
    color: fastPair?.color ?? null, // only known from the model ID
    transparency: Boolean(anc & ANC_BIT.TRANSPARENCY),
    strengths,
    adaptive: hasBase && Boolean(anc & ANC_BIT.ADAPTIVE),
    bassSteps: bass,
    inEar,
    lowLatency: true, // every model ear-web supports has it
    ring,
    eq: eqCapabilities(eq, treble),
    spatialModes: spatialModesForMask(spatial),
    dualConnection: dual !== 'none',
    dualRestarts: dual === 'restart',
    personalSound: sound,
    gestures: gestureCapabilities(gestures),
  };
}

// Levels the UI offers while Bass Enhance is on.
function bassLevels(steps) {
  if (steps === 3) return [1, 2];
  if (steps === 5) return [1, 2, 3, 4, 5];
  return [];
}

export { capabilitiesForName, bassLevels };
