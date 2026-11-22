// Bluetooth byte transport for the earbud core, backed by the app shell.
//
// The shell (src-tauri) runs the native Bluetooth helper and keeps it alive;
// this class only relays bytes. Events: 'connected' ({ name, address }),
// 'data' (Uint8Array), 'disconnected'.

import { Emitter } from '../core/emitter.js';

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

class BluetoothBridge extends Emitter {
  #invoke;
  #listen;
  #connected = false;
  #started = false;

  constructor({ invoke, listen }) {
    super();
    this.#invoke = invoke;
    this.#listen = listen;
  }

  async start() {
    if (this.#started) return;
    this.#started = true;
    let connectionEvents = 0;
    await this.#listen('bridge:message', (event) => {
      if (event.payload?.type === 'connected' || event.payload?.type === 'disconnected') {
        connectionEvents++;
      }
      this.#onMessage(event.payload);
    });
    // The earbuds may have connected before this page loaded.
    const snapshotVersion = connectionEvents;
    const connection = await this.#invoke('bridge_connection');
    // Don't apply a potentially stale snapshot after a connection event.
    if (connection && connectionEvents === snapshotVersion) {
      this.#onMessage({ type: 'connected', ...connection });
    }
  }

  // The shell owns the helper process and closes it cleanly on quit.
  stop() {}

  write(bytes) {
    this.#invoke('bridge_write', { hex: toHex(bytes) });
  }

  #onMessage(msg) {
    switch (msg?.type) {
      case 'connected':
        if (this.#connected) return;
        this.#connected = true;
        this.emit('connected', { name: msg.name, address: msg.address, modelId: msg.modelId });
        break;
      case 'data':
        this.emit('data', fromHex(msg.hex));
        break;
      case 'disconnected':
        this.#connected = false;
        this.emit('disconnected');
        break;
      default:
        break;
    }
  }
}

export { BluetoothBridge };
