import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { DsuServer, WII, crc32 } from '../src/dsu-server.js';
import { ControllerHub } from '../src/controller-hub.js';
import { EventEmitter } from 'node:events';

function request(type, body = Buffer.alloc(0)) {
  const buf = Buffer.alloc(20 + body.length);
  buf.write('DSUC', 0, 'ascii');
  buf.writeUInt16LE(1001, 4);
  buf.writeUInt16LE(buf.length - 16, 6);
  buf.writeUInt32LE(0x1234, 12);
  buf.writeUInt32LE(type, 16);
  body.copy(buf, 20);
  buf.writeUInt32LE(crc32(buf), 8);
  return buf;
}

function verifyCrc(packet) {
  const copy = Buffer.from(packet);
  const crc = copy.readUInt32LE(8);
  copy.writeUInt32LE(0, 8);
  assert.equal(crc32(copy), crc, 'CRC matches');
  assert.equal(packet.toString('ascii', 0, 4), 'DSUS');
  assert.equal(packet.readUInt16LE(6), packet.length - 16, 'length field');
}

async function withServer(fn) {
  const server = new DsuServer({ port: 0 });
  await server.start();
  const port = server.socket.address().port;
  const client = dgram.createSocket('udp4');
  await new Promise((r) => client.bind(0, '127.0.0.1', r));
  const inbox = [];
  const waiters = [];
  client.on('message', (msg) => {
    const w = waiters.findIndex((x) => x.match(msg));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const send = (buf) => client.send(buf, port, '127.0.0.1');
  const next = (match = () => true) => {
    const i = inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve) => waiters.push({ match, resolve }));
  };
  try {
    await fn({ server, send, next });
  } finally {
    client.close();
    server.stop();
  }
}

const ofType = (type) => (msg) => msg.readUInt32LE(16) === type;

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('answers version and port info requests', async () => {
  await withServer(async ({ server, send, next }) => {
    send(request(0x100000));
    const version = await next(ofType(0x100000));
    verifyCrc(version);
    assert.equal(version.readUInt16LE(20), 1001);

    server.setConnected(1, true);
    send(request(0x100001, Buffer.from([2, 0, 0, 0, 0, 1])));
    const a = await next(ofType(0x100001));
    const b = await next(ofType(0x100001));
    const bySlot = Object.fromEntries([a, b].map((p) => [p.readUInt8(20), p]));
    verifyCrc(bySlot[0]);
    assert.equal(bySlot[0].length, 32);
    assert.equal(bySlot[0].readUInt8(21), 0, 'slot 0 disconnected');
    assert.equal(bySlot[1].readUInt8(21), 2, 'slot 1 connected');
    assert.equal(bySlot[1].readUInt8(22), 2, 'full gyro model');
  });
});

test('streams pad data with buttons and motion', async () => {
  await withServer(async ({ server, send, next }) => {
    server.setConnected(0, true);
    send(request(0x100002, Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])));
    await new Promise((r) => setTimeout(r, 20));
    server.update(0, WII.TWO | WII.B | WII.RIGHT | WII.HOME, [-0.5, 0.25, 0.75], [10, -20, 30]);

    let data;
    do data = await next(ofType(0x100002));
    while (data.readUInt8(37) === 0);
    verifyCrc(data);
    assert.equal(data.length, 100);
    assert.equal(data.readUInt8(20), 0, 'slot');
    assert.equal(data.readUInt8(31), 1, 'connected');
    assert.equal(data.readUInt8(36), 0x20, 'D-pad right');
    assert.equal(data.readUInt8(37), 0x10 | 0x40, 'Triangle (2) + Cross (B)');
    assert.equal(data.readUInt8(38), 1, 'PS (Home)');
    assert.equal(data.readUInt8(46), 255, 'analog D-pad right');
    assert.equal(data.readUInt8(51), 255, 'analog Triangle');
    assert.equal(data.readUInt8(49), 255, 'analog Cross');
    assert.equal(data.readFloatLE(76), -0.5);
    assert.equal(data.readFloatLE(80), 0.25);
    assert.equal(data.readFloatLE(84), 0.75);
    assert.equal(data.readFloatLE(88), 10);
    assert.equal(data.readFloatLE(92), -20);
    assert.equal(data.readFloatLE(96), 30);
  });
});

test('hub assigns slots, maps Wii Remote axes to DSU, and lets phones reclaim slots', () => {
  const updates = [];
  const dsu = { setConnected() {}, update: (...args) => updates.push(args) };
  const hub = new ControllerHub(dsu);

  const fakeSocket = () => {
    const ws = new EventEmitter();
    ws.sent = [];
    ws.send = (m) => ws.sent.push(JSON.parse(m));
    ws.close = () => ws.emit('close');
    return ws;
  };
  const hello = (ws, id) => ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', id, name: id })), false);

  const a = fakeSocket();
  const b = fakeSocket();
  hub.attach(a, '1.1.1.1');
  hub.attach(b, '1.1.1.2');
  hello(a, 'alice');
  hello(b, 'bob');
  assert.equal(a.sent[0].slot, 0);
  assert.equal(b.sent[0].slot, 1);

  // Wii Remote accel (x, y, z) = (-1, 0.2, 0.1); gyro (x, y, z) = (1, 2, 3)
  const pkt = Buffer.alloc(28);
  pkt.writeUInt16LE(WII.TWO, 0);
  [-1, 0.2, 0.1, 1, 2, 3].forEach((v, i) => pkt.writeFloatLE(v, 4 + i * 4));
  b.emit('message', pkt, true);
  const [slot, buttons, accel, gyro] = updates.at(-1);
  assert.equal(slot, 1);
  assert.equal(buttons, WII.TWO);
  assert.deepEqual(accel.map((v) => +v.toFixed(3)), [-1, 0.1, 0.2], 'DSU accel = wm (x, z, y)');
  assert.deepEqual(gyro, [1, 3, 2], 'DSU gyro (pitch, yaw, roll) = wm (x, z, y)');

  // Bob drops out, a new phone joins and must not take Bob's seat.
  b.emit('close');
  const c = fakeSocket();
  hub.attach(c, '1.1.1.3');
  hello(c, 'carol');
  assert.equal(c.sent[0].slot, 2);

  // Bob comes back and gets player 2 again.
  const b2 = fakeSocket();
  hub.attach(b2, '1.1.1.2');
  hello(b2, 'bob');
  assert.equal(b2.sent[0].slot, 1);
});
