#!/usr/bin/env node
// Entry point: start the servers and open the dashboard in the browser.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { App } from './app.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// --dev: also serve the controller at http://localhost:7444 for desktop-browser testing.
const app = new App({ publicDir, devHttpPort: process.argv.includes('--dev') ? 7444 : undefined });
try {
  await app.start();
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${err.port} is already in use. Is Portable Kart already running?`);
  } else {
    console.error(err);
  }
  process.exit(1);
}

if (!process.argv.includes('--no-open')) openInBrowser(app.dashboardUrl);

const shutdown = () => {
  app.stopGame();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
