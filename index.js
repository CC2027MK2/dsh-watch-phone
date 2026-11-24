/**
 * dsh-watch-phone / index.js
 *
 * LAN HTTP bridge that runs *inside the DSH Go host on the phone*, so the
 * watch can talk to the phone's own DSH runtime instead of the PC one.
 *
 * - chat : ctx.get('llm').stream() with a small in-memory history.
 * - stt  : ctx.get('speechToText') -> the phone's *local* sensevoice model.
 *          Audio arrives as a canonical 16 kHz mono PCM WAV (exactly what the
 *          watch records), gets resolved to the default provider and
 *          transcribed in-process. No PC, no network egress.
 * - tts  : no local engine exists in the proot container, so speech synthesis
 *          is still delegated to the companion PC bridge when one is reachable.
 *
 * Why the `llm` service and not a full Agent: this package is `link:`-mounted
 * into the phone profile, so bare `@deepseek-ai/*` specifiers do not resolve
 * here. Services reached through `ctx.get()` are fine.
 */

import http from 'node:http'
import fs from 'node:fs'
import net from 'node:net'
import dgram from 'node:dgram'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execAsync = promisify(execCb)

// Files shipped inside the bundle: the watch APK itself lives here so that a
// fresh install can hand it to `adb install` over the same HTTP bridge.
const APP_DIR = path.dirname(fileURLToPath(import.meta.url))
const APK_PATH = path.join(APP_DIR, 'assets', 'dsh-watch-chat.apk')


const DEFAULT_PORT = 38402
const MAX_HISTORY = 24
const MAX_AUDIO_BYTES = 8 << 20
const STATE_KEY = Symbol.for('dsh-watch-phone.server')

const SYSTEM_PROMPT =
  '你是运行在这台安卓手机上的 DSH 助手的语音通道。用户在智能手表上用语音跟你说话，' +
  '回答会被朗读出来。请用简洁口语化的中文回答，通常一到三句话，不要使用 Markdown、' +
  '列表、代码块或链接，除非用户明确要求。'

/**
 * Pull the spoken text out of one `assistant/message` session event.
 *
 * An assistant message carries everything the model produced in that step:
 * `reasoning` parts (its private thinking), `tool-call` parts, and finally the
 * `text` parts meant for the reader. Only the last kind belongs on the watch —
 * concatenating every part with a `.text` field leaks the chain of thought.
 */
function extractAssistantText(event) {
  const candidates = [event?.data?.message, event?.message, event?.payload?.message]
  for (const message of candidates) {
    if (!message || typeof message !== 'object') continue
    const content = Array.isArray(message.content) ? message.content : undefined
    if (!content) continue
    const text = content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
    if (text.trim()) return text
  }
  return ''
}

/** Newest assistant text emitted at or after `from`, skipped when blank. */
function lastAssistantText(events, from) {
  for (let index = events.length - 1; index >= from; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const text = extractAssistantText(event)
    if (text.trim()) return text
  }
  return ''
}

class WatchBridge {
  constructor(options) {
    this.ctx = options.ctx
    this.log = options.log
    this.history = []
    this.busy = false
    this.queue = []
    this.sessionId = options.sessionId ?? 'watch-voice'
    this.cwd = options.cwd ?? '/root/workspace'
    this.agent = null
    this.agentUnavailable = null
    this.createUserMessage = null
  }

