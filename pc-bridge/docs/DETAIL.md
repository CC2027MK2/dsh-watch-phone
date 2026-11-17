# Smartwatch bridge (dsh-watch-draft)

HTTP bridge that lets a smartwatch (Xiaomi Watch 5 / WearOS) chat with DSH over LAN with voice input.

## Endpoints

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/health` | — | `{ ok, service, session }` |
| POST | `/chat` | `{ text: string }` | `{ ok, reply: string }` |

Auth: optional `Authorization: Bearer <token>` header (config `token`).

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `38400` | TCP port (binds `0.0.0.0`) |
| `token` | `""` | Bearer token; empty = no auth (LAN-only) |
| `cwd` | workspace | Working directory for the DSH agent |
| `maxWaitMs` | `180000` | Max wait per agent turn |

## How it works

1. The watch app records audio → on-device `SpeechRecognizer` → text.
2. The watch POSTs `{ text }` to `/chat` on the PC's LAN IP.
3. The bridge creates/reuses a DSH agent session (`agents` service), sends the message via `agent.followup()`, and polls `agent.session.snapshotEvents()` for the settled reply.
4. The reply text is returned as JSON; the watch displays it and optionally speaks it via TTS.

## Limitations

- LAN only (no internet exposure by default).
- One shared agent session (`watch-main`) per DSH instance.
- Voice input runs on-watch via Android `SpeechRecognizer`; accuracy depends on the watch's built-in speech engine.
