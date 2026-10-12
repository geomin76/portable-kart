// Ties the pieces together and exposes the state/actions the dashboard uses.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { DsuServer } from './dsu-server.js';
import { ControllerHub } from './controller-hub.js';
import { Settings } from './settings.js';
import { lanAddresses } from './network.js';
import { loadOrCreateCert } from './certs.js';
import { startPhoneServer, PHONE_PORT } from './phone-server.js';
import { startDashboardServer, DASHBOARD_PORT } from './dashboard-server.js';
import { findDolphin, launchDolphin } from './dolphin.js';
import { describeGame, scanForGames } from './games.js';

export class App extends EventEmitter {
  constructor({ publicDir, devHttpPort, log = console.log }) {
    super();
    this.publicDir = publicDir;
    this.devHttpPort = devHttpPort;
    this.log = log;
    this.settings = new Settings();
    this.dsu = new DsuServer({ log });
    this.hub = new ControllerHub(this.dsu);
    this.hub.on('change', () => this.emit('change'));
    this.dolphin = null;
    this.lastError = '';
  }

  async start() {
    this.addresses = lanAddresses();
    const cert = await loadOrCreateCert(this.settings.dir, this.addresses);
    await this.dsu.start();
    await startPhoneServer({ cert, hub: this.hub, publicDir: this.publicDir, devHttpPort: this.devHttpPort, log: this.log });
    await startDashboardServer({ app: this, publicDir: this.publicDir, log: this.log });
    this.dashboardUrl = `http://localhost:${DASHBOARD_PORT}`;
    this.log(`Phones: open ${this.phoneUrl()}`);
  }

  phoneUrl() {
    return this.addresses.length ? `https://${this.addresses[0]}:${PHONE_PORT}` : null;
  }

  async qrSvg() {
    const url = this.phoneUrl();
    if (!url) return '<svg xmlns="http://www.w3.org/2000/svg"/>';
    return QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  }

  hasPlayers() {
    return this.hub.players.some(Boolean);
  }

  state() {
    const dolphinPath = findDolphin(this.settings.get('dolphinPath'));
    const gamePath = this.settings.get('gamePath');
    return {
      phoneUrl: this.phoneUrl(),
      addresses: this.addresses,
      players: this.hub.summary(),
      dolphin: { path: dolphinPath, found: Boolean(dolphinPath), running: Boolean(this.dolphin), connected: this.dsu.hasClients() },
      game: gamePath && fs.existsSync(gamePath) ? describeGame(gamePath) : null,
      fullscreen: this.settings.get('fullscreen'),
      platform: process.platform,
      error: this.lastError,
    };
  }

  scanGames() {
    return scanForGames();
  }

  updateSettings(patch) {
    const clean = {};
    if (typeof patch.dolphinPath === 'string') clean.dolphinPath = patch.dolphinPath.trim();
    if (typeof patch.gamePath === 'string') clean.gamePath = patch.gamePath.trim();
    if (typeof patch.fullscreen === 'boolean') clean.fullscreen = patch.fullscreen;
    this.settings.update(clean);
    this.emit('change');
    return this.state();
  }

  launch() {
    this.lastError = '';
    const executable = findDolphin(this.settings.get('dolphinPath'));
    const gamePath = this.settings.get('gamePath');
    if (this.dolphin) throw new Error('The game is already running.');
    if (!executable) throw new Error('Dolphin was not found. Install it or choose where it is.');
    if (!gamePath || !fs.existsSync(gamePath)) throw new Error('Choose your Mario Kart Wii game file first.');

    const child = launchDolphin({
      executable,
      userDir: path.join(this.settings.dir, 'dolphin-user'),
      gamePath,
      fullscreen: this.settings.get('fullscreen'),
      log: this.log,
    });
    this.dolphin = child;
    child.on('error', (err) => {
      this.lastError = `Dolphin failed to start: ${err.message}`;
    });
    child.on('exit', () => {
      if (this.dolphin === child) this.dolphin = null;
      this.emit('change');
    });
    this.emit('change');
    return this.state();
  }

  stopGame() {
    this.dolphin?.kill();
    return this.state();
  }
}
