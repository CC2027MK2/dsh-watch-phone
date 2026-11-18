# dsh-peer

Let two DeepSeek Harness installations talk to each other.

`dsh-peer` is a **zero-dependency MCP server** that exposes the local agent as four
MCP tools. Combined with the stock `@deepseek-ai/dsh-mcp-client`, it turns
"my laptop's agent" and "my phone's agent" into two peers that can ask each other
questions over the LAN — no cloud relay, no shared session file.

```
   PC (DSH desktop)                          Phone (DSH Go)
┌──────────────────────────┐             ┌──────────────────────────┐
│ agent                    │             │ agent                    │
│   │ tools                │             │   │ tools                │
│   ├─ @deepseek-ai/       │  MCP/HTTP   │   ├─ dsh-peer            │
│   │  dsh-mcp-client ─────┼────────────▶│   │  POST /mcp  :38404   │
│   │  (serverName: phone) │             │   │  → agent.session     │
│   └──────────────────────┘             │   └──────────────────────┘
│ dsh-peer  POST /mcp :38404 ◀───────────┼───── dsh-mcp-client      │
└──────────────────────────┘  MCP/HTTP   └──────────────────────────┘
```

Either side may run `dsh-peer`, either side may run the client, and one side can
do both (that is how the diagram above is wired).

## What you get

| Tool (raw name) | Purpose | Input |
| --- | --- | --- |
| `peer_ask` | Send a prompt to the peer's agent and wait for its answer | `prompt` (string), `session` (optional), `timeoutMs` (optional) |
| `peer_sessions` | List conversation slots and their turn counts | – |
| `peer_history` | Read back the last messages of one slot | `session` (optional), `limit` (optional) |
| `peer_status` | Host, platform, pid, cwd, current model of the peer | – |

Through `dsh-mcp-client` these become `mcp__<serverName>__peer_ask` and friends,
for example `mcp__phone__peer_ask` on the PC and `mcp__pc__peer_ask` on the phone.

Each `session` value is a **separate conversation** on the peer: the peer keeps
one DSH session per slot (`peer:default`, `peer:review`, …) so a review thread does
not inherit the small-talk context. Calls within one slot are serialised, different
slots run in parallel.

## Install

### On a desktop profile

```bash
npm pack                      # produces dsh-peer-0.1.0.tgz
dsh plugin --profile desktop install ./dsh-peer-0.1.0.tgz
```

or, from an agent that has the plugin manager:

```text
plugin_manager install_bundle target="file:C:\path\to\dsh-peer-0.1.0.tgz"
```

A bundle patch installs the server row (`id: dsh-peer`, `port: 38404`) and takes
effect without restarting the app.

### On DSH Go (phone)

Copy the package into the phone's plugin directory and register the bundle:

```bash
# phone-side, inside the Go runtime
mkdir -p /root/.dsh/dsh-go/plugins/dsh-peer
tar xzf dsh-peer-0.1.0.tgz -C /tmp && cp -a /tmp/package/. /root/.dsh/dsh-go/plugins/dsh-peer/
node --check /root/.dsh/dsh-go/plugins/dsh-peer/index.js
```

Then in `/root/.dsh/profiles/web/package.json` add the dependency and the bundle:

```json
"dependencies": { "dsh-peer": "link:/root/.dsh/dsh-go/plugins/dsh-peer" },
"dsh": { "profile": { "bundles": ["...", "dsh-peer"] } }
```

**Two hard requirements on DSH Go** — both cost an afternoon if you miss them:

1. `link:` dependencies do **not** create the node_modules link. Do it yourself, or the
   app logs `dsh: skipping profile bundle "dsh-peer": cannot resolve profile bundle`:

   ```bash
   ln -sfn ../../../dsh-go/plugins/dsh-peer /root/.dsh/profiles/web/node_modules/dsh-peer
   ```

2. Anything you mount by package **name** (for example
   `@deepseek-ai/dsh-mcp-client`) must be resolvable from the *profile* directory.
   The Go runtime keeps its packages under `/opt/dsh/node_modules`, which Node never
   walks to, so link the packages you need:

   ```bash
   ln -sfn /opt/dsh/node_modules/@deepseek-ai/dsh-mcp-client \
          /root/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-mcp-client
   ```

   Verify with `node -e "import('@deepseek-ai/dsh-mcp-client').then(()=>console.log('ok'))"`
   **run from the profile directory**.

### Wiring the client

Add one row to the profile's `cordis.patch.yml`. The patch file is a list of patch
operations, so a **new** entry must be wrapped in `insert:` — a bare `- id: my-row`
is rejected with `patch: entry "my-row" not found`:

```yaml
- insert:
    - id: peer-phone
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: phone                 # → mcp__phone__* tools
        transport: streamable-http
        url: http://203.0.113.42:38404/mcp  # the peer's LAN address
        toolCallTimeoutMs: 600000          # the peer may wait on a human approval
```

Check what the loader actually composed before restarting:

```bash
dsh --profile web --dump-config | grep -A6 'peer-phone'
```

A desktop install composes its patch list **at boot**; a fresh row needs an app
restart. DSH Go re-composes on every app start, so a phone-side restart is enough.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `38404` | HTTP port for `/mcp` |
| `host` | `0.0.0.0` | Bind address |
| `token` | `''` | When set, every request needs `Authorization: Bearer <token>` |
| `sessionPrefix` | `peer` | Slot ids are `<prefix>:<session>` |
| `askTimeoutMs` | `240000` | Default wait inside `peer_ask` |
| `cwd` | `process.cwd()` | Working directory for peer sessions |
| `logFile` | `<data dir>/peer.log` | Append-only log next to `health`, `initialize`, `tools/call` |

## Verify a peer without any agent

`tools/mcp-probe.mjs` is a 100-line MCP client with no dependencies:

```bash
node tools/mcp-probe.mjs http://203.0.113.42:38404/mcp "介绍一下你自己"
```

It prints `initialize`, `tools/list`, `peer_status`, `peer_history`, a `peer_ask`
round-trip and the sessions table. On a healthy peer you get one `peer_ask` timing
and the answer text.

`smoke.mjs` runs the same protocol surface against a throwaway
server with a stub context (`SMOKE_OK`), so it works in CI where no model exists.

## Behaviour that matters

- **The peer's own approval policy applies.** If the remote agent decides to call a
  tool, the *user standing at that machine* may get a prompt. A first `peer_ask` can
  therefore take minutes; keep `toolCallTimeoutMs` well above `askTimeoutMs`.
- **The peer answers with a fresh session per slot**, created through
  `agents.create` with the profile's default preset. If the peer cannot create an
  agent it falls back to a plain `llm.stream()` call, which has no tools and no
  memory — useful for a smoke test, not for work.
- **LAN addresses drift** (a DHCP lease today, something else after a reboot).
  Treat `url` as configuration: update it and restart, or give the host a DHCP
  reservation.
- **Security**: the server is trusted-LAN only by default. Anyone who can reach the
  port can drive an agent on your machine. Set `token` when the network is shared,
  and never expose the port to the internet.
- **One transport per connection.** `GET /mcp` answers `405` on purpose: this server
  sends no server-initiated stream, so the client must use plain request/response.

## License

MIT.
