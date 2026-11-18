# Design notes

How `dsh-watch-phone` is put together, and why it is put together that way. The
[README](README.md) is the user-facing document; this one is for whoever has to change the code.

## The shape of it

```
Android client (watch or phone, com.dsh.watchchat)
  ├─ hold the mic ──▶ AudioRecord 16 kHz/mono PCM16 ──▶ SttUploader ──POST /stt──▶ ┐
  ├─ tap send ─────────────────────── text bubble ────POST /chat──▶ ┐              │
  ├─ reply bubble ◀────── {reply} ◀──────────────────────────────── │              │
  └─ speaker ◀── MediaPlayer ◀── audio/wav ◀─────────POST /tts ◀─── ┘              │
                                                                    │              │
                                        dsh-watch-phone (:38402) ◀─┴──────────────┘
                                            │  ctx.agents.create() → DSH session
                                            ▼
                                    DeepSeek Harness on the phone
                                    (preset, persona, model, history)
```

Everything is one process on one machine plus one HTTP client. There is no cloud hop: ASR and
TTS run locally on the phone, so a locked-down LAN is enough.

Two transport details that are easy to get wrong:

- **`/stt` must normalise audio.** The local recogniser only accepts a canonical 44-byte RIFF
  header, mono, 16-bit, 16 kHz — anything else is rejected outright. Real inputs are a mess:
  Windows SAPI writes an 18-byte `fmt ` extension chunk, phone TTS writes 24 kHz. So the
  entry point parses RIFF blocks (never assuming header length), downmixes, linearly resamples
  to 16 kHz and rewrites a standard header.
- **Watch microphones are quiet.** Peaks of 200–600 out of 32767 are normal. When
  `peak < 6000` the bridge applies `min(40, 24000 / peak)` gain; long sentences start losing
  characters without it. `/stt` echoes `peak`/`rms`/`gain`/`seconds` so a log is enough to tell
  "nothing was recorded" from "recorded but not understood".

## The chat is a real DSH session

`/chat` does not call `llm.stream()` directly. It creates or resumes a session through the
public agent API, which is what makes the conversation show up in the app's sidebar with a
title, the user's preset, persona and model:

```js
const agent = await agents.create({
  sessionId,
  agentOptions: { get provider () {…}, get model () {…}, get reasoningEffort () {…} },
  meta: { cwd, agentPreset },
  setup: async (c) => { installModelSelection(c); await presets.mount(c, resolvedId) },
})
agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
```

Four constraints, each learned the hard way:

1. **`source: { kind: 'user' }` is mandatory.** A user message without a producer-owned source
   kind makes the session log invalid (`SessionFormatError`), and the session is unusable
   afterwards — `create` then complains it already exists and `resume` fails too. The fix is to
   delete `<dsh home>/sessions/*/<sessionId>`.
2. **Only `type === 'text'` parts may be spoken.** An assistant message also carries
   `reasoning` (the model thinking out loud) and `tool-call` parts. An extractor that
   concatenates everything with a `.text` field reads the internal monologue aloud.
3. **Wait for `turn/end`, then take the last `assistant/message`.** One turn can contain several
   steps, each producing its own assistant message.
4. **`@deepseek-ai/*` must be resolvable from the plugin directory.** A link-installed plugin
   does not see the host's `node_modules`; symlink
   `<plugin>/node_modules/@deepseek-ai → <dsh>/node_modules/@deepseek-ai`, otherwise the import
   fails and the bridge silently falls back to a direct model call (a session that never
   appears in the sidebar).

The bridge keeps a `mode` field in `/health` — `session`, `direct` or `pending` — plus the
reason it degraded, so "why is this not in my sidebar" is answerable from one request.

## Finding the bridge on the LAN

A hard-coded address breaks the moment the network changes, so discovery is a chain where every
step is validated with `GET /health` before it is accepted:

```
SharedPreferences.server_url
  → recent_servers            (last 8 successful addresses, rolling)
  → UDP broadcast :38403      ("dsh-watch?" → JSON with every IPv4 URL)
  → mDNS _dsh-watch._tcp.local
  → scan the local /24 for 38402 / 38401 / 38400
  → KNOWN_SERVERS             (documentation ranges, last resort)
```

- **The broadcast is the primary path.** The client sends `dsh-watch?` to
  `255.255.255.255:38403`; the bridge answers with all of its URLs. It needs no multicast lock
  and no mDNS daemon. mDNS is kept as best-effort only: on Windows and on some Android builds
  the system Bonjour/third-party service holds port 5353 and a `reuseAddr` socket simply never
  sees the packets.
- **The mDNS answer must include an A record.** With PTR/SRV/TXT only, Android's
  `NsdServiceInfo.getHost()` cannot resolve an address and `resolveService` fails forever.
- Both responders start in the `server.listen` callback and stop in `ctx.on('dispose')`.
  `discoveryPort` (default 38403) is configurable.

## Watch UI on a 240 dp circle

The watch reports 480×480 at 320 dpi, so the logical width is 240 dp and a single row cannot
hold input + mic + send. The watch layout therefore uses two rows, with the microphone promoted
to the primary control (a 54 dp capsule that fills the row, red with a waveform while
recording) and send reduced to a 44 dp circle. A `layout-sw320dp` variant gives phones a
conventional single-row composer, and `values-sw320dp/dimens.xml` scales bubbles to 15 sp /
280 dp. One APK, both form factors.

Screen real estate in a circle is the real constraint: `paddingHorizontal=28dp` and
`paddingTop=44dp` keep content inside the safe area.

## Operational notes

- **Plugin reload.** `ctx.effect()` tears down immediately; use `ctx.on('dispose')`. The server
  handle is also stashed on `globalThis[Symbol.for('dsh-watch-phone.server')]` so a re-apply
  closes the previous instance before `listen`, instead of dying with `EADDRINUSE` while the
  old instance keeps serving.
- **`allowExec` / `allowRelay` default to off.** A LAN bridge with a shell endpoint is a
  liability; both are flipped at runtime through the loopback-only `/config` endpoint (reached
  over `adb forward`), and the choice is remembered in `<data dir>/settings.json`. A headless
  deploy therefore uses `/exec` to install itself and `/config` to lock the door afterwards.
- **`/relay` exists for deployment, not for chat.** When the PC and the watch are on different
  subnets, `POST /relay {port, targetHost, targetPort}` opens a TCP tunnel so `adb` can reach the
  watch's wireless-debugging port through the phone. Relays live in memory and disappear on
  restart.
- **`/exec`, `/log`, `/relay` are operator features**, not part of the chat path; they are 403
  unless explicitly enabled.
- **Screenshot capture** must be `adb shell screencap -p /sdcard/x.png` followed by `adb pull`;
  `exec-out screencap -p > x.png` gets truncated by PowerShell's text pipeline into a corrupt
  PNG.

## Build

The Gradle project lives in `watch-app/` (JDK 17, Android SDK with `platform-tools`). Signing is
opt-in: with no `keystore.properties` the build produces `app-release-unsigned.apk`, which is
exactly what `.github/workflows/build-watch-app.yml` publishes as an artifact on every push that
touches `watch-app/`.