  #llm() {
    const llm = this.ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('llm service unavailable in this host')
    }
    return llm
  }

  #route() {
    try {
      const defaults = this.ctx.get('agentDefaultModel')
      const sel = defaults?.currentSelection?.()
      if (sel?.provider && sel?.model) {
        return {
          provider: sel.provider,
          model: sel.model,
          ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}),
        }
      }
    } catch (err) {
      this.log(`route: default model unavailable: ${err?.message ?? err}`)
    }
    throw new Error('no provider/model route configured')
  }

  async deliver(text) {
    if (this.busy) {
      return new Promise((resolve, reject) => {
        this.queue.push({ text, resolve, reject })
      })
    }
    this.busy = true
    try {
      return await this.#turn(text)
    } finally {
      this.busy = false
      const next = this.queue.shift()
      if (next) {
        setImmediate(() => {
          this.deliver(next.text).then(next.resolve, next.reject)
        })
      }
    }
  }

  async #turn(text) {
    const agent = await this.#agent()
    if (agent === null) return this.#turnDirect(text)
    return this.#turnSession(agent, text)
  }

  /**
   * Lazily attach the bridge to a real DSH Session inside this host, so the
   * watch conversation is the same conversation the phone UI shows.
   * `@deepseek-ai/*` only resolves because of the node_modules link next to
   * this plugin; when it cannot be imported the bridge stays on the plain
   * `llm.stream()` path instead of failing.
   */
  async #agent() {
    if (this.agent !== null) return this.agent
    if (this.agentUnavailable !== null) return null
    try {
      const agentModule = await import('@deepseek-ai/dsh-agent')
      const llmModule = await import('@deepseek-ai/dsh-llm')
      const installModelSelection = agentModule.installModelSelection
      const createUserMessage = llmModule.createUserMessage
      if (typeof installModelSelection !== 'function') throw new Error('installModelSelection missing')
      if (typeof createUserMessage !== 'function') throw new Error('createUserMessage missing')
      this.createUserMessage = createUserMessage

      const agents = this.ctx.get('agents')
      if (!agents) throw new Error('agents service unavailable')

      const existing = typeof agents.get === 'function' ? agents.get(this.sessionId) : undefined
      if (existing) {
        this.agent = existing
        this.log(`agent: reusing live session ${this.sessionId}`)
        return this.agent
      }

      const defaults = this.ctx.get('agentDefaultModel')
      const presets = this.ctx.get('agentPresets')
      let composition = {
        setup: (agentCtx) => {
          installModelSelection(agentCtx)
        },
      }
      if (presets && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
        try {
          const resolved = await presets.resolve(undefined)
          if (resolved?.id) {
            composition = {
              agentPreset: resolved.id,
              setup: async (agentCtx) => {
                installModelSelection(agentCtx)
                await presets.mount(agentCtx, resolved.id)
              },
            }
          }
        } catch (err) {
          this.log(`agent: preset unavailable, using bare setup: ${err?.message ?? err}`)
        }
      }

      const selection = () => {
        try {
          return defaults?.currentSelection?.() ?? {}
        } catch {
          return {}
        }
      }
      const createOptions = {
        sessionId: this.sessionId,
        agentOptions: {
          get provider() {
            return selection().provider
          },
          get model() {
            return selection().model
          },
          get reasoningEffort() {
            return selection().reasoningEffort
          },
        },
        meta: { cwd: this.cwd, ...(composition.agentPreset ? { agentPreset: composition.agentPreset } : {}) },
        setup: composition.setup,
      }

      let handle
      try {
        handle = await agents.create(createOptions)
      } catch (err) {
        this.log(`agent: create failed (${err?.message ?? err}); trying resume`)
        handle = await agents.resume({ resumeSessionId: this.sessionId })
      }
      this.agent = handle?.agent ?? handle
      this.log(`agent: ready session=${this.sessionId} preset=${composition.agentPreset ?? '(none)'}`)
      return this.agent
    } catch (err) {
      this.agentUnavailable = String(err?.message ?? err)
      this.log(`agent: unavailable, staying on direct llm: ${this.agentUnavailable}`)
      return null
    }
  }

  async #turnSession(agent, text) {
    const session = agent.session
    const before = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents().length : 0
    const started = Date.now()
    this.log(`session turn: start session=${this.sessionId} events=${before} status=${agent.status}`)
    let failure = null
    const stopErrors = typeof this.ctx.on === 'function'
      ? this.ctx.on('agent/error', ({ agent: subject, error }) => {
          if (subject === agent) failure = error
        })
      : () => {}
    try {
      await agent.followup(
        this.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      )
      const seen = new Set()
      const deadline = Date.now() + 240000
      while (Date.now() < deadline) {
        const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
        let ended = false
        for (let index = Math.max(before, 0); index < events.length; index += 1) {
          const event = events[index]
          const type = event?.type
          if (typeof type === 'string' && !seen.has(type)) {
            seen.add(type)
            this.log(`session turn: event ${type}`)
          }
          if (type === 'turn/end') ended = true
        }
        // Only answer once the turn is closed: a step may emit several
        // assistant messages (thinking, tool calls, then the reply), and the
        // last one is the only text the user asked for.
        if (ended) {
          const reply = lastAssistantText(events, Math.max(before, 0))
          if (reply) {
            this.log(`session turn: reply ${reply.length} chars in ${Date.now() - started}ms`)
            return reply
          }
          throw new Error('turn ended without an assistant reply')
        }
        if (failure) throw failure
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      throw new Error(`session turn timed out (status=${agent.status} events=${session?.snapshotEvents?.().length ?? '?'})`)
    } finally {
      stopErrors()
    }
  }

  async #turnDirect(text) {
    const llm = this.#llm()
    const route = this.#route()
    this.history.push({ role: 'user', content: [{ type: 'text', text }] })

    const started = Date.now()
    this.log(`turn: start ${route.provider}/${route.model} history=${this.history.length}`)

    let out = ''
    let finishReason
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        messages: this.history,
        system: SYSTEM_PROMPT,
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
        else if (chunk?.type === 'finish') finishReason = chunk.reason
      }
    } catch (err) {
      this.history.pop()
      throw err
    }

    out = out.trim()
    this.log(`turn: reply ${out.length} chars in ${Date.now() - started}ms (finish=${finishReason ?? 'none'})`)
    if (!out) {
      this.history.pop()
      throw new Error(`empty reply (finish=${finishReason ?? 'none'})`)
    }

    this.history.push({
      id: `watch-${Date.now()}`,
      role: 'assistant',
      source: { kind: 'model', provider: route.provider, model: route.model },
      content: [{ type: 'text', text: out }],
    })
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY)
    }
    return out
  }

  /**
   * Transcribe one canonical WAV buffer with the phone's local provider.
   * @param {Buffer} audio complete WAV file bytes
   * @returns {Promise<string>} transcript text
   */
  /**
   * Transcribe one WAV buffer with the phone's local provider.
   * @param {Buffer} audio complete WAV file bytes, any rate/channel layout
   * @param {string} [languageOverride] language hint to force (`auto`, `zh`, ...)
   * @returns {Promise<{text: string, language: string, seconds: number, peak: number, gain: number}>}
   */
  async transcribe(audio, languageOverride) {
    const stt = this.ctx.get('speechToText')
    if (!stt || typeof stt.resolve !== 'function' || typeof stt.transcribe !== 'function') {
      throw new Error('speechToText service unavailable in this host')
    }

    let providerId = '(default)'
    let language = 'zh'
    try {
      const snapshot = stt.snapshot?.()
      providerId = snapshot?.selection?.providerId ?? providerId
      language = snapshot?.selection?.language ?? language
      this.log(`stt: providers=${(stt.listProviders?.() ?? []).map((p) => p.id).join(',') || 'none'} selected=${providerId}/${language}`)
    } catch (err) {
      this.log(`stt: snapshot failed: ${err?.message ?? err}`)
    }
    if (typeof languageOverride === 'string' && languageOverride.trim()) {
      language = languageOverride.trim()
    }

    const started = Date.now()
    let prepared
    try {
      prepared = prepareWav(audio)
    } catch (err) {
      this.log(`stt: unusable audio (${err?.message ?? err})`)
      throw err
    }
    this.log(
      `stt: prepared ${prepared.channels}ch/${prepared.rate}Hz ${prepared.seconds}s peak=${prepared.peak} gain=${prepared.gain} -> ${prepared.wav.length} bytes lang=${language}`,
    )

    const spec = stt.resolve({ audio: prepared.wav, language })
    const signal = AbortSignal.timeout(180000)
    const result = await stt.transcribe(spec, signal)
    const elapsed = Date.now() - started

    const text =
      typeof result === 'string'
        ? result
        : String(result?.text ?? result?.transcript ?? result?.result ?? '').trim()

    let shape = ''
    try {
      shape = result && typeof result === 'object' ? Object.keys(result).join(',') : typeof result
    } catch {
      /* ignore */
    }
    this.log(`stt: ${audio.length} bytes -> ${JSON.stringify(text)} in ${elapsed}ms (shape=${shape})`)
    return { text, language, seconds: prepared.seconds, peak: prepared.peak, gain: prepared.gain }
  }

  reset() {
    this.history = []
  }
}

