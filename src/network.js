import os from 'node:os';

// Interface names that are almost never the Wi-Fi/Ethernet a phone can reach.
const VIRTUAL = /^(lo|docker|br-|veth|vbox|vmnet|utun|awdl|llw|bridge|tailscale|zt|virbr|vEthernet)/i;

/** LAN IPv4 addresses, best guess first. */
export function lanAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      found.push({ name, address: a.address, virtual: VIRTUAL.test(name) });
    }
  }
  const privateRange = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  const score = (a) => (a.virtual ? 0 : 2) + (privateRange(a.address) ? 1 : 0) + (a.address.startsWith('192.168.') ? 1 : 0);
  return found.sort((a, b) => score(b) - score(a)).map((a) => a.address);
}
