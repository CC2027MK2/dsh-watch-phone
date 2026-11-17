// Smoke test: load the bundle with a stub context, hit the routes that do not
// need a live DSH, then shut down. Run with `node smoke.mjs`.
import os from 'node:os'
import path from 'node:path'
import { apply } from './index.js'

const events = []
const ctx = {
  get: () => undefined,
  on: (name, fn) => events.push({ name, fn }),
  effect: () => {},
  logger: { info() {}, warn() {}, error() {} },
}

process.env.DSH_WATCH_PHONE_DATA = path.join(os.tmpdir(), 'dsh-watch-phone-smoke')

apply(ctx, { port: 38499 })

const base = 'http://127.0.0.1:38499'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await wait(600)

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

console.log('registered events:', events.map((e) => e.name).join(', '))

for (const event of events) {
  if (event.name === 'dispose') await event.fn()
}
await wait(300)
process.exit(0)
