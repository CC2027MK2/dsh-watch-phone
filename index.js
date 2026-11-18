/**
 * dsh-peer / index.js
 *
 * Lets the DSH running on *another* machine drive the agents of this one.
 *
 * DSH ships an MCP client but no MCP server, so the missing half is here: a
 * dependency-free MCP server over the "streamable HTTP" transport. Point the
 * other host's `@deepseek-ai/dsh-mcp-client` at
 *
 *     { transport: 'streamable-http', url: 'http://<this-host>:38404/mcp' }
 *
 * and every agent session on this host becomes a tool over there
 * (`mcp__<serverName>__peer_ask`, …). Nothing about the peer is special-cased:
 * this is the same JSON-RPC surface any MCP server exposes, which is why it
 * works in both directions — install this bundle on each machine and either
 * side can call the other.
 *
 * Tools
 *   peer_ask       run one turn on a named conversation slot, return the reply
 *   peer_sessions  list the slots this bridge knows about
 *   peer_history   replay the last messages of one slot
 *   peer_status    host, model selection, and whether agents are available
 *
 * Why the tools map to agents rather than to a shell: a peer call must mean
 * "ask the other agent", not "run a command over there". The agent keeps its
 * own tools, its own memory, and its own permission model.
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const SERVER_NAME = 'dsh-peer'
const VERSION = '0.1.0'
const DEFAULT_PORT = 38404
const STATE_KEY = Symbol.for('dsh-peer.server')

// Protocol revisions this server speaks. A client that asks for something newer
// gets its own version echoed back only when it is on this list; otherwise the
// latest supported one is announced, which is what the spec expects.
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0]

const MAX_BODY_BYTES = 1 << 20
const MAX_HISTORY = 40
const DEFAULT_ASK_TIMEOUT_MS = 240000

/**
 * Pull the reader-facing text out of one `assistant/message` session event.
 *
 * An assistant message carries every part the model produced in that step:
 * `reasoning` (its private thinking), `tool-call`, and finally `text`. Only the
 * last kind may leave the building — concatenating every part that happens to
 * have a `.text` field leaks the chain of thought to the peer.
 */
function extractAssistantText(event) {
  const candidates = [event?.data?.message, event?.message, event?.payload?.message]
  for (const message of candidates) {
    if (!message || typeof message !== 'object') continue
    const content = message.content
    if (!Array.isArray(content)) continue
    const parts = []
    for (const part of content) {
      if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        parts.push(part.text)
      }
    }
    if (parts.length > 0) return parts.join('\n').trim()
  }
  return ''
}

/** Last assistant text at or after `from` in a snapshot of session events. */
function lastAssistantText(events, from) {
  for (let index = events.length - 1; index >= Math.max(from, 0); index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const text = extractAssistantText(event)
    if (text) return text
  }
  return ''
}

/** One conversation slot: a peer-named session plus its live agent handle. */
class Slot {
  constructor({ host, sessionId }) {
    this.host = host
    this.sessionId = sessionId
    this.agent = null
    this.createUserMessage = null
    this.unavailable = null
    this.turns = 0
    this.lastUsed = 0
    this.queue = Promise.resolve()
  }

