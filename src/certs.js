// iOS only exposes motion sensors to pages served over HTTPS, so the phone
// page needs a certificate. We make a self-signed one per computer and
// regenerate it whenever the laptop's LAN address changes.

import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';

export async function loadOrCreateCert(dir, addresses) {
  const certFile = path.join(dir, 'cert.json');
  const wanted = [...addresses].sort();
  try {
    const saved = JSON.parse(fs.readFileSync(certFile, 'utf8'));
    const fresh = new Date(saved.expires).getTime() - Date.now() > 7 * 24 * 3600 * 1000;
    if (fresh && JSON.stringify(saved.addresses) === JSON.stringify(wanted)) return saved;
  } catch {
    // No usable certificate yet.
  }

  const notBeforeDate = new Date(Date.now() - 24 * 3600 * 1000);
  const notAfterDate = new Date(notBeforeDate.getTime() + 365 * 24 * 3600 * 1000);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Portable Kart' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [{ type: 2, value: 'localhost' }, ...wanted.map((ip) => ({ type: 7, ip }))],
      },
    ],
  });
  const saved = { key: pems.private, cert: pems.cert, addresses: wanted, expires: notAfterDate.toISOString() };
  fs.writeFileSync(certFile, JSON.stringify(saved), { mode: 0o600 });
  return saved;
}