function readRaw(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Sample rate the local sensevoice worker insists on. */
const STT_RATE = 16000
/** Quiet input (watch mics peak under ~600 here) is lifted towards this. */
const STT_TARGET_PEAK = 24000
const STT_MAX_GAIN = 40

/**
 * Turn whatever WAV a client sent into the one shape the local recogniser
 * accepts: canonical 44-byte header, mono, 16-bit PCM, 16 kHz. Watches already
 * record that shape; Windows SAPI emits an extra fmt chunk and 24 kHz audio,
 * and the phone's own MiMo voice comes out at 24 kHz, so both used to be
 * rejected as "Invalid speech WAV" before this hop existed.
 *
 * Quiet recordings are also lifted: a watch microphone at arm's length peaks
 * around 200-600 against a 32767 ceiling and the recogniser wastes accuracy on
 * such input, so anything under STT_TARGET_PEAK/4 is scaled up (at most
 * STT_MAX_GAIN times) before transcoding.
 *
 * @param {Buffer} input complete WAV file bytes
 * @returns {{wav: Buffer, channels: number, rate: number, seconds: number, peak: number, gain: number}}
 */
function prepareWav(input) {
  if (!Buffer.isBuffer(input) || input.length < 44) throw new Error('empty or truncated WAV')
  if (input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }

  let format = 1
  let channels = 0
  let rate = 0
  let bits = 0
  let data = null

  for (let at = 12; at + 8 <= input.length; ) {
    const id = input.toString('ascii', at, at + 4)
    const size = input.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ') {
      format = input.readUInt16LE(body)
      channels = input.readUInt16LE(body + 2)
      rate = input.readUInt32LE(body + 4)
      bits = input.readUInt16LE(body + 14)
    } else if (id === 'data') {
      data = input.subarray(body, Math.min(body + size, input.length))
    }
    at = body + size + (size % 2)
    if (data && channels && rate) break
  }

  if (!data || !channels || !rate) throw new Error('WAV without fmt/data chunk')
  if (format !== 1 || bits !== 16) throw new Error(`unsupported WAV format=${format} bits=${bits}`)

  const frames = Math.floor(data.length / (2 * channels))
  const mono = new Float64Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let sum = 0
    for (let c = 0; c < channels; c += 1) sum += data.readInt16LE((i * channels + c) * 2)
    mono[i] = sum / channels
  }

  let peak = 0
  for (let i = 0; i < frames; i += 1) {
    const abs = Math.abs(mono[i])
    if (abs > peak) peak = abs
  }

  let gain = 1
  if (peak > 0 && peak < STT_TARGET_PEAK / 4) {
    gain = Math.min(STT_MAX_GAIN, STT_TARGET_PEAK / peak)
  }

  const outFrames = Math.max(1, Math.round((frames * STT_RATE) / rate))
  const pcm = Buffer.alloc(outFrames * 2)
  const ratio = frames / outFrames
  for (let i = 0; i < outFrames; i += 1) {
    const pos = i * ratio
    const left = Math.min(frames - 1, Math.floor(pos))
    const right = Math.min(frames - 1, left + 1)
    const frac = pos - left
    const sample = (mono[left] + (mono[right] - mono[left]) * frac) * gain
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), i * 2)
  }

  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(36 + pcm.length, 4)
  head.write('WAVE', 8, 'ascii')
  head.write('fmt ', 12, 'ascii')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(STT_RATE, 24)
  head.writeUInt32LE(STT_RATE * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'ascii')
  head.writeUInt32LE(pcm.length, 40)

  return {
    wav: Buffer.concat([head, pcm]),
    channels,
    rate,
    seconds: Number((frames / rate).toFixed(2)),
    peak: Math.round(peak),
    gain: Number(gain.toFixed(1)),
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
  })
  res.end(body)
}

/**
 * Extract one multipart/form-data part by field name.
 * Hand-rolled on purpose: no third-party dependency is installable inside the
 * proot container, and the watch only ever sends a single small audio part.
 */
function multipartPart(buffer, contentType, field) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  const boundary = match?.[1] ?? match?.[2]?.trim()
  if (!boundary) throw new Error('missing multipart boundary')

  const delimiter = Buffer.from(`--${boundary}`)
  let cursor = buffer.indexOf(delimiter)
  if (cursor < 0) throw new Error('malformed multipart body')

  while (cursor >= 0) {
    const headerStart = cursor + delimiter.length
    const next = buffer.indexOf(delimiter, headerStart)
    if (next < 0) break

    const chunk = buffer.subarray(headerStart, next)
    const headerEnd = chunk.indexOf('\r\n\r\n')
    if (headerEnd >= 0) {
      const headers = chunk.subarray(0, headerEnd).toString('utf8')
      const nameMatch = /name="([^"]+)"/i.exec(headers)
      if (!nameMatch || nameMatch[1] === field) {
        // Trim the CRLF that precedes the next boundary.
        let body = chunk.subarray(headerEnd + 4)
        if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
          body = body.subarray(0, body.length - 2)
        }
        return { body, headers }
      }
    }
    cursor = next
  }
  throw new Error(`multipart field not found: ${field}`)
}

