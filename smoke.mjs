// Smoke test: load the bundle with a stub context, hit the routes that do not
// need a live DSH, verify the UDP discovery beacon answers, then shut down.
// Run with `node smoke.mjs`.
import dgram from 'node:dgram'
import os from 'node:os'
import path from 'node:path'
import { apply } from './index.js'

const PORT = 38499
const DISCOVERY_PORT = 38519

const events = []
const ctx = {
  get: () => undefined,
  on: (name, fn) => events.push({ name, fn }),
  effect: () => {},
  logger: { info() {}, warn() {}, error() {} },
}

process.env.DSH_WATCH_PHONE_DATA = path.join(os.tmpdir(), 'dsh-watch-phone-smoke')

apply(ctx, { port: PORT, discoveryPort: DISCOVERY_PORT })

const base = `http://127.0.0.1:${PORT}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await wait(800)

const health = await fetch(base + '/health').then((r) => r.json())
console.log('health:', JSON.stringify(health))

const apk = await fetch(base + '/watch/app.apk')
const apkBytes = (await apk.arrayBuffer()).byteLength
console.log('apk:', apk.status, apk.headers.get('content-type'), apkBytes, 'bytes')

const exec = await fetch(base + '/exec', { method: 'POST', body: '{"cmd":"echo hi"}' })
console.log('exec (default off):', exec.status, JSON.stringify(await exec.json()))

const relay = await fetch(base + '/relay', { method: 'POST', body: '{"port":1}' })
console.log('relay (default off):', relay.status)

const miss = await fetch(base + '/nope')
console.log('404 route:', miss.status)

// --- discovery: the watch broadcasts a probe and expects JSON back ---------
const answer = await new Promise((resolve) => {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  socket.on('message', (msg) => {
    socket.close()
    resolve(msg.toString('utf8'))
  })
  socket.bind(() => {
    const probe = Buffer.from('dsh-watch?', 'utf8')
    socket.send(probe, 0, probe.length, DISCOVERY_PORT, '127.0.0.1')
  })
  setTimeout(() => {
    try { socket.close() } catch { /* ignore */ }
    resolve('')
  }, 2500)
})
console.log('discovery:', answer || '(no answer)')
const discovered = answer ? JSON.parse(answer) : {}
const discoveryOk = discovered.service === 'dsh-watch-phone' && Array.isArray(discovered.urls) && discovered.urls.length > 0
console.log('discovery urls:', JSON.stringify(discovered.urls ?? []))

console.log('registered events:', events.map((e) => e.name).join(', '))

for (const event of events) {
  if (event.name === 'dispose') await event.fn()
}
await wait(300)

if (!discoveryOk) {
  console.error('FAIL: discovery beacon did not answer')
  process.exit(1)
}
console.log('SMOKE_OK')
process.exit(0)
