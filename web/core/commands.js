// Command ids and payload codecs for the features this app supports:
// battery, noise control, bass and quick settings. Values referenced from ear-web.

const Command = {
  GET_BATTERY: 0xc007,
  GET_NOISE_MODE: 0xc01e,
  SET_NOISE_MODE: 0xf00f,
  GET_BASS: 0xc04e,
  SET_BASS: 0xf051,
  GET_IN_EAR: 0xc00e,
  SET_IN_EAR: 0xf004,
  GET_LOW_LATENCY: 0xc041,
  SET_LOW_LATENCY: 0xf040,
  GET_FIRMWARE: 0xc042,
  GET_FLAT_EQ: 0xc068,
  GET_ADVANCED_EQ: 0xc04c,
  SET_ADVANCED_EQ: 0xf04f,
  RING: 0xf002,
  // Equalizer presets: Nothing models use "EQ", CMF models "listening mode".
  GET_EQ: 0xc01f,
  SET_EQ: 0xf010,
  GET_LISTENING_MODE: 0xc050,
  SET_LISTENING_MODE: 0xf01d,
  GET_CUSTOM_EQ: 0xc044,
  SET_CUSTOM_EQ: 0xf041,
  GET_SPATIAL_AUDIO: 0xc04f,
  SET_SPATIAL_AUDIO: 0xf052,
  GET_DUAL_ENABLE: 0xc027,
  SET_DUAL_ENABLE: 0xf01a,
  GET_DUAL_LIST: 0xc028,
  SET_DUAL_CONNECT: 0xf01b,
  // Personal Sound Profile: Mimi (older Nothing models) or Audiodo (newer ones)
  GET_MIMI: 0xc022,
  SET_MIMI: 0xf015,
  GET_AUDIODO: 0xc05a,
  SET_AUDIODO: 0xf05c,
  GET_GESTURES: 0xc018,
  SET_GESTURE: 0xf003,
};

// Frames the earbuds send back (replies and unsolicited updates).
const Response = {
  BATTERY: [0x4007, 0xe001, 0x6001],
  FLAT_EQ: [0x4068, 0xe01c, 0x601c],
  ADVANCED_EQ: [0x404c],
  NOISE_MODE: [0x401e, 0xe003, 0x6003],
  BASS: [0x404e],
  IN_EAR: [0x400e],
  LOW_LATENCY: [0x4041],
  FIRMWARE: [0x4042],
  EQ_PRESET: [0x401f, 0x4050], // reply to GET_EQ / GET_LISTENING_MODE
  CUSTOM_EQ: [0x4044],
  SPATIAL_AUDIO: [0x404f],
  DUAL_ENABLE: [0x4027],
  DUAL_LIST: [0x4028],
  DUAL_DEVICE_EVENT: [0xe00e], // a remembered device connected or disconnected
  MIMI: [0x4022],
  AUDIODO: [0x405a, 0xe019, 0x6019], // reply, plus pushes when it changes on the buds
  GESTURES: [0x4018],
};

// ---- Battery ----------------------------------------------------------------

const BATTERY_PART = { 0x02: 'left', 0x03: 'right', 0x04: 'case', 0x06: 'stereo' };
const LEVEL_MASK = 0x7f;
const CHARGING_MASK = 0x80;

// payload: [count, (partId, level|charging)*count]
// Parts not listed (e.g. a bud in the closed case) come back as null.
function decodeBattery(payload) {
  const battery = { left: null, right: null, case: null, stereo: null };
  const count = payload[0] ?? 0;
  for (let i = 0; i < count; i++) {
    const part = BATTERY_PART[payload[1 + i * 2]];
    const raw = payload[2 + i * 2];
    if (!part || raw === undefined) continue;
    battery[part] = { level: raw & LEVEL_MASK, charging: (raw & CHARGING_MASK) !== 0 };
  }
  return battery;
}

// ---- Noise control ----------------------------------------------------------

