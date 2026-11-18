const { nativeImage } = require('electron');

// SF Symbols used by the popover. Loaded from macOS so they match the system exactly.
const POPOVER_SYMBOLS = {
  budLeft: 'airpodpro.left',
  budRight: 'airpodpro.right',
  case: 'earbuds.case.fill',
  headphones: 'headphones',
  anc: 'person.wave.2.fill',
  transparency: 'ear.and.waveform',
  off: 'person.fill',
  settings: 'gearshape',
  power: 'power',
  ancLow: 'dial.low',
  ancMid: 'dial.medium',
  ancHigh: 'dial.high',
  ancAdaptive: 'sparkles',
  bassToggle: 'hifispeaker.fill',
  bassWave: 'waveform',
  back: 'chevron.left',
  qsInEar: 'ear',
  qsLatency: 'bolt.fill',
  qsFind: 'speaker.wave.2.fill',
  qsSpatial: 'person.spatialaudio.fill',
  heart: 'heart.fill',
  qsPersonalSound: 'waveform.and.person.filled',
  qsDual: 'macbook.and.iphone',
  popUpChevrons: 'chevron.up.chevron.down',
  // Dual connection device rows (guessed from the device name)
  dev_laptop: 'laptopcomputer',
  dev_phone: 'iphone',
  dev_tablet: 'ipad',
  dev_desktop: 'desktopcomputer',
  dev_tv: 'tv',
  dev_watch: 'applewatch',
  dev_other: 'antenna.radiowaves.left.and.right',
  equalizer: 'slider.vertical.3',
  // Equalizer preset tiles (keys match eq-presets.js)
  eq_balanced: 'equal.circle',
  eq_moreBass: 'speaker.wave.3.fill',
  eq_moreTreble: 'waveform.path.ecg',
  eq_voice: 'person.wave.2',
  eq_dirac: 'sparkles',
  eq_pop: 'music.note',
  eq_rock: 'guitars.fill',
  eq_classical: 'pianokeys',
  eq_electronic: 'waveform.path',
  eq_vocals: 'music.mic',
  eq_custom: 'slider.horizontal.3',
};

function loadSymbol(name) {
  const img = nativeImage.createFromNamedImage(name);
  return img.isEmpty() ? null : img;
}

// Data URLs the renderer uses as CSS masks, so glyphs pick up theme colours.
function popoverSymbolDataUrls() {
  const out = {};
  for (const [key, name] of Object.entries(POPOVER_SYMBOLS)) {
    const img = loadSymbol(name);
    out[key] = img ? img.toDataURL() : null;
  }
  return out;
}

// Menu bar icon: the SF "earbuds" glyph as a crisp 1x/2x template image.
function trayIcon() {
  const src = loadSymbol('earbuds');
  if (!src) return nativeImage.createEmpty();
  const height = 15; // points
  const icon = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const rep = src.resize({ height: height * scaleFactor, quality: 'best' });
    icon.addRepresentation({ scaleFactor, buffer: rep.toPNG() });
  }
  icon.setTemplateImage(true);
  return icon;
}

module.exports = { popoverSymbolDataUrls, trayIcon };
