// Tracks which phone is which player and forwards their input to the DSU server.

import { EventEmitter } from 'node:events';
import { MAX_SLOTS } from './dsu-server.js';

// Binary input packet sent by the phone (little-endian):
//   u16 buttons, u16 sequence,
//   f32 accel x/y/z (g), f32 gyro x/y/z (deg/s)
// Vectors are already in the Wii Remote's frame: +X left, +Y toward the
// expansion port, +Z out of the button face (Dolphin's convention).
export const INPUT_PACKET_BYTES = 28;

// A disconnected phone gets its old player number back if it returns within this window.
const RECLAIM_MS = 2 * 60 * 1000;

export class ControllerHub extends EventEmitter {
  constructor(dsu) {
    super();
    this.dsu = dsu;
    /** @type {(null | {id: string, name: string, ws: import('ws').WebSocket, tilt: number, packets: number})[]} */
    this.players = Array(MAX_SLOTS).fill(null);
    /** phone id -> { slot, at } for recently disconnected phones */
    this.recent = new Map();
  }

  /** Called for every new WebSocket from a phone. */
  attach(ws, remoteAddress) {
    let slot = -1;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (slot >= 0) this.#onInput(slot, data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.t === 'hello' && slot < 0) {
        slot = this.#join(ws, String(msg.id || remoteAddress).slice(0, 64), String(msg.name || '').slice(0, 20));
      }
    });

    ws.on('close', () => {
      if (slot < 0 || this.players[slot]?.ws !== ws) return;
      const p = this.players[slot];
      this.recent.set(p.id, { slot, at: Date.now() });
      this.players[slot] = null;
      this.dsu.setConnected(slot, false);
      this.emit('change');
    });
  }

  #join(ws, id, name) {
    // Same phone reconnecting while its old socket is still open: replace it.
    let slot = this.players.findIndex((p) => p?.id === id);
    if (slot >= 0) {
      this.players[slot].ws.close(4000, 'replaced');
    } else {
      const prev = this.recent.get(id);
      if (prev && Date.now() - prev.at < RECLAIM_MS && !this.players[prev.slot]) slot = prev.slot;
      else slot = this.#freeSlot();
    }
    if (slot < 0) {
      ws.send(JSON.stringify({ t: 'full' }));
      ws.close(4001, 'full');
      return -1;
    }
    this.recent.delete(id);
    this.players[slot] = { id, name: name || `Player ${slot + 1}`, ws, tilt: 0, packets: 0 };
    this.dsu.setConnected(slot, true);
    ws.send(JSON.stringify({ t: 'welcome', slot, player: slot + 1, name: this.players[slot].name }));
    this.emit('change');
    return slot;
  }

  #freeSlot() {
    // Prefer slots that no recently-disconnected phone is waiting to reclaim.
    const reserved = new Set();
    const now = Date.now();
    for (const [id, r] of this.recent) {
      if (now - r.at > RECLAIM_MS) this.recent.delete(id);
      else reserved.add(r.slot);
    }
    const free = [...this.players.keys()].filter((i) => !this.players[i]);
    return free.find((i) => !reserved.has(i)) ?? free[0] ?? -1;
  }

  #onInput(slot, data) {
    if (data.length < INPUT_PACKET_BYTES) return;
    const buttons = data.readUInt16LE(0);
    const wx = data.readFloatLE(4);
    const wy = data.readFloatLE(8);
    const wz = data.readFloatLE(12);
    const gx = data.readFloatLE(16);
    const gy = data.readFloatLE(20);
    const gz = data.readFloatLE(24);
    if (![wx, wy, wz, gx, gy, gz].every(Number.isFinite)) return;

    // Dolphin's Wii Remote profile (see dolphin.js) binds the DSU axes so that
    //   DSU accel (x, y, z)        = Wii Remote accel (x, z, y)
    //   DSU gyro (pitch, yaw, roll) = Wii Remote gyro (x, z, y)
    this.dsu.update(slot, buttons, [wx, wz, wy], [gx, gz, gy]);

    const p = this.players[slot];
    p.packets++;
    // Wheel angle for the dashboard (positive = steering right). Held like a
    // wheel, "up" reads as -X; turning right swings it toward -Y.
    p.tilt = Math.atan2(-wy, -wx) * (180 / Math.PI);
    p.buttons = buttons;
  }

  /** Snapshot for the dashboard. */
  summary() {
    return this.players.map((p, slot) =>
      p ? { slot, player: slot + 1, name: p.name, tilt: Math.round(p.tilt), buttons: p.buttons ?? 0 } : null,
    );
  }
}
