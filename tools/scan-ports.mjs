#!/usr/bin/env node
// Find the TCP port a watch's wireless-debugging daemon is listening on.
//
// `adb connect <ip>:<port>` needs the adbd port, and Android picks a random
// high port for it (only the pairing port is fixed and short-lived). Scanning
// the range from a machine that can reach the device is the quickest way to
// find it. Run this on any host that is on the same network as the watch - for
// example the phone whose hotspot the watch just joined:
//
//   node tools/scan-ports.mjs 192.0.2.42            # default 30000-50000
//   node tools/scan-ports.mjs 192.0.2.42 37000 45000
//
// It prints JSON: {"host":"…","scanned":20001,"open":[41543]}
import net from 'node:net';

const host = process.argv[2];
if (!host) {
  console.error('usage: node tools/scan-ports.mjs <host> [from] [to] [concurrency]');
  process.exit(2);
}
const from = Number(process.argv[3] ?? 30000);
const to = Number(process.argv[4] ?? 50000);
const conc = Number(process.argv[5] ?? 400);
const timeout = Number(process.env.SCAN_TIMEOUT ?? 600);

const open = [];
let next = from;
let active = 0;

await new Promise((resolve) => {
  const pump = () => {
    while (active < conc && next <= to) {
      const port = next++;
      active++;
      const sock = net.connect({ host, port });
      let settled = false;
      const done = (isOpen) => {
        if (settled) return;
        settled = true;
        active--;
        sock.destroy();
        if (isOpen) open.push(port);
        pump();
      };
      sock.setTimeout(timeout);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    }
    if (active === 0 && next > to) resolve();
  };
  pump();
});

open.sort((a, b) => a - b);
console.log(JSON.stringify({ host, scanned: to - from + 1, open }));
