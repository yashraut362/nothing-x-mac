// Popover view: renders device state pushed from the main process.

const LOW_BATTERY = 20;
// Created once SF Symbols arrive from main.
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
  $('#device-name').textContent = state.connected ? state.name : 'No Earbuds';
  $('#device-status').textContent = state.connected ? 'Connected' : 'Not connected';
}

function renderBattery(battery) {
  // Headphones report one battery ('stereo') instead of left/right/case.
  const single = Boolean(battery.stereo);
  for (const part of ['left', 'right', 'stereo', 'case']) {
    const el = $(`.bud[data-part="${part}"]`);
    const info = battery[part];
    // No case data (e.g. case closed or out of range): drop the column so the
    // buds sit centred. Missing buds stay visible but dimmed.
    if (part === 'case') el.hidden = !info;
    else if (part === 'stereo') el.hidden = !single;
    else el.hidden = single;
    el.classList.toggle('unavailable', !info);
    el.classList.toggle('charging', Boolean(info?.charging));
    el.classList.toggle('low', Boolean(info && !info.charging && info.level <= LOW_BATTERY));
    el.querySelector('.pct').textContent = info ? `${info.level}%` : '—';
    el.querySelector('.fill').style.width = info ? `${info.level}%` : '0';
  }
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
  renderBattery(state.battery);
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

async function main() {
  const { accent, symbols, device } = await window.nx.init();
  document.documentElement.style.setProperty('--accent', accent);
  window.nx.onAccent((c) => document.documentElement.style.setProperty('--accent', c));
  applySymbols(symbols);

  strengthControl = window.createStrengthControl({
    symbols,
    lock: switchLock,
    onChange: (strength) => window.nx.setAncStrength(strength),
  });
  bassControl = window.createBassControl({
    symbols,
    onChange: (change) => window.nx.setBass(change),
  });
  const views = window.createViews({ mainId: 'view-main' });
  quickSettings = window.createQuickSettings({ api: window.nx, views });
  spatialAudio = window.createSpatialAudioTile({ api: window.nx, views });
  dualConnection = window.createDualConnectionTile({ api: window.nx, symbols });
  controls = window.createControls({ api: window.nx, views, symbols });
  equalizer = window.createEqualizer({ api: window.nx, views, symbols });

  render(device);
  window.nx.onDeviceState(render);

  $('#noise-options').addEventListener('click', (e) => {
    const btn = e.target.closest('.option');
    if (!btn || switchLock.locked || btn.getAttribute('aria-checked') === 'true') return;
    switchLock.lock(); // no more changes until the buds confirm this one
    renderNoiseMode(btn.dataset.mode); // optimistic; device state confirms
    window.nx.setNoiseMode(btn.dataset.mode);
  });

  $('#quit').addEventListener('click', () => window.nx.quit());
  $('#made-by-link').addEventListener('click', () => window.nx.openAuthor());

  // Keep the window sized to the content as states change.
  const panel = $('#panel');
  new ResizeObserver(() => window.nx.setHeight(panel.getBoundingClientRect().height)).observe(panel);
}

main();
