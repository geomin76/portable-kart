// Per-user app data (settings, certificate, Dolphin's user folder).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function appDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'PortableKart');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'PortableKart');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'portable-kart');
}

const DEFAULTS = {
  dolphinPath: '',
  gamePath: '',
  fullscreen: true,
};

export class Settings {
  constructor(dir = appDataDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'settings.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      this.values = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      this.values = { ...DEFAULTS };
    }
  }

  get(key) {
    return this.values[key];
  }

  update(patch) {
    for (const key of Object.keys(DEFAULTS)) if (key in patch) this.values[key] = patch[key];
    fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
  }
}
