/**
 * dsh-watch-draft / index.js
 * DSH Host plugin: HTTP bridge that lets a smartwatch chat with DSH over LAN.
 *
 * `apply(ctx, config)` per the DSH Host plugin contract.
 * Uses `ctx.on('dispose')` for cleanup instead of `ctx.effect()` — the latter
 * fired immediately in this host, closing the server right after listen().
 */

import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { AgentBridge } from './agent-bridge.js'

const TAG = '[dsh-watch-draft]'
const HERE = path.dirname(fileURLToPath(import.meta.url))
// Everything is relative to this file unless the environment overrides it, so a
// checkout works on any machine without editing hard-coded paths.
const WORK_DIR = process.env.DSH_WATCH_BRIDGE_DIR ?? HERE
// The phone-side research/distribution folder used by /files and /collect.
// Optional: those two routes simply 404 when the folder is absent.
const PHONE_DIR = process.env.DSH_PHONE_DIR ?? path.join(HERE, '..', 'phone-dsh-re')
const DIST_DIR = path.join(PHONE_DIR, 'dist')
const LOG = path.join(WORK_DIR, 'bridge.log')
function logLine(...args) {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${args.join(' ')}\n`)
  } catch { /* ignore */ }
  console.log(TAG, ...args)
}

// Python interpreter used for Vosk. Point DSH_PYTHON at a specific one if `python`
// is not on PATH (on Windows it is usually `python`, not `python3`).
const PYTHON = process.env.DSH_PYTHON ?? 'python'
const PYTHON_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8' }

/**
 * Long-lived Vosk transcriber. The model costs about a second to load, and a
 * watch voice message arrives every few minutes, so keeping the process warm
 * makes the round trip noticeably shorter. Requests are serialised through a
 * FIFO because the worker answers on one stdout stream.
 */
const sttWorker = {
  child: null,
  buffer: '',
  queue: [],
  ready: null,

  ensure() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.ready
    const workerScript = path.join(WORK_DIR, 'stt_worker.py')
    logLine('stt worker: spawning', workerScript)
    const child = spawn(PYTHON, [workerScript], { windowsHide: true, env: PYTHON_ENV })
    this.child = child
    this.buffer = ''
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stt worker did not become ready')), 30000)
      const onReady = (ok) => {
        clearTimeout(timer)
        if (ok) resolve()
        else reject(new Error('stt worker failed to start'))
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => this.onData(chunk, onReady))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (text) => logLine('stt worker stderr:', String(text).trim().slice(0, 300)))
      child.on('exit', (code) => {
        clearTimeout(timer)
        logLine(`stt worker: exited (${code})`)
        this.child = null
        this.ready = null
        const pending = this.queue.splice(0)
        for (const item of pending) item.reject(new Error(`stt worker exited (${code})`))
        onReady(false)
      })
    })
    this.ready.catch(() => {})
    return this.ready
  },

  onData(chunk, onReady) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        logLine('stt worker: unparseable line', line.slice(0, 160))
        continue
      }
      if (message.ready) {
        onReady(true)
        continue
      }
      if (message.fatal) {
        onReady(false)
        continue
      }
      const item = this.queue.shift()
      if (!item) continue
      clearTimeout(item.timer)
      if (message.ok) item.resolve(message)
      else item.reject(new Error(message.error ?? 'stt failed'))
    }
  },

  transcribe(wavPath) {
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, timer: null }
      item.timer = setTimeout(() => {
        const at = this.queue.indexOf(item)
        if (at >= 0) this.queue.splice(at, 1)
        reject(new Error('stt worker timed out'))
      }, 90000)
      this.queue.push(item)
      this.ensure()
        .then(() => this.child.stdin.write(JSON.stringify({ wav: wavPath }) + '\n'))
        .catch((err) => {
          const at = this.queue.indexOf(item)
          if (at >= 0) this.queue.splice(at, 1)
          clearTimeout(item.timer)
          reject(err)
        })
    })
  },

  stop() {
    if (this.child) {
      try {
        this.child.stdin.end()
      } catch { /* ignore */ }
      try {
        this.child.kill()
      } catch { /* ignore */ }
      this.child = null
      this.ready = null
    }
  },
}

/** One-shot fallback: spawns Python for a single clip. */
async function transcribeOneShot(wavPath) {
  const script = path.join(WORK_DIR, 'stt_vosk.py')
  const stdout = await new Promise((resolve, reject) => {
    execFile(PYTHON, [script, wavPath], { timeout: 90000, windowsHide: true, env: PYTHON_ENV },
      (err, out, errOut) => {
        if (err) return reject(new Error(`stt process failed: ${err.message} ${String(errOut).slice(0, 300)}`))
        resolve(out)
      })
  })
  const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}'
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error(`stt returned non-JSON: ${line.slice(0, 200)}`)
  }
  if (parsed.error) throw new Error(parsed.error)
  return parsed
}

/**
 * Runs the bundled Vosk transcriber on a WAV clip and returns the text.
 * Everything is local: no network, no cloud STT.
 */
async function transcribeOffline(wavPath) {
  let parsed
  try {
    parsed = await sttWorker.transcribe(wavPath)
  } catch (err) {
    logLine('stt worker unavailable, falling back to one-shot:', String(err?.message ?? err))
    parsed = await transcribeOneShot(wavPath)
  }
  // Surface the recording level so the caller can tell a silent clip from one
  // the model simply failed to understand.
  return { text: String(parsed.text ?? ''), peak: parsed.peak ?? null, rms: parsed.rms ?? null, seconds: parsed.seconds ?? null }
}

/**
 * @param {any} ctx   Cordis context
 * @param {any} config  Plugin config (plain values from the patch layer)
 */
/** Process-wide slot so a reloaded plugin instance can close its predecessor. */
const SERVER_KEY = Symbol.for('dsh-watch-draft.server')

const TTS_DIR = path.join(WORK_DIR, 'tts-cache')
const TTS_SCRIPT = path.join(WORK_DIR, 'tts_sapi.ps1')

/**
 * Synthesises speech on the host and returns the cached WAV path.
 *
 * The watch has no TextToSpeech service at all (the framework service is
 * missing on HyperOS wearables), so the host speaks on its behalf using the
 * built-in Windows voice and streams the audio back over the LAN. Results are
 * cached by text so repeated replies cost nothing.
 */
async function synthesizeSpeech(text) {
  if (!fs.existsSync(TTS_DIR)) fs.mkdirSync(TTS_DIR, { recursive: true })
  const key = crypto.createHash('sha1').update(text).digest('hex')
  const out = path.join(TTS_DIR, `${key}.wav`)
  if (fs.existsSync(out) && fs.statSync(out).size > 44) return out

  const stdout = await new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TTS_SCRIPT, '-Text', text, '-Out', out],
      { timeout: 60000, windowsHide: true, env: { ...process.env } },
      (err, outText, errOut) => {
        if (err) return reject(new Error(`tts process failed: ${err.message} ${String(errOut).slice(0, 300)}`))
        resolve(outText)
      },
    )
  })
  const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}'
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error(`tts returned non-JSON: ${line.slice(0, 200)}`)
  }
  if (!parsed.ok) throw new Error(parsed.error ?? 'tts failed')
  return out
}

/**
 * Auth is on by default: this bridge feeds `/chat` and `/stt` into a real DSH
 * session on the PC, so an empty token used to mean "anyone on the Wi-Fi can
 * drive this machine". See the same helper in the phone-side `index.js` - the
 * rules are identical:
 *   1. `config.token` -> use it and bind the LAN;
 *   2. a token minted on an earlier run (`DATA_DIR/token`) -> reuse, loopback;
 *   3. otherwise mint one, persist it 0600, log it, loopback.
 */
function resolveToken({ configured, dataDir, log }) {
  const fromConfig = typeof configured === 'string' ? configured.trim() : ''
  if (fromConfig) return { token: fromConfig, source: 'config' }
  const file = path.join(dataDir, 'token')
  try {
    const saved = fs.readFileSync(file, 'utf8').trim()
    if (saved) {
      log(`auth: reusing token from ${file}; loopback only until config.token is set`)
      return { token: saved, source: 'generated' }
    }
  } catch {
    /* first run: no token file yet */
  }
  const fresh = crypto.randomBytes(18).toString('base64url')
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(file, `${fresh}\n`, { mode: 0o600 })
  } catch (err) {
    log(`auth: could not persist token (${err?.message ?? err}); it changes on restart`)
  }
  log(`auth: generated token ${fresh} (${file}); pair the watch with it, then set config.token to open the LAN`)
  return { token: fresh, source: 'generated' }
}

export function apply(ctx, config = {}) {
  const port = config.port ?? 38401
  const DATA_DIR = process.env.DSH_WATCH_BRIDGE_DATA ?? path.join(os.homedir(), '.dsh', 'watch-bridge')
  const auth = resolveToken({ configured: config.token, dataDir: DATA_DIR, log: logLine })
  const token = auth.token
  const bindHost = auth.source === 'config' ? '0.0.0.0' : '127.0.0.1'
  const cwd = config.cwd ?? process.cwd()
  const maxWaitMs = config.maxWaitMs ?? 180000

  logLine(`apply() called, config=${JSON.stringify(config)}`)

  const bridge = new AgentBridge({ ctx, cwd, maxWaitMs, log: logLine, sessionId: config.sessionId ?? 'watch-main-v2' })

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // `/health` and the read-only `/files/` download stay open so a fresh client
    // can probe and bootstrap; everything else - `/chat`, `/stt`, `/collect` -
    // requires the token, configured or minted.
    if (req.url !== '/health' && !req.url.startsWith('/files/')) {
      const authHeader = req.headers['authorization'] ?? ''
      const got = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
      if (got !== token) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
    }

    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'dsh-watch-draft', session: bridge.sessionId, auth: true }))
      return
    }

    // --- file distribution for the phone-side bootstrap ------------------
    // GET /files/<name> serves a file out of phone-dsh-re/dist so the DSH Go
    // agent running inside the phone container can fetch it with node/curl.
    if (req.method === 'GET' && req.url.startsWith('/files/')) {
      const name = decodeURIComponent(req.url.slice('/files/'.length).split('?')[0])
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'bad name' }))
        return
      }
      const file = path.join(DIST_DIR, name)
      if (!fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found', file }))
        return
      }
      const body = fs.readFileSync(file)
      logLine(`files: served ${name} (${body.length} bytes)`)
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length })
      res.end(body)
      return
    }

    // POST /collect?name=x — the phone container POSTs diagnostics here.
    if (req.method === 'POST' && req.url.startsWith('/collect')) {
      const name = (req.url.split('?')[1] ?? 'body')
        .split('&')
        .map((kv) => kv.split('='))
        .find(([k]) => k === 'name')?.[1] ?? 'body'
      let body = ''
      for await (const chunk of req) body += chunk
      const logFile = path.join(PHONE_DIR, 'collect.log')
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
      fs.appendFileSync(logFile, `\n===== ${new Date().toISOString()} :: ${name} =====\n${body}\n`)
      logLine(`collect: ${name} (${body.length} bytes)`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.url === '/tts' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid json' }))
        return
      }
      const text = String(parsed.text ?? '').trim()
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'text required' }))
        return
      }
      try {
        const startedAt = Date.now()
        const wavPath = await synthesizeSpeech(text)
        const elapsed = Date.now() - startedAt
        const bytes = fs.readFileSync(wavPath)
        logLine(`tts: synthesized ${bytes.length} bytes in ${elapsed}ms for ${JSON.stringify(text.slice(0, 40))}`)
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': String(bytes.length),
          'Cache-Control': 'no-store',
        })
        res.end(bytes)
      } catch (err) {
        logLine('tts failed', String(err?.message ?? err))
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err?.message ?? err) }))
      }
      return
    }

    if (req.url === '/chat' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid json' }))
        return
      }
      const text = String(parsed.text ?? '').trim()
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'text required' }))
        return
      }
      logLine(`chat request: ${text.slice(0, 80)}`)
      try {
        const reply = await bridge.deliver(text)
        logLine(`chat reply: ${reply.slice(0, 80)}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, reply }))
      } catch (err) {
        logLine(`chat error: ${err?.message ?? err}`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err?.message ?? err) }))
      }
      return
    }

    if (req.url === '/stt' && req.method === 'POST') {
      // multipart/form-data audio upload from the watch app
      const contentType = String(req.headers['content-type'] ?? '')
      const m = contentType.match(/boundary="?([^";]+)"?/i)
      if (!m) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'missing multipart boundary' }))
        return
      }
      const boundary = Buffer.from('--' + m[1])
      const chunks = []
      let total = 0
      const MAX = 5 * 1024 * 1024
      try {
        for await (const chunk of req) {
          total += chunk.length
          if (total > MAX) {
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'audio too large' }))
            return
          }
          chunks.push(chunk)
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'upload read failed' }))
        return
      }
      const body = Buffer.concat(chunks)
      const bodyStr = body.toString('utf8')
      const partHeaderMatch = bodyStr.match(/Content-Disposition:[^\r\n]*name="audio"[^\r\n]*filename="([^"]*)"/i)
      const filename = partHeaderMatch ? partHeaderMatch[1] : 'clip.ogg'

      // split multipart body into parts using the boundary bytes
      const parts = []
      let idx = body.indexOf(boundary)
      while (idx !== -1) {
        const next = body.indexOf(boundary, idx + boundary.length)
        if (next === -1) break
        const raw = body.subarray(idx + boundary.length, next)
        parts.push(raw)
        idx = next
      }
      let audioBuf = null
      for (const p of parts) {
        const s = p.toString('utf8')
        const hdEnd = s.indexOf('\r\n\r\n')
        if (hdEnd === -1) continue
        const header = s.slice(0, hdEnd)
        if (!/name="audio"/i.test(header)) continue
        // cut the trailing CRLF before the next boundary
        let dataEnd = p.length
        if (p.length >= 2 && p[p.length - 2] === 0x0d && p[p.length - 1] === 0x0a) {
          dataEnd = p.length - 2
        }
        const start = Buffer.byteLength(s.slice(0, hdEnd + 4), 'utf8')
        audioBuf = p.subarray(start, dataEnd)
        break
      }
      if (!audioBuf || audioBuf.length < 64) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'no audio payload found' }))
        return
      }

      // save to temp file so the STT command can read it
      const tmpDir = os.tmpdir()
      const tmpFile = path.join(tmpDir, `dsh-watch-stt-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
      fs.writeFileSync(tmpFile, audioBuf)
      logLine(`stt: uploaded ${audioBuf.length} bytes -> ${tmpFile} (name=${filename})`)

      try {
        const startedAt = Date.now()
        const stt = await transcribeOffline(tmpFile)
        const elapsed = Date.now() - startedAt
        // Keep the clip when DSH_WATCH_STT_KEEP is set so the recording can be
        // inspected (level check, manual re-transcribe) after a failed attempt.
        if (process.env.DSH_WATCH_STT_KEEP) {
          logLine(`stt: kept ${tmpFile}`)
        } else {
          fs.unlink(tmpFile, () => {})
        }
        logLine(
          `stt: result ${JSON.stringify(stt.text)} in ${elapsed}ms ` +
            `(peak=${stt.peak} rms=${stt.rms} audio=${stt.seconds}s)`,
        )
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, text: stt.text, peak: stt.peak, rms: stt.rms }))
      } catch (err) {
        fs.unlink(tmpFile, () => {})
        logLine('stt transcribe failed', String(err?.message ?? err))
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err?.message ?? err) }))
      }
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  function logAddresses() {
    const nets = os.networkInterfaces()
    const addrs = []
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === 'IPv4' && !net.internal) addrs.push(net.address)
      }
    }
    logLine(`HTTP bridge on ${bindHost}:${port}`)
    if (bindHost === '0.0.0.0') {
      for (const a of addrs) {
        logLine(`  LAN: http://${a}:${port}`)
      }
    } else {
      logLine(`  loopback only: http://127.0.0.1:${port}; set config.token to serve the LAN`)
    }
  }

  // A previous instance of this plugin in the same host process would still
  // hold the port (ctx dispose hooks do not fire reliably here), so close it.
  try {
    const previous = globalThis[SERVER_KEY]
    if (previous) {
      previous.close()
      logLine('closed previous server instance')
    }
  } catch (err) {
    logLine(`could not close previous server: ${err?.message ?? err}`)
  }
  globalThis[SERVER_KEY] = server

  server.on('error', (err) => {
    logLine(`server error: ${err.message}`)
    console.error(TAG, 'server error:', err.message)
  })

  server.listen(port, bindHost, () => {
    logLine(`server listening on ${bindHost}:${port}`)
    logAddresses()
  })

  // Cleanup on plugin unload. Use ctx.on('dispose') — ctx.effect() closed the
  // server immediately in this host (the "active" fiber phase may not match
  // the effect lifecycle).
  ctx.on('dispose', () => {
    logLine('dispose: closing server')
    server.close()
    bridge.dispose().catch(() => {})
    sttWorker.stop()
  })
}
