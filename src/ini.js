// Minimal INI reader/writer for Dolphin's config files. Dolphin rewrites these
// files itself, so we merge our keys into whatever is already there.

import fs from 'node:fs';

/** @returns {Map<string, Map<string, string>>} */
export function parseIni(text) {
  const sections = new Map();
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      current = sections.get(header[1]) ?? new Map();
      sections.set(header[1], current);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0 && current) current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return sections;
}

export function stringifyIni(sections) {
  let out = '';
  for (const [name, keys] of sections) {
    out += `[${name}]\n`;
    for (const [k, v] of keys) out += `${k} = ${v}\n`;
  }
  return out;
}

/**
 * Merge `patch` ({ section: { key: value } }) into the INI file at `file`.
 * Sections listed in `replaceSections` are cleared first so stale bindings don't linger.
 */
export function mergeIniFile(file, patch, replaceSections = []) {
  let sections = new Map();
  try {
    sections = parseIni(fs.readFileSync(file, 'utf8'));
  } catch {
    // New file.
  }
  for (const [section, keys] of Object.entries(patch)) {
    const target = replaceSections.includes(section) ? new Map() : (sections.get(section) ?? new Map());
    for (const [k, v] of Object.entries(keys)) target.set(k, String(v));
    sections.set(section, target);
  }
  fs.writeFileSync(file, stringifyIni(sections));
}