// One wire code covers both the mode and, for noise cancellation, its strength.
const NOISE_CODES = [
  { code: 0x01, mode: 'anc', strength: 'high' },
  { code: 0x02, mode: 'anc', strength: 'mid' },
  { code: 0x03, mode: 'anc', strength: 'low' },
  { code: 0x04, mode: 'anc', strength: 'adaptive' },
  { code: 0x05, mode: 'off', strength: null },
  { code: 0x07, mode: 'transparency', strength: null },
];

// Newer firmware reports Transparency as 0xfe and Off as 0x00 instead of the
// codes it accepts on writes (0x07 / 0x05). Accept both spellings everywhere,
// otherwise a Transparency report is silently dropped and the panel keeps
// showing the previous mode.
function noiseEntry(value) {
  const code = value === 0xfe ? 0x07 : value === 0x00 ? 0x05 : value;
  return NOISE_CODES.find((e) => e.code === code) ?? null;
}

// Noise reports are a list of 3-byte entries [type, code, 0]:
//   type 1: the current mode (an ANC code carries its strength)
//   type 2: the ANC strength, remembered even while ANC is off
// in any order, e.g. a GET reply from the CMF Neckband Pro in Transparency is
// [2, 4, 0, 1, 7, 0] (strength Adaptive, mode Transparency) and a push after
// the neckband's button is [1, 7, 0]. Reading only payload[1] would take the
// remembered strength for the mode, so every entry is decoded.
// previous fills in what a report leaves out (a strength-only push).
function decodeNoiseMode(payload, previous = {}) {
  let modeEntry = null;
  let strengthEntry = null;
  for (let at = 0; at + 1 < payload.length; at += 3) {
    const entry = noiseEntry(payload[at + 1]);
    if (payload[at] === 1 && entry) modeEntry = entry;
    else if (payload[at] === 2 && entry?.mode === 'anc') strengthEntry = entry;
  }
  if (!modeEntry && !strengthEntry) {
    // Older firmware without type tags: the code is the second byte.
    const legacy = noiseEntry(payload[1]);
    return legacy ? { mode: legacy.mode, strength: legacy.strength } : null;
  }
  const mode = modeEntry?.mode ?? previous.mode ?? null;
  if (mode !== 'anc') return mode ? { mode, strength: null } : null;
  const strength = strengthEntry?.strength ?? modeEntry?.strength ?? previous.strength ?? 'high';
  return { mode, strength };
}

// Kept for callers and tests that name the Pro variant; the format is shared.
const decodeProNoiseMode = decodeNoiseMode;

// strength only matters for mode "anc"; it defaults to high.
function encodeNoiseMode(mode, strength = 'high') {
  const entry = NOISE_CODES.find(
    (e) => e.mode === mode && (mode !== 'anc' || e.strength === strength)
  );
  if (!entry) throw new Error(`Unknown noise mode: ${mode}/${strength}`);
  return [0x01, entry.code, 0x00];
}

// ---- Bass enhance -----------------------------------------------------------

// payload: [enabled, wireLevel]
// Most models use 5 levels sent as level*2 (2..10). A few use 3 steps sent as
// 0 / 5 / 10, where step 0 means off; here those become off + levels 1..2.
const THREE_STEP_WIRE = [0, 5, 10];

// -> { enabled, level, wire }. level is null if it doesn't fit the model.
function decodeBass(payload, steps) {
  const enabled = payload[0] === 1;
  const wire = payload[1] ?? 0;
  let level;
  if (steps === 3) {
    const index = THREE_STEP_WIRE.indexOf(wire);
    level = index > 0 ? index : null;
  } else {
    level = wire >= 2 && wire <= 10 && wire % 2 === 0 ? wire / 2 : null;
  }
  return { enabled, level, wire };
}

function encodeBass(enabled, level, steps) {
  const wire = steps === 3 ? THREE_STEP_WIRE[enabled ? level : 0] ?? 0 : level * 2;
  return [enabled ? 0x01 : 0x00, wire];
}

// ---- Quick settings ---------------------------------------------------------

// In-ear detection. payload: [?, ?, on]
const decodeInEar = (payload) => payload[2] === 1;
const encodeInEar = (on) => [0x01, 0x01, on ? 0x01 : 0x00];