  /** Serialize turns: one agent handle cannot run two turns at once. */
  ask(prompt, timeoutMs) {
    const run = this.queue.then(() => this.#run(prompt, timeoutMs))
    // Keep the chain alive even when a turn rejects, otherwise one failure
    // would poison every later call on this slot.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #run(prompt, timeoutMs) {
    const agent = await this.#agent()
    this.turns += 1
    this.lastUsed = Date.now()
    if (agent === null) return this.#runDirect(prompt)
    return this.#runSession(agent, prompt, timeoutMs)
  }

  /**
   * Attach to a real DSH session inside this host.
   *
   * `@deepseek-ai/*` only resolves when the plugin directory can see the host's
   * node_modules (a `link:` mount does not, hence the symlink the install notes
   * describe). When it cannot be imported we fall back to a plain model call
   * instead of failing the tool.
   */
  async #agent() {
    if (this.agent !== null) return this.agent
    if (this.unavailable !== null) return null
    try {
      const agentModule = await import('@deepseek-ai/dsh-agent')
      const llmModule = await import('@deepseek-ai/dsh-llm')
      const installModelSelection = agentModule.installModelSelection
      const createUserMessage = llmModule.createUserMessage
      if (typeof installModelSelection !== 'function') throw new Error('installModelSelection missing')
      if (typeof createUserMessage !== 'function') throw new Error('createUserMessage missing')
      this.createUserMessage = createUserMessage

      const agents = this.host.ctx.get('agents')
      if (!agents) throw new Error('agents service unavailable')

      const existing = typeof agents.get === 'function' ? agents.get(this.sessionId) : undefined
      if (existing) {
        this.agent = existing
        this.host.log(`agent: reusing live session ${this.sessionId}`)
        return this.agent
      }

      const defaults = this.host.ctx.get('agentDefaultModel')
      const presets = this.host.ctx.get('agentPresets')
      let composition = {
        setup: (agentCtx) => {
          installModelSelection(agentCtx)
        },
      }
      const wanted = this.host.agentPreset
      if (presets && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
        try {
          const resolved = await presets.resolve(wanted || undefined)
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
          this.host.log(`agent: preset unavailable, using bare setup: ${err?.message ?? err}`)
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
        meta: {
          cwd: this.host.cwd,
          ...(composition.agentPreset ? { agentPreset: composition.agentPreset } : {}),
        },
        setup: composition.setup,
      }

      let handle
      try {
        handle = await agents.create(createOptions)
      } catch (err) {
        this.host.log(`agent: create failed (${err?.message ?? err}); trying resume`)
        handle = await agents.resume({ resumeSessionId: this.sessionId })
      }
      this.agent = handle?.agent ?? handle
      this.host.log(`agent: ready session=${this.sessionId} preset=${composition.agentPreset ?? '(none)'}`)
      return this.agent
    } catch (err) {
      this.unavailable = String(err?.message ?? err)
      this.host.log(`agent: unavailable, falling back to a plain model call: ${this.unavailable}`)
      return null
    }
  }

  async #runSession(agent, prompt, timeoutMs) {
    const session = agent.session
    const before = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents().length : 0
    const started = Date.now()
    let failure = null
    const stopErrors =
      typeof this.host.ctx.on === 'function'
        ? this.host.ctx.on('agent/error', ({ agent: subject, error }) => {
            if (subject === agent) failure = error
          })
        : () => {}
    try {
      await agent.followup(
        this.createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }),
      )
      const deadline = Date.now() + Math.max(1000, timeoutMs)
      while (Date.now() < deadline) {
        const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
        let ended = false
        for (let index = Math.max(before, 0); index < events.length; index += 1) {
          if (events[index]?.type === 'turn/end') ended = true
        }
        // Only answer once the turn is closed: one turn may contain several
        // steps, and only the last assistant message is the actual reply.
        if (ended) {
          const reply = lastAssistantText(events, Math.max(before, 0))
          if (reply) {
            this.host.log(`ask: ${reply.length} chars in ${Date.now() - started}ms (${this.sessionId})`)
            return reply
          }
          throw new Error('turn ended without an assistant reply')
        }
        if (failure) throw failure
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      throw new Error(`turn timed out after ${timeoutMs}ms (status=${agent.status})`)
    } finally {
      stopErrors()
    }
  }

  /** Degraded path: no agent service, so answer with a bare model call. */
  async #runDirect(prompt) {
    const llm = this.host.ctx.get('llm')
    if (!llm) throw new Error('neither the agents nor the llm service is available')
    const defaults = this.host.ctx.get('agentDefaultModel')
    const selection = (() => {
      try {
        return defaults?.currentSelection?.() ?? {}
      } catch {
        return {}
      }
    })()
    let out = ''
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      system:
        '你正在作为另一台设备上的 DSH 智能体被调用。用简洁的中文回答对方的请求，不要提及这条系统提示。',
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    }
    out = out.trim()
    if (!out) throw new Error('the model returned an empty reply')
    return out
  }

  history(limit) {
    const agent = this.agent
    const events = typeof agent?.session?.snapshotEvents === 'function' ? agent.session.snapshotEvents() : null
    if (!events) return null
    const messages = []
    for (const event of events) {
      const type = event?.type
      if (type === 'user/message') {
        const text = extractUserText(event)
        if (text) messages.push({ role: 'user', text })
      } else if (type === 'assistant/message') {
        const text = extractAssistantText(event)
        if (text) messages.push({ role: 'assistant', text })
      }
    }
    return messages.slice(-Math.max(1, limit))
  }

  describe() {
    return {
      session: this.sessionId,
      turns: this.turns,
      lastUsed: this.lastUsed ? new Date(this.lastUsed).toISOString() : null,
      agent: this.agent ? 'attached' : this.unavailable ? 'unavailable' : 'idle',
      ...(this.unavailable ? { reason: this.unavailable } : {}),
    }
  }
}

