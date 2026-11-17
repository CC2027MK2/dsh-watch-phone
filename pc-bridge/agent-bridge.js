/**
 * dsh-watch-draft / agent-bridge.js
 * One watch chat bound to one in-memory conversation on the host LLM runtime.
 *
 * Design note: this plugin is `link:`-mounted from a workspace path, so bare
 * `@deepseek-ai/*` imports do NOT resolve here. Instead of building a full DSH
 * Agent (which needs `createUserMessage`/`installModelSelection` from those
 * packages), the bridge talks to the `llm` service directly and keeps its own
 * short history. That is all a watch chat needs: no tools, no session log.
 */

/** @module dsh-watch-draft/agent-bridge */

const MAX_HISTORY = 24

export class AgentBridge {
  /**
   * @param {Object} options
   * @param {any} options.ctx            Cordis context of the plugin.
   * @param {(msg: string) => void} [options.log]
   * @param {string} [options.provider]
   * @param {string} [options.model]
   * @param {string} [options.system]    Optional system prompt.
   */
  constructor(options) {
    this.ctx = options.ctx
    this.log = options.log ?? (() => {})
    this.sessionId = options.sessionId ?? 'watch-main'
    this.provider = options.provider
    this.model = options.model
    this.system =
      options.system ??
      '你是运行在这台电脑上的 DSH 助手的语音通道。用户在智能手表上用语音跟你说话，' +
      '回答会被朗读出来。请用简洁口语化的中文回答，通常一到三句话，不要使用 Markdown、' +
      '列表、代码块或链接，除非用户明确要求。'
    /** @type {{role: 'user'|'assistant', content: {type:'text',text:string}[]}[]} */
    this.history = []
    this.busy = false
    /** @type {{text: string, resolve: (v: string) => void, reject: (e: any) => void}[]} */
    this.queue = []
  }

  #llm() {
    const llm = this.ctx.get('llm')
    if (!llm) throw new Error('llm service not available in this DSH host')
    return llm
  }

  /** Resolve the provider/model route: explicit config, else the host default. */
  #route() {
    if (this.provider && this.model) {
      return { provider: this.provider, model: this.model }
    }
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

  /**
   * Send one user message and resolve with the model's reply text.
   * @param {string} text
   * @returns {Promise<string>}
   */
  async deliver(text) {
    if (this.busy) {
      return new Promise((resolve, reject) => {
        this.queue.push({ text, resolve, reject })
      })
    }
    this.busy = true
    try {
      const reply = await this.#turn(text)
      return reply
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
    const llm = this.#llm()
    const route = this.#route()
    this.history.push({ role: 'user', content: [{ type: 'text', text }] })

    const started = Date.now()
    this.log(`turn: start provider=${route.provider} model=${route.model} history=${this.history.length}`)

    let out = ''
    let finishReason
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        messages: this.history,
        ...(this.system ? { system: this.system } : {}),
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
        else if (chunk?.type === 'finish') finishReason = chunk.reason
      }
    } catch (err) {
      // drop the unanswered user turn so the conversation stays replayable
      this.history.pop()
      throw err
    }

    out = out.trim()
    this.log(`turn: reply ${out.length} chars in ${Date.now() - started}ms (finish=${finishReason ?? 'none'})`)
    if (!out) {
      this.history.pop()
      throw new Error(`empty reply from model (finish=${finishReason ?? 'none'})`)
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

  /** Clear the in-memory conversation. */
  reset() {
    this.history = []
  }

  async dispose() {
    this.history = []
    this.queue = []
  }
}