// Low latency mode. payload: [1 = on, 2 = off]
const decodeLowLatency = (payload) => payload[0] === 1;
const encodeLowLatency = (on) => [on ? 0x01 : 0x02, 0x00];

// Firmware version as ASCII, e.g. "1.0.3.124".
const decodeFirmware = (payload) => String.fromCharCode(...payload).replace(/\0+$/, '').trim();

// Find my earbuds. Three payload styles depending on the model:
//   'buds':      [0x02 left | 0x03 right, on]
//   'headphone': [0x06, on]       (one sound for the whole device)
//   'single':    [on]             (Nothing ear (1))
function encodeRing(style, side, on) {
  const flag = on ? 0x01 : 0x00;
  if (style === 'single') return [flag];
  if (style === 'headphone') return [0x06, flag];
  return [side === 'left' ? 0x02 : 0x03, flag];
}

// ---- Equalizer --------------------------------------------------------------

// Preset id. payload: [preset, ...]
const decodePreset = (payload) => payload[0] ?? null;
const encodePreset = (id) => [id, 0x00];

// Custom EQ: three filters, gains in dB (−6..+6), floats little-endian.
//   payload: [count, totalGain f32, (type u8, gain f32, freq f32, q f32) × count, 3 zero bytes × count]
// Filter types: 0 low shelf (Bass), 1 peak (Mid), 2 high shelf (Treble).
const FILTER = { LOW_SHELF: 0, PEAK: 1, HIGH_SHELF: 2 };
const BAND_FOR_FILTER = { 0: 'bass', 1: 'mid', 2: 'treble' };
const BAND_BYTES = 13;

function decodeCustomEq(payload) {
  const buf = Uint8Array.from(payload);
  const view = new DataView(buf.buffer);
  const count = buf[0] ?? 0;
  const bands = { bass: 0, mid: 0, treble: 0 };
  for (let i = 0; i < count; i++) {
    const at = 5 + i * BAND_BYTES;
    if (at + 5 > buf.length) break;
    const band = BAND_FOR_FILTER[buf[at]];
    if (band) bands[band] = Math.round(view.getFloat32(at + 1, true));
  }
  return bands;
}

// trebleHz differs per model (3400, 3500 or 6900 Hz).
function encodeCustomEq({ bass, mid, treble }, trebleHz) {
  const bands = [
    { type: FILTER.PEAK, gain: mid, freq: 980, q: 0.7 },
    { type: FILTER.HIGH_SHELF, gain: treble, freq: trebleHz, q: 1.0 },
    { type: FILTER.LOW_SHELF, gain: bass, freq: 140, q: 0.8 },
  ];
  // Overall gain is lowered by the largest boost so the result doesn't clip.
  const totalGain = -Math.max(0, ...bands.map((b) => b.gain));

  const buf = new Uint8Array(1 + 4 + bands.length * BAND_BYTES + bands.length * 3);
  const view = new DataView(buf.buffer);
  let at = 0;
  buf[at++] = bands.length;
  view.setFloat32(at, totalGain, true); at += 4;
  for (const b of bands) {
    buf[at++] = b.type;
    view.setFloat32(at, b.gain, true); at += 4;
    view.setFloat32(at, b.freq, true); at += 4;
    view.setFloat32(at, b.q, true); at += 4;
  }
  return [...buf];
}

// ---- Spatial audio ----------------------------------------------------------

// Each mode is a (mode, head) pair on the wire. `bit` is the flag in a model's
// spatial capability mask that says the mode exists (Off is always available).
const SPATIAL_MODES = [
  { key: 'off', label: 'Off', bit: null, mode: 0, head: 0 },
  { key: 'headTracked', label: 'Head Tracked', bit: 0x01, mode: 1, head: 1 },
  { key: 'fixed', label: 'Fixed', bit: 0x02, mode: 1, head: 0 },
  { key: 'concert', label: 'Concert', bit: 0x08, mode: 2, head: 0 },
  { key: 'theatre', label: 'Theatre', bit: 0x10, mode: 3, head: 0 },
  { key: 'game', label: 'Game', bit: 0x20, mode: 4, head: 0 },
];

