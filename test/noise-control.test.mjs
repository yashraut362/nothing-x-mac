import test from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../web/core/emitter.js';
import { NothingDevice } from '../web/core/nothing-device.js';
import { encodeFrame, FrameParser } from '../web/core/protocol.js';
import { Command } from '../web/core/commands.js';

function fixture(t, name = 'CMF Neckband Pro') {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const bridge = new Emitter();
  const writes = [];
  bridge.write = (bytes) => writes.push(new FrameParser().push(bytes)[0]);
  const device = new NothingDevice(bridge);
  bridge.emit('connected', { name, address: 'A' });
  t.after(() => bridge.emit('disconnected'));
  const report = (command, payload) => bridge.emit('data', encodeFrame(command, payload));
  return { device, report, writes, state: () => device.getState() };
}

// Real frames captured from a CMF Neckband Pro: GET replies carry
// [2, strength, 0, 1, mode, 0]; the button push carries [1, mode, 0].
const NECKBAND = {
  transparency: [2, 4, 0, 1, 7, 0],
  off: [2, 4, 0, 1, 5, 0],
  ancHigh: [2, 1, 0, 1, 1, 0],
};

test('CMF Neckband Pro replies decode the mode, not the remembered strength', (t) => {
  const f = fixture(t);
  f.report(0x401e, NECKBAND.transparency);
  assert.deepEqual([f.state().noiseMode, f.state().ancStrength], ['transparency', null]);
  f.report(0x401e, NECKBAND.off);
  assert.equal(f.state().noiseMode, 'off');
  f.report(0x401e, NECKBAND.ancHigh);
  assert.deepEqual([f.state().noiseMode, f.state().ancStrength], ['anc', 'high']);
  f.report(0xe003, [1, 7, 0]); // neckband button
  assert.equal(f.state().noiseMode, 'transparency');
  f.report(0xe003, [1, 0xfe, 0]); // newer spelling of transparency
  f.report(0x401e, [3, 2]); // untagged legacy reply: code in the second byte
  assert.deepEqual([f.state().noiseMode, f.state().ancStrength], ['anc', 'mid']);
});

test('transparency is confirmed by the first read-back, so the controls unlock fast', (t) => {
  const f = fixture(t);
  f.report(0x401e, NECKBAND.ancHigh);
  assert.equal(f.device.setNoiseMode('transparency'), true);
  t.mock.timers.tick(150);
  assert.equal(f.writes.at(-1).command, Command.GET_NOISE_MODE);
  f.report(0x401e, NECKBAND.transparency);
  assert.equal(f.state().noiseMode, 'transparency');
  assert.equal(f.state().noisePending, false);
  assert.equal(f.device.setNoiseMode('anc'), true); // ANC button works again
});

test('switching to transparency unlocks as soon as the earbuds confirm it', (t) => {
  const f = fixture(t);
  f.report(0x401e, [1, 0x01, 0]);
  assert.equal(f.device.setNoiseMode('transparency'), true);
  assert.equal(f.state().noisePending, true);
  assert.equal(f.device.setNoiseMode('off'), false); // still in flight
  f.report(0x401e, NECKBAND.transparency);
  assert.equal(f.state().noiseMode, 'transparency');
  assert.equal(f.state().noisePending, false);
  assert.equal(f.device.setNoiseMode('off'), true);
});

test('an unconfirmed switch falls back to the mode the earbuds last reported', (t) => {
  const f = fixture(t);
  f.report(0x401e, [1, 0x01, 0]);
  f.device.setNoiseMode('transparency');
  assert.equal(f.state().noiseMode, 'transparency'); // optimistic
  f.report(0x401e, [1, 0x01, 0]); // still ANC: not a confirmation
  t.mock.timers.tick(4000);
  assert.equal(f.state().noisePending, false);
  assert.deepEqual([f.state().noiseMode, f.state().ancStrength], ['anc', 'high']);
});

test('opening the panel re-reads the noise mode on every model', (t) => {
  const f = fixture(t);
  t.mock.timers.tick(3000);
  f.writes.length = 0;
  f.device.refreshPanel();
  const commands = f.writes.map((w) => w.command);
  assert.ok(commands.includes(Command.GET_NOISE_MODE));
  assert.ok(commands.includes(Command.GET_BASS));
  // A change from the neckband's own button is picked up on open.
  f.report(0x401e, [1, 0x07, 0]);
  assert.equal(f.state().noiseMode, 'transparency');
});
