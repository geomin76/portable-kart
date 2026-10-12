// Find the user's own Mario Kart Wii disc image so nobody has to type a path.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXTENSIONS = new Set(['.iso', '.wbfs', '.rvz', '.wia', '.gcz', '.ciso']);
const MKWII_REGIONS = { RMCE01: 'USA', RMCP01: 'Europe', RMCJ01: 'Japan', RMCK01: 'Korea' };

/** Reads the 6-character game ID from a disc image header, or null. */
export function readGameId(file) {
  const ext = path.extname(file).toLowerCase();
  // Where each format keeps a copy of the disc header.
  const offset = { '.iso': 0, '.wbfs': 0x200, '.rvz': 0x58, '.wia': 0x58 }[ext];
  if (offset === undefined) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(6);
    fs.readSync(fd, buf, 0, 6, offset);
    const id = buf.toString('ascii');
    return /^[A-Z0-9]{6}$/.test(id) ? id : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function describeGame(file) {
  const id = readGameId(file);
  return {
    path: file,
    name: path.basename(file),
    id,
    isMarioKartWii: id ? id in MKWII_REGIONS : /mario\s*kart/i.test(path.basename(file)),
    region: id ? (MKWII_REGIONS[id] ?? null) : null,
  };
}

/** Looks a couple of levels deep in the usual places people keep downloads. */
export function scanForGames(extraDirs = []) {
  const home = os.homedir();
  const roots = [...extraDirs, path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Games')];
  const results = new Map();

  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0 && !e.name.endsWith('.app') && e.name !== 'node_modules') walk(full, depth - 1);
      else if (e.isFile() && EXTENSIONS.has(path.extname(e.name).toLowerCase())) results.set(full, describeGame(full));
    }
  };
  for (const root of roots) walk(root, 2);

  return [...results.values()].sort((a, b) => Number(b.isMarioKartWii) - Number(a.isMarioKartWii));
}