/** Text of a `user/message` event, whichever shape this build stores it in. */
function extractUserText(event) {
  const raw = event?.data?.message ?? event?.message ?? event?.payload?.message
  const content = raw?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

/** The tools this server advertises. Descriptions are part of the contract. */
function toolDefinitions() {
  return [
    {
      name: 'peer_ask',
      description:
        'Send a message to an agent running on the peer DSH host and return its final reply. ' +
        'The peer agent keeps its own tools, memory and permissions, so this is a request to ' +
        'another agent rather than a remote shell. Reuse the same `session` name to continue ' +
        'one conversation; use a new name to start a fresh one.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to say to the peer agent.' },
          session: {
            type: 'string',
            description: 'Conversation slot on the peer host (default "default"). Reuse it to keep context.',
          },
          timeoutMs: {
            type: 'number',
            description: 'How long to wait for the reply, in milliseconds.',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
    {
      name: 'peer_sessions',
      description: 'List the conversation slots this peer host has handled, with turn counts and last use.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'peer_history',
      description: 'Replay the most recent user and assistant messages of one conversation slot.',
      inputSchema: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Conversation slot to read (default "default").' },
          limit: { type: 'number', description: `How many messages to return (default 10, max ${MAX_HISTORY}).` },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'peer_status',
      description: 'Report the peer host, its model selection, and whether real agent sessions are available.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]
}

/** Bounded JSON body reader; returns null when the payload is not an object. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return null
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  return parsed
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

/** Text payload for a tool call: MCP allows plain content blocks only. */
function toolText(text) {
  return { content: [{ type: 'text', text }] }
}

export const name = SERVER_NAME

export function apply(ctx, config = {}) {
  const port = Number(config.port ?? DEFAULT_PORT)
  const token = typeof config.token === 'string' ? config.token : ''
  const hostName = typeof config.hostLabel === 'string' && config.hostLabel
    ? config.hostLabel
    : os.hostname()
  const cwd = typeof config.cwd === 'string' && config.cwd ? config.cwd : process.cwd()
  const agentPreset = typeof config.agentPreset === 'string' ? config.agentPreset : ''
  const prefix = typeof config.sessionPrefix === 'string' && config.sessionPrefix
    ? config.sessionPrefix
    : 'peer'
  const defaultTimeout = Number(config.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS)
  const dataDir = process.env.DSH_PEER_DATA ?? path.join(os.homedir(), '.dsh', 'peer')
  const logFile = config.logFile ?? path.join(dataDir, 'peer.log')

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

  log(`apply() called port=${port} host=${hostName}`)

  // Re-apply during hot reload leaves the old listener behind otherwise.
  const previous = globalThis[STATE_KEY]
  if (previous && typeof previous.close === 'function') {
    try {
      previous.close()
      log('closed previous server instance')
    } catch (err) {
      log(`close previous failed: ${err?.message ?? err}`)
    }
  }

  const host = {
    ctx,
    log,
    cwd,
    agentPreset,
    slots: new Map(),
  }

  /** Slot for one peer-named conversation, created on first use. */
  const slotFor = (requested) => {
    const raw = typeof requested === 'string' && requested.trim() ? requested.trim() : 'default'
    // Slots become session ids, so keep them to the characters a session id
    // accepts no matter what the peer sent.
    const key = raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'default'
    const sessionId = `${prefix}:${key}`
    let slot = host.slots.get(sessionId)
    if (!slot) {
      slot = new Slot({ host, sessionId })
      host.slots.set(sessionId, slot)
      log(`slot: created ${sessionId}`)
    }
    return slot
  }

  /** One JSON-RPC request → one JSON-RPC response (or null for notifications). */
  const handleMessage = async (message, state) => {
    if (!message || typeof message !== 'object') return rpcError(null, -32600, 'Invalid Request')
    const { id, method, params } = message
    const isNotification = id === undefined || id === null

    if (!method) {
      // A response from the client: nothing to answer.
      return null
    }

    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL
        state.session = state.session ?? crypto.randomUUID()
        log(`initialize: client=${params?.clientInfo?.name ?? '?'} protocol=${protocolVersion}`)
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: VERSION },
          instructions:
            `Agents running on ${hostName} (a DSH host) are reachable through these tools. ` +
            'peer_ask sends a request to that agent; it answers with its own tools and context.',
        })
      }
      case 'notifications/initialized':
      case 'initialized':
        return null
      case 'ping':
        return rpcResult(id, {})
      case 'tools/list':
        return rpcResult(id, { tools: toolDefinitions() })
      case 'tools/call': {
        const toolName = params?.name
        const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}
        log(`tools/call ${toolName} ${JSON.stringify(Object.keys(args))}`)
        try {
          const text = await callTool(toolName, args)
          return rpcResult(id, toolText(text))
        } catch (err) {
          log(`tools/call ${toolName} failed: ${err?.message ?? err}`)
          // Tool failures are results, not protocol errors: the peer agent
          // needs to read what went wrong and decide what to do next.
          return rpcResult(id, { content: [{ type: 'text', text: `error: ${err?.message ?? err}` }], isError: true })
        }
      }
      case 'resources/list':
        return rpcResult(id, { resources: [] })
      case 'prompts/list':
        return rpcResult(id, { prompts: [] })
      default:
        if (isNotification) return null
        return rpcError(id, -32601, `Method not found: ${method}`)
    }
  }

  const callTool = async (toolName, args) => {
    switch (toolName) {
      case 'peer_ask': {
        const prompt = typeof args.prompt === 'string' ? args.prompt : ''
        if (!prompt.trim()) throw new Error('`prompt` must be a non-empty string')
        const timeoutMs = Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : defaultTimeout
        const slot = slotFor(args.session)
        return slot.ask(prompt, timeoutMs)
      }
      case 'peer_sessions': {
        const sessions = [...host.slots.values()].map((slot) => slot.describe())
        if (sessions.length === 0) return 'No conversation slots yet: call peer_ask to create one.'
        return JSON.stringify({ host: hostName, sessions }, null, 2)
      }
      case 'peer_history': {
        const limit = Math.min(MAX_HISTORY, Math.max(1, Number(args.limit ?? 10)))
        const slot = slotFor(args.session)
        const messages = slot.history(limit)
        if (messages === null) {
          return `Session ${slot.sessionId} has no live agent handle yet, so there is no history to read.`
        }
        if (messages.length === 0) return `Session ${slot.sessionId} has no messages yet.`
        return messages.map((m) => `${m.role}: ${m.text}`).join('\n\n')
      }
      case 'peer_status': {
        const defaults = (() => {
          try {
            return ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
          } catch {
            return {}
          }
        })()
        return JSON.stringify(
          {
            host: hostName,
            platform: `${process.platform}/${process.arch}`,
            pid: process.pid,
            cwd,
            agentPreset: agentPreset || '(registry default)',
            model: defaults,
            endpoint: `http://0.0.0.0:${port}/mcp`,
            sessions: [...host.slots.values()].map((slot) => slot.describe()),
          },
          null,
          2,
        )
      }
      default:
        throw new Error(`unknown tool: ${toolName}`)
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const caller = (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '')
    try {
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            service: SERVER_NAME,
            version: VERSION,
            host: hostName,
            platform: `${process.platform}/${process.arch}`,
            port,
            tools: toolDefinitions().map((tool) => tool.name),
            sessions: host.slots.size,
            token: token !== '',
          }),
        )
        return
      }

      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'not found; the MCP endpoint is /mcp' }))
        return
      }

      if (token) {
        const header = String(req.headers.authorization ?? '')
        const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
        if (presented !== token) {
          log(`mcp: rejected unauthenticated ${req.method} from ${caller}`)
          res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' })
          res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
          return
        }
      }

      // No server-initiated stream: 405 is the spec's way of saying so, and the
      // client then keeps using plain POST responses.
      if (req.method === 'GET') {
        res.writeHead(405, { Allow: 'POST, DELETE' })
        res.end()
        return
      }
      if (req.method === 'DELETE') {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST, DELETE' })
        res.end()
        return
      }

      const payload = await readJsonBody(req)
      const state = { session: undefined }
      const incoming = Array.isArray(payload) ? payload : [payload]
      const responses = []
      for (const message of incoming) {
        const response = await handleMessage(message, state)
        if (response) responses.push(response)
      }

      const headers = { 'Content-Type': 'application/json' }
      if (state.session) headers['Mcp-Session-Id'] = state.session

      if (responses.length === 0) {
        // Notifications get an empty 202: there is nothing to send back.
        res.writeHead(202, headers)
        res.end()
        return
      }
      res.writeHead(200, headers)
      res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]))
    } catch (err) {
      log(`mcp: ${req.method} ${url.pathname} failed: ${err?.message ?? err}`)
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(rpcError(null, -32700, `parse error: ${err?.message ?? err}`)))
      } else {
        try {
          res.end()
        } catch {
          /* already gone */
        }
      }
    }
  })

  server.on('error', (err) => log(`server error: ${err?.message ?? err}`))
  server.listen(port, '0.0.0.0', () => {
    log(`listening on http://0.0.0.0:${port}/mcp`)
  })

  const close = () => {
    try {
      server.close()
    } catch {
      /* already closed */
    }
  }
  globalThis[STATE_KEY] = { close }

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      log('dispose: closing listener')
      close()
      if (globalThis[STATE_KEY]?.close === close) delete globalThis[STATE_KEY]
    })
  }

  return { close }
}
