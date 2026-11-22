import test from 'node:test';
import assert from 'node:assert/strict';
import { BluetoothBridge } from '../web/platform/bluetooth-bridge.js';

function fixture() {
  let listener;
  let resolveConnection;
  let snapshotRequested;
  const requested = new Promise((resolve) => { snapshotRequested = resolve; });
  const bridge = new BluetoothBridge({
    listen: async (_name, callback) => { listener = callback; },
    invoke: () => {
      snapshotRequested();
      return new Promise((resolve) => { resolveConnection = resolve; });
    },
  });
  const events = [];
  bridge.on('connected', (device) => events.push(['connected', device.name]));
  bridge.on('disconnected', () => events.push(['disconnected']));
  return {
    bridge,
    events,
    requested,
    emit: (payload) => listener({ payload }),
    resolve: (connection) => resolveConnection(connection),
  };
}

test('startup restores a connection already known to the shell', async () => {
  const f = fixture();
  const started = f.bridge.start();
  await f.requested;
  f.emit({ type: 'data', hex: '00' });
  f.resolve({ name: 'Earbuds', address: 'A' });
  await started;
  assert.deepEqual(f.events, [['connected', 'Earbuds']]);
});

test('a live connection during startup is not emitted twice', async () => {
  const f = fixture();
  const started = f.bridge.start();
  await f.requested;
  f.emit({ type: 'connected', name: 'Earbuds', address: 'A' });
  f.resolve({ name: 'Earbuds', address: 'A' });
  await started;
  assert.deepEqual(f.events, [['connected', 'Earbuds']]);
});

test('a disconnect while reading the startup snapshot is not undone by a stale connection', async () => {
  const f = fixture();
  const started = f.bridge.start();
  await f.requested;
  f.emit({ type: 'disconnected' });
  f.resolve({ name: 'Old earbuds', address: 'A' });
  await started;
  f.emit({ type: 'connected', name: 'New earbuds', address: 'B' });
  assert.deepEqual(f.events, [['disconnected'], ['connected', 'New earbuds']]);
});

test('a stale snapshot does not replace a newer connection', async () => {
  const f = fixture();
  const started = f.bridge.start();
  await f.requested;
  f.emit({ type: 'connected', name: 'New earbuds', address: 'B' });
  f.emit({ type: 'disconnected' });
  f.resolve({ name: 'Old earbuds', address: 'A' });
  await started;
  assert.deepEqual(f.events, [['connected', 'New earbuds'], ['disconnected']]);
});
