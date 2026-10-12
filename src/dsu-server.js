// DSU ("cemuhook") UDP server.
//
// Dolphin ships a built-in DSU client (Controllers > Alternate Input Sources).
// It polls a server for up to 4 pads and reads buttons, sticks, accelerometer
// and gyroscope from each one. Acting as that server lets phones drive
// emulated Wii Remotes on Windows, macOS and Linux with no drivers.
//
// Protocol reference: https://v1993.github.io/cemuhook-protocol/

import dgram from 'node:dgram';
import { randomInt } from 'node:crypto';

export const DSU_PORT = 26760;
export const MAX_SLOTS = 4;

const PROTOCOL_VERSION = 1001;
const MSG_VERSION = 0x100000;
const MSG_PORT_INFO = 0x100001;
const MSG_PAD_DATA = 0x100002;

// Dolphin re-requests data every second; stop streaming after a few silent seconds.
const CLIENT_TIMEOUT_MS = 5000;
// Resend the latest state this often even when the phone is quiet.
const KEEPALIVE_MS = 50;

// Wii Remote button bits as sent by the phone (see public/phone/controller.js).
export const WII = {
  A: 1 << 0,
  B: 1 << 1,
  ONE: 1 << 2,
  TWO: 1 << 3,
  MINUS: 1 << 4,
  PLUS: 1 << 5,
  HOME: 1 << 6,
  UP: 1 << 7,
  DOWN: 1 << 8,
  LEFT: 1 << 9,
  RIGHT: 1 << 10,
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function finishPacket(buf, magic, id) {
  buf.write(magic, 0, 'ascii');
  buf.writeUInt16LE(PROTOCOL_VERSION, 4);
  buf.writeUInt16LE(buf.length - 16, 6);
  buf.writeUInt32LE(0, 8);
  buf.writeUInt32LE(id, 12);
  buf.writeUInt32LE(crc32(buf), 8);
  return buf;
}

/** Writes the 11-byte slot description shared by info and data packets. */
function writeSlotHeader(buf, offset, slot, connected) {
  buf.writeUInt8(slot, offset);
  buf.writeUInt8(connected ? 2 : 0, offset + 1); // state: 0 disconnected, 2 connected
  buf.writeUInt8(connected ? 2 : 0, offset + 2); // model: 2 = full gyro
  buf.writeUInt8(connected ? 1 : 0, offset + 3); // connection: 1 = USB
  // MAC address: 6 bytes, unique per slot so clients can tell pads apart.
  buf.fill(0, offset + 4, offset + 10);
  if (connected) buf.writeUInt8(slot + 1, offset + 9);
  buf.writeUInt8(connected ? 0x05 : 0, offset + 10); // battery: full
}

export function buildVersionPacket(serverId) {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(MSG_VERSION, 16);
  buf.writeUInt16LE(PROTOCOL_VERSION, 20);
  return finishPacket(buf, 'DSUS', serverId);
}

export function buildInfoPacket(serverId, slot, connected) {
  const buf = Buffer.alloc(32);
  buf.writeUInt32LE(MSG_PORT_INFO, 16);
  writeSlotHeader(buf, 20, slot, connected);
  return finishPacket(buf, 'DSUS', serverId);
}

/**
 * @param {number} serverId
 * @param {number} slot
 * @param {number} packetNumber
 * @param {{buttons: number, accel: number[], gyro: number[]}} state
 *   accel in g and gyro in deg/s, already laid out for DSU (see mapping in README).
 */
export function buildDataPacket(serverId, slot, packetNumber, state) {
  const buf = Buffer.alloc(100);
  buf.writeUInt32LE(MSG_PAD_DATA, 16);
  writeSlotHeader(buf, 20, slot, true);
  buf.writeUInt8(1, 31);
  buf.writeUInt32LE(packetNumber >>> 0, 32);

  const b = state.buttons;
  const has = (bit) => (b & bit) !== 0;
  let buttons1 = 0;
  if (has(WII.LEFT)) buttons1 |= 0x80;
  if (has(WII.DOWN)) buttons1 |= 0x40;
  if (has(WII.RIGHT)) buttons1 |= 0x20;
  if (has(WII.UP)) buttons1 |= 0x10;
  if (has(WII.PLUS)) buttons1 |= 0x08; // Options
  if (has(WII.MINUS)) buttons1 |= 0x01; // Share
  let buttons2 = 0;
  if (has(WII.ONE)) buttons2 |= 0x80; // Square
  if (has(WII.B)) buttons2 |= 0x40; // Cross
  if (has(WII.A)) buttons2 |= 0x20; // Circle
  if (has(WII.TWO)) buttons2 |= 0x10; // Triangle
  buf.writeUInt8(buttons1, 36);
  buf.writeUInt8(buttons2, 37);
  buf.writeUInt8(has(WII.HOME) ? 1 : 0, 38); // PS
  buf.writeUInt8(0, 39); // touch button
  buf.fill(128, 40, 44); // sticks centred

  // Dolphin reads the D-pad and face buttons from these analog bytes.
  const analog = [WII.LEFT, WII.DOWN, WII.RIGHT, WII.UP, WII.ONE, WII.B, WII.A, WII.TWO];
  analog.forEach((bit, i) => buf.writeUInt8(has(bit) ? 255 : 0, 44 + i));

  buf.writeBigUInt64LE(process.hrtime.bigint() / 1000n, 68);
  const [ax, ay, az] = state.accel;
  const [pitch, yaw, roll] = state.gyro;
  buf.writeFloatLE(ax, 76);
  buf.writeFloatLE(ay, 80);
  buf.writeFloatLE(az, 84);
  buf.writeFloatLE(pitch, 88);
  buf.writeFloatLE(yaw, 92);
  buf.writeFloatLE(roll, 96);
  return finishPacket(buf, 'DSUS', serverId);
}

export class DsuServer {
  constructor({ port = DSU_PORT, host = '127.0.0.1', log = () => {} } = {}) {
    this.port = port;
    this.host = host;
    this.log = log;
    this.serverId = randomInt(0, 0xffffffff);
    /** @type {(null | {buttons: number, accel: number[], gyro: number[], packet: number})[]} */
    this.slots = Array(MAX_SLOTS).fill(null);
    /** client key -> { address, port, lastSeen, slots: Set<number> | 'all' } */
    this.clients = new Map();
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (msg, rinfo) => this.#onMessage(msg, rinfo));
  }

  start() {
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(this.port, this.host, () => {
        this.socket.off('error', reject);
        this.socket.on('error', (err) => this.log('DSU socket error', err));
        this.timer = setInterval(() => this.#broadcastAll(), KEEPALIVE_MS);
        resolve();
      });
    });
  }

  stop() {
    clearInterval(this.timer);
    this.socket.close();
  }

  setConnected(slot, connected) {
    // Until the phone reports motion, pretend the remote is lying face up (1g along Wii Remote +Z).
    this.slots[slot] = connected ? { buttons: 0, accel: [0, 1, 0], gyro: [0, 0, 0], packet: 0 } : null;
  }

  update(slot, buttons, accel, gyro) {
    const s = this.slots[slot];
    if (!s) return;
    s.buttons = buttons;
    s.accel = accel;
    s.gyro = gyro;
    this.#broadcastSlot(slot);
  }

  hasClients() {
    this.#pruneClients();
    return this.clients.size > 0;
  }

  #pruneClients() {
    const now = Date.now();
    for (const [key, c] of this.clients) if (now - c.lastSeen > CLIENT_TIMEOUT_MS) this.clients.delete(key);
  }

  #broadcastAll() {
    this.#pruneClients();
    for (let slot = 0; slot < MAX_SLOTS; slot++) this.#broadcastSlot(slot);
  }

  #broadcastSlot(slot) {
    const s = this.slots[slot];
    if (!s || this.clients.size === 0) return;
    const packet = buildDataPacket(this.serverId, slot, s.packet++, s);
    for (const c of this.clients.values()) {
      if (c.slots === 'all' || c.slots.has(slot)) this.socket.send(packet, c.port, c.address);
    }
  }

  #onMessage(msg, rinfo) {
    if (msg.length < 20 || msg.toString('ascii', 0, 4) !== 'DSUC') return;
    const type = msg.readUInt32LE(16);
    const reply = (buf) => this.socket.send(buf, rinfo.port, rinfo.address);

    if (type === MSG_VERSION) {
      reply(buildVersionPacket(this.serverId));
    } else if (type === MSG_PORT_INFO && msg.length >= 24) {
      const count = Math.min(msg.readInt32LE(20), MAX_SLOTS, msg.length - 24);
      for (let i = 0; i < count; i++) {
        const slot = msg.readUInt8(24 + i);
        if (slot < MAX_SLOTS) reply(buildInfoPacket(this.serverId, slot, this.slots[slot] !== null));
      }
    } else if (type === MSG_PAD_DATA && msg.length >= 22) {
      const flags = msg.readUInt8(20);
      const slot = msg.readUInt8(21);
      const key = `${rinfo.address}:${rinfo.port}`;
      let client = this.clients.get(key);
      if (!client) {
        client = { address: rinfo.address, port: rinfo.port, slots: new Set() };
        this.clients.set(key, client);
        this.log(`Dolphin connected to controller server (${key})`);
      }
      client.lastSeen = Date.now();
      // flags: 0 = all pads, bit 0 = by slot, bit 1 = by MAC (we treat MAC requests as "all").
      if (flags === 0 || (flags & 2) !== 0) client.slots = 'all';
      else if (client.slots !== 'all') client.slots.add(slot);
    }
  }
}
