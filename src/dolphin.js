// Find, configure and launch Dolphin.
//
// We run Dolphin with its own user folder (`--user`) inside our app data, so
// we never touch someone's existing Dolphin setup, and we can write the
// controller profile that binds our DSU pads to emulated Wii Remotes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { mergeIniFile } from './ini.js';
import { DSU_PORT, MAX_SLOTS } from './dsu-server.js';

export const DSU_SERVER_NAME = 'PortableKart';

function candidatePaths() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return ['/Applications/Dolphin.app', path.join(home, 'Applications', 'Dolphin.app'), path.join(home, 'Downloads', 'Dolphin.app')];
  }
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA, path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Documents'), 'C:\\'];
    const folders = ['Dolphin', 'Dolphin Emulator', 'Dolphin-x64', path.join('Programs', 'Dolphin'), path.join('Dolphin-x64', 'Dolphin-x64')];
    return roots.filter(Boolean).flatMap((r) => folders.map((f) => path.join(r, f, 'Dolphin.exe')));
  }
  return ['/usr/bin/dolphin-emu', '/usr/local/bin/dolphin-emu', '/var/lib/flatpak/exports/bin/org.DolphinEmu.dolphin-emu', path.join(home, '.local/share/flatpak/exports/bin/org.DolphinEmu.dolphin-emu')];
}

/** Turn what the user picked (an .app bundle, a folder, or the binary) into the executable. */
export function resolveExecutable(p) {
  if (!p) return null;
  try {
    const stat = fs.statSync(p);
    if (stat.isFile()) return p;
    if (stat.isDirectory()) {
      const inside = process.platform === 'darwin' ? path.join(p, 'Contents', 'MacOS', 'Dolphin') : path.join(p, process.platform === 'win32' ? 'Dolphin.exe' : 'dolphin-emu');
      if (fs.existsSync(inside)) return inside;
    }
  } catch {
    // Missing path.
  }
  return null;
}

export function findDolphin(configured) {
  const fromSettings = resolveExecutable(configured);
  if (fromSettings) return fromSettings;
  for (const c of candidatePaths()) {
    const exe = resolveExecutable(c);
    if (exe) return exe;
  }
  if (process.platform === 'linux') {
    try {
      return execFileSync('which', ['dolphin-emu'], { encoding: 'utf8' }).trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Bindings from our DSU pad layout (see dsu-server.js / controller-hub.js) to a Wii Remote. */
export function wiimoteProfile(slot) {
  return {
    Device: `DSUClient/${slot}/${DSU_SERVER_NAME}`,
    Source: 1, // emulated Wii Remote
    Extension: 'None',
    'Buttons/A': '`Circle`',
    'Buttons/B': '`Cross`',
    'Buttons/1': '`Square`',
    'Buttons/2': '`Triangle`',
    'Buttons/-': '`Share`',
    'Buttons/+': '`Options`',
    'Buttons/Home': '`PS`',
    'D-Pad/Up': '`Pad N`',
    'D-Pad/Down': '`Pad S`',
    'D-Pad/Left': '`Pad W`',
    'D-Pad/Right': '`Pad E`',
    // Dolphin clamps each input at zero, so binding both directions of an axis
    // reconstructs the signed value. Wii Remote axes <- DSU axes:
    //   X (Left - Right)        <- accel x
    //   Y (Backward - Forward)  <- accel z
    //   Z (Up - Down)           <- accel y
    'IMUAccelerometer/Up': '`Accel Down`',
    'IMUAccelerometer/Down': '`Accel Up`',
    'IMUAccelerometer/Left': '`Accel Left`',
    'IMUAccelerometer/Right': '`Accel Right`',
    'IMUAccelerometer/Forward': '`Accel Backward`',
    'IMUAccelerometer/Backward': '`Accel Forward`',
    //   X (Pitch Down - Pitch Up)  <- gyro pitch
    //   Y (Roll Left - Roll Right) <- gyro roll
    //   Z (Yaw Left - Yaw Right)   <- gyro yaw
    'IMUGyroscope/Pitch Down': '`Gyro Pitch Up`',
    'IMUGyroscope/Pitch Up': '`Gyro Pitch Down`',
    'IMUGyroscope/Roll Left': '`Gyro Roll Right`',
    'IMUGyroscope/Roll Right': '`Gyro Roll Left`',
    'IMUGyroscope/Yaw Left': '`Gyro Yaw Right`',
    'IMUGyroscope/Yaw Right': '`Gyro Yaw Left`',
    'Options/Sideways Wiimote': 'False',
    'Options/Upright Wiimote': 'False',
  };
}

export function configureDolphin(userDir, { fullscreen }) {
  const configDir = path.join(userDir, 'Config');
  fs.mkdirSync(configDir, { recursive: true });

  mergeIniFile(path.join(configDir, 'DSUClient.ini'), {
    Server: { Enabled: 'True', Entries: `${DSU_SERVER_NAME}:127.0.0.1:${DSU_PORT};` },
  });

  const wiimotes = {};
  for (let slot = 0; slot < MAX_SLOTS; slot++) wiimotes[`Wiimote${slot + 1}`] = wiimoteProfile(slot);
  mergeIniFile(path.join(configDir, 'WiimoteNew.ini'), wiimotes, Object.keys(wiimotes));

  mergeIniFile(path.join(configDir, 'Dolphin.ini'), {
    Analytics: { PermissionAsked: 'True', Enabled: 'False' },
    AutoUpdate: { UpdateTrack: '' },
    Interface: { ConfirmStop: 'False' },
    Display: { Fullscreen: fullscreen ? 'True' : 'False' },
    Core: { WiimoteContinuousScanning: 'False', WiimoteEnableSpeaker: 'False' },
  });
}

/** Launches the game; resolves the child process. */
export function launchDolphin({ executable, userDir, gamePath, fullscreen, log }) {
  configureDolphin(userDir, { fullscreen });
  const args = ['--user', userDir, '--batch', '--exec', gamePath];
  log(`Starting Dolphin: ${executable}`);
  const child = spawn(executable, args, { stdio: 'ignore', detached: false });
  child.on('error', (err) => log(`Dolphin failed to start: ${err.message}`));
  return child;
}
