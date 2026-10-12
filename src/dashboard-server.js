// The "TV side" control panel, served only to this computer.

import http from 'node:http';
import path from 'node:path';
import { serveStatic } from './static.js';

export const DASHBOARD_PORT = 7480;

/**
 * @param {object} opts
 * @param {object} opts.app  The App from app.js (state + actions).
 */
export function startDashboardServer({ app, publicDir, port = DASHBOARD_PORT, log }) {
  const root = path.join(publicDir, 'dashboard');
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const streams = new Set();

  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(err);
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    // Only this machine's browser may drive the dashboard: reject other Host
    // headers (DNS rebinding) and cross-site writes (CSRF from other tabs).
    if (!allowedHosts.has(req.headers.host)) return sendJson(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if ((origin && !allowedHosts.has(origin.replace(/^http:\/\//, ''))) || !req.headers['content-type']?.startsWith('application/json')) {
        return sendJson(res, 403, { error: 'Forbidden' });
      }
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, app.state());
      if (req.method === 'GET' && url.pathname === '/api/qr.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        return res.end(await app.qrSvg());
      }
      if (req.method === 'GET' && url.pathname === '/api/games') return sendJson(res, 200, app.scanGames());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(app.state())}\n\n`);
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') return sendJson(res, 200, app.updateSettings(await readJson(req)));
      if (req.method === 'POST' && url.pathname === '/api/launch') return sendJson(res, 200, app.launch());
      if (req.method === 'POST' && url.pathname === '/api/stop') return sendJson(res, 200, app.stopGame());
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    if (req.method === 'GET' && serveStatic(root, req, res)) return;
    sendJson(res, 404, { error: 'Not found' });
  });

  // Push state to open dashboards: immediately on changes, and ~15x/s while
  // players are connected so the steering meters move.
  const push = () => {
    if (streams.size === 0) return;
    const msg = `data: ${JSON.stringify(app.state())}\n\n`;
    for (const res of streams) res.write(msg);
  };
  app.on('change', push);
  setInterval(() => {
    if (app.hasPlayers()) push();
  }, 66);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(`Dashboard at http://localhost:${port}`);
      resolve(server);
    });
  });
}
