// HTTPS + WebSocket server the phones connect to over Wi-Fi.

import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { serveStatic } from './static.js';

export const PHONE_PORT = 7443;

/**
 * @param {object} opts
 * @param {number} [opts.devHttpPort] Also serve plain HTTP on localhost, for
 *   testing the controller in a desktop browser (localhost counts as secure).
 */
export async function startPhoneServer({ cert, hub, publicDir, port = PHONE_PORT, devHttpPort, log }) {
  const root = path.join(publicDir, 'phone');
  const handler = (req, res) => {
    if (!serveStatic(root, req, res)) {
      res.writeHead(404);
      res.end('Not found');
    }
  };
  const server = https.createServer({ key: cert.key, cert: cert.cert }, handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const upgrade = (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.on('upgrade', upgrade);

  if (devHttpPort) {
    const dev = http.createServer(handler);
    dev.on('upgrade', upgrade);
    await new Promise((resolve, reject) => dev.once('error', reject).listen(devHttpPort, '127.0.0.1', resolve));
    log(`Dev controller page at http://localhost:${devHttpPort}`);
  }

  wss.on('connection', (ws, req) => {
    ws.binaryType = 'nodebuffer';
    // Input packets are tiny and latency-sensitive.
    req.socket.setNoDelay(true);
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    hub.attach(ws, req.socket.remoteAddress);
  });

  // Drop phones whose connection silently died (screen locked, walked away).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 5000);
  wss.on('close', () => clearInterval(heartbeat));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      log(`Phone server listening on port ${port}`);
      resolve(server);
    });
  });
}