function proxyTo(base, pathname, req, res, log) {
  let target
  try {
    target = new URL(pathname, base)
  } catch (err) {
    log(`proxy: bad base ${base}: ${err?.message ?? err}`)
    sendJson(res, 500, { ok: false, error: 'bad proxy base' })
    return
  }
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, {
        ...up.headers,
        'access-control-allow-origin': '*',
      })
      up.pipe(res)
    },
  )
  // The PC fallback only exists for hosts without local speech support; a
  // stalled upstream must not keep the watch waiting for two minutes.
  const budget = pathname.startsWith('/stt') ? 25000 : 120000
  upstream.setTimeout(budget, () => {
    log(`proxy: timeout ${pathname} after ${budget}ms`)
    upstream.destroy(new Error('upstream timeout'))
  })
  upstream.on('error', (err) => {
    log(`proxy: ${pathname} failed: ${err?.message ?? err}`)
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: `upstream: ${err?.message ?? err}` })
    else res.end()
  })
  log(`proxy: ${req.method} ${pathname} -> ${target.href}`)
  req.pipe(upstream)
}

const VOICE_SETTINGS_PATH = '/root/.dsh/dsh-go/plugins/local-voice/data/settings.json'
const TTS_CACHE_DIR = path.join(os.tmpdir(), 'dsh-watch-tts')

/**
 * Resolve TTS credentials from the row config first, then (on DSH Go installs)
 * from the local-voice plugin's saved settings, so a phone that already set up
 * its reading voice needs nothing extra while a plain install can just put
 * `tts.apiKey` in its own config.
 */
function readVoiceSettings(tts = {}) {
  if (typeof tts.apiKey === 'string' && tts.apiKey) {
    return {
      provider: String(tts.provider ?? 'xiaomi'),
      apiKey: tts.apiKey,
      baseURL: String(tts.baseURL ?? 'https://api.xiaomimimo.com/v1').replace(/\/+$/, ''),
      model: String(tts.model ?? 'mimo-v2.5-tts'),
      voice: String(tts.voice ?? 'BingTang'),
      instruction: String(tts.instruction ?? ''),
    }
  }
  const parsed = JSON.parse(fs.readFileSync(tts.settingsPath ?? VOICE_SETTINGS_PATH, 'utf8'))
  const x = parsed.xiaomi ?? {}
  return {
    provider: String(parsed.provider ?? 'xiaomi'),
    apiKey: String(x.apiKey ?? ''),
    baseURL: String(x.baseURL ?? 'https://api.xiaomimimo.com/v1').replace(/\/+$/, ''),
    model: String(x.model ?? 'mimo-v2.5-tts'),
    voice: String(x.voice ?? 'BingTang'),
    instruction: String(x.instruction ?? ''),
  }
}

async function synthesizeLocal(text, tts = {}) {
  const s = readVoiceSettings(tts)
  if (s.provider !== 'xiaomi') throw new Error(`provider ${s.provider} not implemented locally`)
  if (!s.apiKey) throw new Error('no xiaomi api key in local-voice settings')

  const hash = crypto
    .createHash('sha1')
    .update(`${s.model}|${s.voice}|${s.instruction}|${text}`)
    .digest('hex')
  const cachePath = path.join(TTS_CACHE_DIR, `${hash}.wav`)
  try {
    const cached = fs.readFileSync(cachePath)
    if (cached.length > 1024) return cached
  } catch {
    /* cache miss */
  }

  const messages = []
  if (s.instruction.trim()) messages.push({ role: 'user', content: s.instruction.trim() })
  messages.push({ role: 'assistant', content: text })
  const voicedesign = s.model === 'mimo-v2.5-tts-voicedesign'
  const endpoint = s.apiKey.startsWith('tp-')
    ? 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions'
    : `${s.baseURL}/chat/completions`

  const upstream = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${s.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'dsh-watch-phone',
    },
    body: JSON.stringify({
      model: voicedesign ? 'mimo-v2.5-tts-voicedesign' : 'mimo-v2.5-tts',
      messages,
      audio: voicedesign ? { format: 'wav' } : { format: 'wav', voice: s.voice || 'BingTang' },
      stream: false,
    }),
    signal: AbortSignal.timeout(45000),
  })

  const raw = await upstream.text()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (!upstream.ok) {
    const detail = parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? raw.slice(0, 200)
    throw new Error(`mimo http ${upstream.status}: ${typeof detail === 'string' ? detail : ''}`)
  }
  const b64 = parsed?.choices?.[0]?.message?.audio?.data
  if (typeof b64 !== 'string' || !b64) throw new Error('mimo returned no audio')
  const buf = Buffer.from(b64, 'base64')
  if (!buf.length) throw new Error('mimo returned empty audio')
  try {
    fs.mkdirSync(TTS_CACHE_DIR, { recursive: true })
    fs.writeFileSync(cachePath, buf)
  } catch {
    /* cache is best effort */
  }
  return buf
}

/** Local IPv4 addresses (LAN only, no loopback). */
function localAddresses () {
  const out = []
  try {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address)
      }
    }
  } catch {
    /* best effort */
  }
  return out
}

