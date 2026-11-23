// Popover view: renders device state from the earbud core (see platform/nx.js).

import { nx } from '../platform/nx.js';

const LOW_BATTERY = 20;
// Created once the symbols arrive from the app shell.
let strengthControl = null;
let bassControl = null;
let quickSettings = null;
let spatialAudio = null;
let dualConnection = null;
let controls = null;
let equalizer = null;

// One switch at a time across mode buttons and intensity segments.
const switchLock = window.createSwitchLock({
  onToggle: (locked) => document.getElementById('noise-section').classList.toggle('busy', locked),
});

const $ = (sel) => document.querySelector(sel);

function applySymbols(symbols) {
  for (const el of document.querySelectorAll('[data-sym]')) {
    const url = symbols[el.dataset.sym];
    if (url) el.style.setProperty('--sym', `url("${url}")`);
  }
}

function renderHeader(state) {
  $('#panel').classList.toggle('disconnected', !state.connected);
  $('#device-name').textContent = state.connected ? state.name : 'No device';
  $('#device-status').textContent = state.connected ? 'Connected' : 'Not connected';
}

function renderBattery(battery, caps) {
  const single = Boolean(battery.stereo) || (caps.ring === 'headphone' && !battery.left && !battery.right && !battery.case);
  for (const part of ['stereo', 'left', 'right', 'case']) {
    const el = $(`.bud[data-part="${part}"]`);
    const info = battery[part];
    // No case data (e.g. case closed or out of range): drop the column so the
    // buds sit centred. Missing buds stay visible but dimmed.
    el.hidden = part === 'stereo' ? !single : single || (part === 'case' && !info);
    el.classList.toggle('unavailable', !info);
    el.classList.toggle('charging', Boolean(info?.charging));
    el.querySelector('.pct').setAttribute('aria-label', info ? `${info.level}%${info.charging ? ', charging' : ''}` : 'Unavailable');
    el.classList.toggle('low', Boolean(info && !info.charging && info.level <= LOW_BATTERY));
    el.querySelector('.pct').textContent = info ? `${info.level}%` : '—';
    el.querySelector('.fill').style.width = info ? `${info.level}%` : '0';
  }
}

const COLOR_NAMES = { orange: 'Orange', white: 'White', black: 'Black' };

// Single-battery devices: a neckband gets its own glyph in its real colour;
// everything else keeps the headphones symbol.
function renderStereoIcon(caps) {
  const bud = $('.bud[data-part="stereo"]');
  const neckband = caps.form === 'neckband';
  bud.querySelector('.sym.bud-icon').hidden = neckband;
  const icon = bud.querySelector('.neckband-icon');
  // An <svg> has no .hidden property; toggle the attribute itself.
  icon.toggleAttribute('hidden', !neckband);
  if (caps.color) icon.dataset.color = caps.color;
  else delete icon.dataset.color;
  bud.querySelector('.bud-label').textContent = neckband ? 'Neckband' : 'Headphones';
  bud.title = neckband && caps.color ? `Neckband · ${COLOR_NAMES[caps.color]}` : '';
}

function renderNoiseMode(mode) {
  for (const btn of document.querySelectorAll('.option')) {
    btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
  }
}

function renderCapabilities(capabilities) {
  $('.option[data-mode="transparency"]').hidden = !capabilities.transparency;
}

function render(state) {
  renderHeader(state);
  renderBattery(state.battery, state.capabilities);
  renderStereoIcon(state.capabilities);
  const locked = state.capabilities.pro && state.flatEq !== false;
  $('.option[data-mode="transparency"]').disabled = Boolean(locked);
  const flatStatus = $('#flat-eq-status');
  flatStatus.hidden = !locked;
  flatStatus.textContent = state.flatEq ? 'Flat EQ is on. Use the left earcup switch to restore Transparency, EQ and Spatial Audio.' : 'Reading the Flat EQ switch…';
  renderCapabilities(state.capabilities);
  switchLock.sync(state.noisePending);
  renderNoiseMode(state.noiseMode);
  strengthControl.render(state);
  bassControl.render(state);
  quickSettings.render(state);
  spatialAudio.render(state);
  dualConnection.render(state);
  controls.render(state);
  equalizer.render(state);
}

// Per-platform touches the stylesheet can't do on its own. The Windows look
// (styles.windows.css) keys off data-platform.
// The app's own version, next to the firmware version in Quick Settings.
function renderAppVersion(appVersion) {
  $('#qs-app-version').textContent = `App version ${appVersion}`;
  $('#qs-check-updates').addEventListener('click', () => nx.openReleases());
}

function applyPlatform(platform, appName) {
  document.documentElement.dataset.platform = platform;
  document.title = appName;
  for (const attr of ['title', 'aria-label']) $('#quit').setAttribute(attr, `Quit ${appName}`);

  // Windows flyouts keep their buttons in a bar along the bottom.
  if (platform === 'windows') $('#view-main footer').append($('.header-actions'));
}

async function main() {
  const { accent, symbols, device, platform, appName, appVersion } = await nx.init();
  applyPlatform(platform, appName);
  renderAppVersion(appVersion);
  document.documentElement.style.setProperty('--accent', accent);
  nx.onAccent((c) => document.documentElement.style.setProperty('--accent', c));
  applySymbols(symbols);

  strengthControl = window.createStrengthControl({
    symbols,
    lock: switchLock,
    onChange: (strength) => nx.setAncStrength(strength),
  });
  bassControl = window.createBassControl({
    symbols,
    onChange: (change) => nx.setBass(change),
  });
  const views = window.createViews({ mainId: 'view-main' });
  quickSettings = window.createQuickSettings({ api: nx, views });
  spatialAudio = window.createSpatialAudioTile({ api: nx, views });
  dualConnection = window.createDualConnectionTile({ api: nx, symbols });
  controls = window.createControls({ api: nx, views, symbols });
  equalizer = window.createEqualizer({ api: nx, views, symbols });

  render(device);
  nx.onDeviceState(render);

  $('#noise-options').addEventListener('click', (e) => {
    const btn = e.target.closest('.option');
    if (!btn || switchLock.locked || btn.getAttribute('aria-checked') === 'true') return;
    switchLock.lock(); // no more changes until the buds confirm this one
    renderNoiseMode(btn.dataset.mode);
    nx.setNoiseMode(btn.dataset.mode);
  });

  $('#quit').addEventListener('click', () => nx.quit());
  $('#made-by-link').addEventListener('click', () => nx.openAuthor());

  // Keep the window sized to the content as states change.
  const panel = $('#panel');
  new ResizeObserver(() => nx.setHeight(panel.getBoundingClientRect().height)).observe(panel);
}

main();
