import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureDolphin } from '../src/dolphin.js';
import { parseIni } from '../src/ini.js';
import { describeGame } from '../src/games.js';

test('writes DSU server and Wii Remote bindings, keeping unrelated settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-dolphin-'));
  const config = path.join(dir, 'Config');
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, 'Dolphin.ini'), '[General]\nISOPath0 = /games\n[Display]\nFullscreen = False\n');
  fs.writeFileSync(path.join(config, 'WiimoteNew.ini'), '[Wiimote1]\nButtons/Z = `Old`\n');

  configureDolphin(dir, { fullscreen: true });

  const dsu = parseIni(fs.readFileSync(path.join(config, 'DSUClient.ini'), 'utf8'));
  assert.equal(dsu.get('Server').get('Enabled'), 'True');
  assert.equal(dsu.get('Server').get('Entries'), 'PortableKart:127.0.0.1:26760;');

  const wii = parseIni(fs.readFileSync(path.join(config, 'WiimoteNew.ini'), 'utf8'));
  for (let i = 1; i <= 4; i++) {
    const w = wii.get(`Wiimote${i}`);
    assert.equal(w.get('Device'), `DSUClient/${i - 1}/PortableKart`);
    assert.equal(w.get('Source'), '1');
    assert.equal(w.get('Buttons/2'), '`Triangle`');
    assert.equal(w.get('IMUAccelerometer/Left'), '`Accel Left`');
  }
  assert.equal(wii.get('Wiimote1').has('Buttons/Z'), false, 'stale bindings removed');

  const main = parseIni(fs.readFileSync(path.join(config, 'Dolphin.ini'), 'utf8'));
  assert.equal(main.get('General').get('ISOPath0'), '/games', 'unrelated settings kept');
  assert.equal(main.get('Display').get('Fullscreen'), 'True');
  assert.equal(main.get('Analytics').get('PermissionAsked'), 'True');
});

test('recognises Mario Kart Wii from the disc header', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-games-'));
  const iso = path.join(dir, 'game.iso');
  const header = Buffer.alloc(0x400);
  header.write('RMCE01', 0, 'ascii');
  fs.writeFileSync(iso, header);
  assert.deepEqual(
    { id: describeGame(iso).id, mk: describeGame(iso).isMarioKartWii, region: describeGame(iso).region },
    { id: 'RMCE01', mk: true, region: 'USA' },
  );

  const wbfs = path.join(dir, 'other.wbfs');
  const w = Buffer.alloc(0x400);
  w.write('RSBE01', 0x200, 'ascii');
  fs.writeFileSync(wbfs, w);
  assert.equal(describeGame(wbfs).isMarioKartWii, false);
});