/**
 * UDP broadcast beacon: the fastest way for a client on the same network to
 * find this bridge. A client broadcasts the probe string and gets back a JSON
 * document with the HTTP URLs to try. Unlike mDNS this needs no privileged
 * port, so it also works inside a phone-side container.
 *
 * @param {number} port HTTP port to advertise
 * @param {number} udpPort port to listen on
 * @param {(msg: string) => void} log
 * @param {() => string[]} [hosts] addresses to hand out (loopback while unpaired)
 * @returns {() => void} stop function
 */
function startUdpBeacon (port, udpPort, log, hosts = localAddresses) {
  const PROBE = 'dsh-watch?'
  let socket
  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  } catch (err) {
    log(`udp: cannot create socket (${err.message})`)
    return () => {}
  }

  socket.on('error', (err) => {
    log(`udp: socket error ${err.message}`)
  })

  socket.on('message', (msg, rinfo) => {
    try {
      if (!msg.length || msg.toString('utf8').trim() !== PROBE) return
      const urls = hosts().map((ip) => `http://${ip}:${port}`)
      const payload = JSON.stringify({ ok: true, service: 'dsh-watch-phone', port, urls })
      socket.send(payload, rinfo.port, rinfo.address, (err) => {
        if (err) log(`udp: reply failed ${err.message}`)
      })
      log(`udp: answered discovery from ${rinfo.address} -> ${urls.join(',')}`)
    } catch (err) {
      log(`udp: handler error ${err.message}`)
    }
  })

  socket.bind(udpPort, () => {
    try {
      socket.setBroadcast(true)
      log(`udp: discovery beacon listening on 0.0.0.0:${udpPort}`)
    } catch (err) {
      log(`udp: setBroadcast failed ${err.message}`)
    }
  })

  return () => {
    try { socket.close() } catch { /* ignore */ }
  }
}

/**
 * Minimal mDNS/DNS-SD responder so clients on the same network can find the
 * bridge without knowing an IP address. Publishes:
 *   PTR  _dsh-watch._tcp.local  -> <host>._dsh-watch._tcp.local
 *   SRV  <host>._dsh-watch._tcp.local  -> host, port
 *   TXT  <host>._dsh-watch._tcp.local  -> service=dsh-watch-phone, version=...
 *
 * This is a tiny implementation (no external dependency): it answers queries
 * addressed to 224.0.0.251:5353 for our instance. It is best-effort — when the
 * socket cannot be bound (no permission, port taken) we simply run without it.
 *
 * @param {number} port the HTTP port to advertise
 * @param {(msg: string) => void} log
 * @param {() => string[]} [hosts] addresses to publish (loopback while unpaired)
 * @returns {() => void} stop function
 */
function startMdnsResponder (port, log, hosts = localAddresses) {
  const MDNS_ADDR = '224.0.0.251'
  const MDNS_PORT = 5353
  const SERVICE_TYPE = '_dsh-watch._tcp.local'
  const instanceName = 'dsh-watch-phone'
  const hostName = instanceName + '.local'
  const TTL = 120

  function encodeName (name) {
    const parts = []
    for (const label of name.split('.')) {
      if (!label) continue
      parts.push(Buffer.from([label.length]), Buffer.from(label, 'utf8'))
    }
    parts.push(Buffer.from([0]))
    return Buffer.concat(parts)
  }

  function encodeTxt (entries) {
    const parts = []
    for (const entry of entries) {
      const b = Buffer.from(entry, 'utf8')
      parts.push(Buffer.from([b.length]), b)
    }
    return Buffer.concat(parts)
  }

  function parseQuestion (msg) {
    let offset = 12
    const labels = []
    while (offset < msg.length) {
      const len = msg[offset]
      if (len === 0) { offset += 1; break }
      if ((len & 0xc0) === 0xc0) { offset += 2; break }
      labels.push(msg.slice(offset + 1, offset + 1 + len).toString('utf8'))
      offset += 1 + len
    }
    if (offset + 4 > msg.length) return null
    return { name: labels.join('.'), qtype: msg.readUInt16BE(offset) }
  }

  const TXT = encodeTxt(['service=dsh-watch-phone', 'path=/watch'])

  function buildAnswer (question) {
    const name = question.name.toLowerCase()
    const instanceFqdn = instanceName + '.' + SERVICE_TYPE
    const isService = name === SERVICE_TYPE
    const isInstance = name === instanceFqdn
    const isHost = name === hostName
    const records = []

    const push = (type, owner, rdata) => {
      const header = Buffer.alloc(10)
      header.writeUInt16BE(type, 0)
      header.writeUInt16BE(1, 2)
      header.writeUInt32BE(TTL, 4)
      header.writeUInt16BE(rdata.length, 8)
      records.push(Buffer.concat([encodeName(owner), header, rdata]))
    }

    if (isService || question.qtype === 12) {
      push(12, SERVICE_TYPE, encodeName(instanceFqdn))
    }
    if (isService || isInstance) {
      const srv = Buffer.alloc(6)
      srv.writeUInt16BE(0, 0)
      srv.writeUInt16BE(0, 2)
      srv.writeUInt16BE(port, 4)
      push(33, instanceFqdn, Buffer.concat([srv, encodeName(hostName)]))
      push(16, instanceFqdn, TXT)
    }
    if (isHost) {
      for (const ip of hosts()) {
        const parts = ip.split('.').map((n) => Number(n))
        if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
          push(1, hostName, Buffer.from(parts))
        }
      }
    }
    return records
  }

  let socket
  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  } catch (err) {
    log(`mdns: cannot create socket (${err.message})`)
    return () => {}
  }

  socket.on('error', (err) => {
    log(`mdns: socket error ${err.message}`)
  })

  socket.on('message', (msg, rinfo) => {
    try {
      if (msg.length < 12) return
      if ((msg.readUInt16BE(2) & 0x8000) !== 0) return
      if (msg.readUInt16BE(4) < 1) return
      const question = parseQuestion(msg)
      if (!question) return
      const answers = buildAnswer(question)
      if (!answers.length) return

      const header = Buffer.alloc(12)
      header.writeUInt16BE(0, 0)
      header.writeUInt16BE(0x8400, 2)
      header.writeUInt16BE(0, 4)
      header.writeUInt16BE(answers.length, 6)
      header.writeUInt16BE(0, 8)
      header.writeUInt16BE(0, 10)

      socket.send(Buffer.concat([header, ...answers]), rinfo.port, rinfo.address, (err) => {
        if (err) log(`mdns: send failed ${err.message}`)
      })
    } catch (err) {
      log(`mdns: handler error ${err.message}`)
    }
  })

  socket.bind(MDNS_PORT, () => {
    try {
      socket.addMembership(MDNS_ADDR)
      socket.setMulticastTTL(255)
      socket.setMulticastLoopback(true)
      log(`mdns: advertising ${instanceName}.${SERVICE_TYPE} for port ${port}`)
    } catch (err) {
      log(`mdns: multicast join failed ${err.message}`)
    }
  })

  return () => {
    try { socket.close() } catch { /* ignore */ }
  }
}