// Modes a model supports, from its capability mask. [] = no spatial audio.
function spatialModesForMask(mask) {
  if (!mask) return [];
  return SPATIAL_MODES.filter((m) => m.bit === null || (mask & m.bit)).map(({ key, label }) => ({ key, label }));
}

// payload: [mode, head] -> mode key
function decodeSpatialAudio(payload) {
  const mode = payload[0] ?? 0;
  const head = payload[1] ?? 0;
  if (head === 1) return 'headTracked';
  return SPATIAL_MODES.find((m) => m.head === 0 && m.mode === mode)?.key ?? 'off';
}

function encodeSpatialAudio(key) {
  const entry = SPATIAL_MODES.find((m) => m.key === key) ?? SPATIAL_MODES[0];
  return [entry.mode, entry.head];
}

// ---- Dual connection --------------------------------------------------------

// MAC addresses are shown and compared as "AA-BB-CC-DD-EE-FF".
const macFromBytes = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('-');
const macToBytes = (mac) => mac.split(/[-:]/).map((h) => parseInt(h, 16));

const decodeDualEnable = (payload) => payload[0] === 1;
const encodeDualEnable = (on) => [on ? 0x01 : 0x00];

// Remembered devices, one page per request.
//   payload: [?, ?, count, (flags, mac×6, nameLength, name…) × count]
//   flags: high nibble set = this device (the Mac), low nibble set = connected
function decodeDualList(payload) {
  const devices = [];
  const count = payload[2] ?? 0;
  let at = 3;
  for (let i = 0; i < count && at + 8 <= payload.length; i++) {
    const flags = payload[at];
    const nameLength = payload[at + 7] & 0x7f;
    devices.push({
      mac: macFromBytes(payload.slice(at + 1, at + 7)),
      name: new TextDecoder().decode(Uint8Array.from(payload.slice(at + 8, at + 8 + nameLength))),
      isSelf: (flags & 0xf0) !== 0,
      isConnected: (flags & 0x0f) !== 0,
    });
    at += 8 + nameLength;
  }
  return devices;
}
// Request the page starting at device index `start`.
const encodeDualListRequest = (start) => [start & 0xff];

// payload: [connected, mac×6]
const decodeDualDeviceEvent = (payload) => ({
  isConnected: payload[0] === 1,
  mac: macFromBytes(payload.slice(1, 7)),
});
const encodeDualConnect = (mac, connect) => [connect ? 0x01 : 0x00, ...macToBytes(mac)];

// ---- Personal Sound Profile -------------------------------------------------

// Same shape for both backends. payload: [on]
const decodePersonalSound = (payload) => payload[0] === 1;
const encodePersonalSound = (on) => [on ? 0x01 : 0x00];

// ---- Gestures ---------------------------------------------------------------

// payload: [count, (device, button, gestureType, action) × count]
function decodeGestures(payload) {
  const records = [];
  const count = payload[0] ?? 0;
  for (let i = 0; i < count; i++) {
    const at = 1 + i * 4;
    if (at + 3 >= payload.length) break;
    records.push({ device: payload[at], button: payload[at + 1], type: payload[at + 2], action: payload[at + 3] });
  }
  return records;
}

// One gesture: [1, device, button, gestureType, action]
const encodeGesture = (device, type, action, button = 0x01) => [0x01, device, button, type, action];

export {
  decodeGestures,
  encodeGesture,
  decodePersonalSound,
  encodePersonalSound,
  decodeDualEnable,
  encodeDualEnable,
  decodeDualList,
  encodeDualListRequest,
  decodeDualDeviceEvent,
  encodeDualConnect,
  spatialModesForMask,
  decodeSpatialAudio,
  encodeSpatialAudio,
  Command,
  Response,
  decodePreset,
  encodePreset,
  decodeCustomEq,
  encodeCustomEq,
  decodeBattery,
  decodeNoiseMode,
  decodeProNoiseMode,
  encodeNoiseMode,
  decodeBass,
  encodeBass,
  decodeInEar,
  encodeInEar,
  decodeLowLatency,
  encodeLowLatency,
  decodeFirmware,
  encodeRing,
};