/**
 * Auth is on by default, because everything behind it can drive a real DSH
 * session. A default install used to listen on 0.0.0.0 with an empty token and
 * therefore answered any device on the same Wi-Fi; a stranger could upload
 * audio to `/stt`, run `/chat`, and steer this host.
 *
 * Resolution order:
 *   1. `config.token` - the operator pinned one, so bind the LAN.
 *   2. `DATA_DIR/token` - one was minted on an earlier start: reuse it, stay on
 *      loopback until the operator pins it in the config.
 *   3. mint a fresh random token, persist it with mode 0600, log it, loopback.
 *
 * Loopback-only means a fresh install is never reachable from the network; to
 * open the LAN the operator copies the logged token into `config.token` and
 * into the watch app (`配对码`). The token never has a default value, so
 * "forgot to configure it" now fails closed instead of open.
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

export const name = 'dsh-watch-phone'

export function apply(ctx, config = {}) {
  const port = Number(config.port ?? DEFAULT_PORT)
  const proxyBase = typeof config.proxyBase === 'string' ? config.proxyBase : ''
  const discoveryPort = Number(config.discoveryPort ?? 38403)
  const tts = config.tts && typeof config.tts === 'object' ? config.tts : {}
  const DATA_DIR = process.env.DSH_WATCH_PHONE_DATA ?? path.join(os.homedir(), '.dsh', 'watch-phone')
  const logFile = config.logFile ?? path.join(DATA_DIR, 'bridge.log')

  // Shell access and raw TCP relaying are operator conveniences, not required by
  // the watch, so both are opt-in and a default install exposes chat + voice
  // only. An operator can also flip them at runtime from loopback with
  // `POST /config` (reachable over `adb forward`), and that choice is remembered
  // in DATA_DIR/settings.json.
  const settingsPath = path.join(DATA_DIR, 'settings.json')
  const runtime = { allowExec: config.allowExec === true, allowRelay: config.allowRelay === true }
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    if (typeof saved.allowExec === 'boolean') runtime.allowExec = saved.allowExec
    if (typeof saved.allowRelay === 'boolean') runtime.allowRelay = saved.allowRelay
  } catch {
    /* no saved settings yet */
  }
  const saveRuntime = () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(settingsPath, `${JSON.stringify(runtime, null, 2)}\n`)
    } catch {
      /* best effort */
    }
  }

  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
  } catch {
    /* best effort */
  }
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`
    try {
      fs.appendFileSync(logFile, line)
    } catch {
      /* ignore */
    }
  }

  log('apply() called')

  const auth = resolveToken({ configured: config.token, dataDir: DATA_DIR, log })
  const token = auth.token
  // Only an operator-pinned token opens the LAN; a minted one keeps us on
  // loopback, so an unconfigured install cannot be reached from the network.
  const bindHost = auth.source === 'config' ? '0.0.0.0' : '127.0.0.1'
  // A function, not an array: the beacon and the mDNS responder call it per probe,
  // so a LAN interface that appears after boot is picked up without a restart.
  const advertiseHosts = () => (bindHost === '0.0.0.0' ? localAddresses() : ['127.0.0.1'])

  const previous = globalThis[STATE_KEY]
  if (previous && typeof previous.close === 'function') {
    try {
      previous.close()
      log('closed previous server instance')
    } catch (err) {
      log(`close previous failed: ${err?.message ?? err}`)
    }
  }

  const RELAYS = new Map()

  const bridge = new WatchBridge({    ctx,
    log,
    sessionId: typeof config.sessionId === 'string' && config.sessionId ? config.sessionId : 'watch-voice',
    cwd: typeof config.cwd === 'string' && config.cwd ? config.cwd : process.cwd(),
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // Every probe is logged with the caller's address: it is the only reliable
    // way to tell which network path a watch or a desktop actually reached us
    // through when several interfaces are live at once.
    const caller = (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '')
    let finished = false
    res.on('finish', () => {
      finished = true
    })
    req.on('close', () => {
      if (!finished) log(`access: ${req.method} ${url.pathname} from ${caller} aborted`)
    })
    if (url.pathname !== '/log') log(`access: ${req.method} ${url.pathname} from ${caller}`)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      })
      res.end()
      return
    }

    if (url.pathname === '/health') {
      const stt = ctx.get('speechToText')
      sendJson(res, 200, {
        ok: true,
        service: 'dsh-watch-phone',
        host: os.hostname(),
        platform: `${os.platform()}/${os.arch()}`,
        uptime: Math.round(process.uptime()),
        stt: stt ? stt.snapshot?.()?.selection ?? 'ready' : 'unavailable',
        chat: {
          sessionId: bridge.sessionId,
          mode: bridge.agent !== null ? 'session' : bridge.agentUnavailable !== null ? 'direct' : 'pending',
          ...(bridge.agentUnavailable !== null ? { reason: bridge.agentUnavailable } : {}),
        },
        features: {
          exec: runtime.allowExec,
          relay: runtime.allowRelay,
          apk: fs.existsSync(APK_PATH),
          token: Boolean(token),
        },
      })
      return
    }

    if (url.pathname === '/log') {
      const lines = Math.min(Number(url.searchParams.get('lines') ?? 80) || 80, 500)
      let text = ''
      try {
        const raw = fs.readFileSync(logFile, 'utf8')
        text = raw.split('\n').slice(-lines).join('\n')
      } catch (err) {
        text = `log unavailable: ${err?.message ?? err}`
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(text)
      return
    }

    // Runtime switches, loopback only: the point of `allowExec` is that a remote
    // LAN client cannot turn it on, so an operator has to come through
    // `adb forward` (or a shell on the host) to do it.
    if (url.pathname === '/config') {
      const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
      if (peer !== '127.0.0.1' && peer !== '::1') {
        sendJson(res, 403, { ok: false, error: 'config is available from loopback only' })
        return
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...runtime, settings: settingsPath })
        return
      }
      if (req.method === 'POST') {
        const raw = (await readRaw(req, 1 << 16)).toString('utf8')
        let next = {}
        try {
          next = JSON.parse(raw || '{}')
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid json' })
          return
        }
        if (typeof next.allowExec === 'boolean') runtime.allowExec = next.allowExec
        if (typeof next.allowRelay === 'boolean') runtime.allowRelay = next.allowRelay
        saveRuntime()
        log(`config: allowExec=${runtime.allowExec} allowRelay=${runtime.allowRelay}`)
        sendJson(res, 200, { ok: true, ...runtime })
        return
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    // The bundle ships the watch app itself; hand it out so a new user can
    // `curl -O` it and `adb install -r` without hunting for a download page.
    if (url.pathname === '/watch/app.apk') {
      try {
        const stat = fs.statSync(APK_PATH)
        res.writeHead(200, {
          'content-type': 'application/vnd.android.package-archive',
          'content-length': String(stat.size),
          'content-disposition': 'attachment; filename="dsh-watch-chat.apk"',
        })
        fs.createReadStream(APK_PATH).pipe(res)
      } catch (err) {
        sendJson(res, 404, { ok: false, error: `apk not bundled: ${err?.message ?? err}` })
      }
      return
    }

    // Everything past this point costs money, touches the host, or drives a
    // real DSH session, so a bearer token is always required - including on a
    // fresh install where the token was minted rather than configured.
    {
      const header = req.headers.authorization ?? ''
      if (header !== `Bearer ${token}`) {
        sendJson(res, 401, {
          ok: false,
          error: 'unauthorized',
          hint: 'send Authorization: Bearer <token>; the token is in %DSH_WATCH_PHONE_DATA%/token or the bridge log',
        })
        return
      }
    }

    try {
      if (url.pathname === '/chat' && req.method === 'POST') {
        const raw = (await readRaw(req)).toString('utf8')
        let text = ''
        try {
          text = String(JSON.parse(raw || '{}').text ?? '').trim()
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid json' })
          return
        }
        if (!text) {
          sendJson(res, 400, { ok: false, error: 'empty text' })
          return
        }
        log(`chat: ${text.slice(0, 80)}`)
        const reply = await bridge.deliver(text)
        sendJson(res, 200, { ok: true, reply })
        return
      }

      if (url.pathname === '/relay' && req.method === 'POST') {
        if (!runtime.allowRelay) {
          sendJson(res, 403, {
            ok: false,
            error: 'relay disabled; enable it with allowRelay: true or POST /config from loopback',
          })
          return
        }
        const raw = (await readRaw(req, 1 << 16)).toString('utf8')

        let spec = {}
        try {
          spec = JSON.parse(raw || '{}')
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid json' })
          return
        }
        const listenPort = Number(spec.port ?? 0)
        const targetPort = Number(spec.targetPort ?? 0)
        const targetHost = String(spec.targetHost ?? '')
        if (!listenPort || !targetPort || !targetHost) {
          sendJson(res, 400, { ok: false, error: 'need port, targetHost, targetPort' })
          return
        }
        const existing = RELAYS.get(listenPort)
        if (existing) {
          sendJson(res, 200, { ok: true, status: 'already', port: listenPort })
          return
        }
        const relay = net.createServer((client) => {
          const upstream = net.connect(targetPort, targetHost)
          client.on('error', () => upstream.destroy())
          upstream.on('error', () => client.destroy())
          client.pipe(upstream)
          upstream.pipe(client)
        })
        relay.on('error', (err) => log(`relay ${listenPort}: ${err?.message ?? err}`))
        relay.listen(listenPort, '0.0.0.0', () => log(`relay ${listenPort} -> ${targetHost}:${targetPort}`))
        RELAYS.set(listenPort, relay)
        sendJson(res, 200, { ok: true, status: 'started', port: listenPort, target: `${targetHost}:${targetPort}` })
        return
      }

      if (url.pathname === '/relay' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ports: [...RELAYS.keys()] })
        return
      }

      if (url.pathname === '/exec' && req.method === 'POST') {
        if (!runtime.allowExec) {
          sendJson(res, 403, {
            ok: false,
            error: 'exec disabled; enable it with allowExec: true or POST /config from loopback',
          })
          return
        }
        const raw = (await readRaw(req, 1 << 20)).toString('utf8')

        let cmd = ''
        try {
          cmd = String(JSON.parse(raw || '{}').cmd ?? '')
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid json' })
          return
        }
        if (!cmd.trim()) {
          sendJson(res, 400, { ok: false, error: 'empty cmd' })
          return
        }
        log(`exec: ${cmd.slice(0, 120)}`)
        const started = Date.now()
        try {
          const { stdout, stderr } = await execAsync(cmd, {
            shell: '/bin/bash',
            timeout: 180000,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/usr/local/bin:/usr/bin:/bin` },
          })
          sendJson(res, 200, {
            ok: true,
            code: 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            ms: Date.now() - started,
          })
        } catch (err) {
          sendJson(res, 200, {
            ok: false,
            code: err?.code ?? 1,
            stdout: String(err?.stdout ?? ''),
            stderr: String(err?.stderr ?? err?.message ?? String(err)),
            ms: Date.now() - started,
          })
        }
        return
      }

      if (url.pathname === '/reset' && req.method === 'POST') {
        bridge.reset()
        log('reset')
        sendJson(res, 200, { ok: true })
        return
      }

      if (url.pathname === '/stt' && req.method === 'POST') {
        const body = await readRaw(req, MAX_AUDIO_BYTES)
        let audio
        try {
          if ((req.headers['content-type'] ?? '').includes('multipart/form-data')) {
            audio = multipartPart(body, req.headers['content-type'], 'audio').body
          } else {
            audio = body
          }
        } catch (err) {
          log(`stt: bad body: ${err?.message ?? err}`)
          sendJson(res, 400, { ok: false, error: err?.message ?? 'bad body' })
          return
        }

        log(`stt: received ${audio.length} bytes (${req.headers['content-type'] ?? 'raw'})`)
        // Keep the newest recordings around: when recognition goes wrong on real
        // speech, re-running the exact bytes through different settings is the
        // only way to tell a microphone problem from a model problem.
        try {
          const keep = path.join(DATA_DIR, 'rec')
          fs.mkdirSync(keep, { recursive: true })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          fs.writeFileSync(path.join(keep, `${stamp}.wav`), audio)
          const old = fs.readdirSync(keep).filter((f) => f.endsWith('.wav')).sort().slice(0, -8)
          for (const f of old) fs.unlinkSync(path.join(keep, f))
        } catch (err) {
          log(`stt: could not archive recording: ${err?.message ?? err}`)
        }
        try {
          const out = await bridge.transcribe(audio, url.searchParams.get('language') ?? undefined)
          sendJson(res, 200, {
            ok: true,
            text: out.text,
            bytes: audio.length,
            language: out.language,
            seconds: out.seconds,
            peak: out.peak,
            gain: out.gain,
          })
        } catch (err) {
          const message = err?.message ?? String(err)
          log(`stt: local failed: ${message} head=${audio.subarray(0, 44).toString('hex')} len=${audio.length}`)
          if (proxyBase) {
            log('stt: falling back to proxy')
            proxyTo(proxyBase, url.pathname + url.search, req, res, log)
            return
          }
          sendJson(res, 500, { ok: false, error: message })
        }
        return
      }

      if (url.pathname === '/tts' && req.method === 'POST') {
        const raw = (await readRaw(req, 1 << 20)).toString('utf8')
        let text = ''
        try {
          text = String(JSON.parse(raw || '{}').text ?? '').trim()
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid json' })
          return
        }
        if (!text) {
          sendJson(res, 400, { ok: false, error: 'empty text' })
          return
        }
        try {
          const audio = await synthesizeLocal(text, tts)
          log(`tts: local mimo ${audio.length} bytes for ${text.slice(0, 40)}`)
          res.writeHead(200, {
            'content-type': 'audio/wav',
            'content-length': String(audio.length),
            'x-tts-source': 'xiaomi-mimo',
          })
          res.end(audio)
        } catch (err) {
          const message = err?.message ?? String(err)
          log(`tts: local failed (${message}), falling back to proxy`)
          if (!proxyBase) {
            sendJson(res, 502, { ok: false, error: message })
            return
          }
          proxyTo(proxyBase, url.pathname + url.search, req, res, log)
        }
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      const message = err?.message ?? String(err)
      log(`error: ${message}`)
      sendJson(res, 500, { ok: false, error: message })
    }
  })

  server.on('error', (err) => {
    log(`server error: ${err?.message ?? err}`)
  })

  let stopMdns = () => {}
  let stopBeacon = () => {}

  server.listen(port, bindHost, () => {
    log(`server listening on ${bindHost}:${port}`)
    stopMdns = startMdnsResponder(port, log, advertiseHosts)
    stopBeacon = startUdpBeacon(port, discoveryPort, log, advertiseHosts)
    if (bindHost === '0.0.0.0') {
      const nets = os.networkInterfaces()
      for (const [name, addrs] of Object.entries(nets)) {
        for (const addr of addrs ?? []) {
          if (addr.family === 'IPv4' && !addr.internal) {
            log(`  LAN: http://${addr.address}:${port}  (${name})`)
          }
        }
      }
    } else {
      log(`  loopback only: http://127.0.0.1:${port} (adb forward tcp:${port} tcp:${port}); set config.token to serve the LAN`)
    }
  })

  globalThis[STATE_KEY] = {
    server,
    close() {
      try {
        server.close()
      } catch {
        /* ignore */
      }
    },
  }

  ctx.on('dispose', () => {
    log('dispose: closing server')
    try {
      stopMdns()
    } catch {
      /* ignore */
    }
    try {
      stopBeacon()
    } catch {
      /* ignore */
    }
    try {
      server.close()
    } catch {
      /* ignore */
    }
    if (globalThis[STATE_KEY]?.server === server) {
      delete globalThis[STATE_KEY]
    }
  })
}
