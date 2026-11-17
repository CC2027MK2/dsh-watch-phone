# pc-bridge — the desktop predecessor

This is the first generation of the bridge: a **DSH Host plugin that runs on a PC** and does
the speech work itself, because the watch has neither a `SpeechRecognizer` nor a
`text-to-speech` engine.

```
watch  ──HTTP──▶  this bridge (:38401)  ──▶  DSH llm.stream()  ──▶  reply
   │                                                                  │
   └──────────────  WAV upload /stt  ◀── Vosk (offline)   /tts ──▶ SAPI WAV
```

The phone-side bundle in the parent directory (`dsh-watch-phone`) is what you normally want
today: it creates a real DSH session on the phone, so the conversation shows up in DeepSeek
Harness with its model and persona. Keep this bridge for two cases:

* you want the DSH side to stay on the PC while the watch talks to it;
* you need `POST /relay` — a TCP relay inside the phone's container, which lets a PC on a
  different subnet pair and connect to a watch's wireless-debugging port
  (`adb pair <phone>:<relay-port> <code>`).

## What it exposes

| Route | Purpose |
| --- | --- |
| `GET /health` | liveness + session id |
| `POST /chat {text}` | send a turn to the model, returns `{ok, reply}` |
| `POST /stt` | multipart `audio` (16 kHz mono 16-bit WAV) → `{ok, text, peak, rms, gain, seconds}` |
| `POST /tts {text}` | Windows SAPI → `audio/wav` (SHA-1 cached on disk) |
| `POST /relay {port, targetHost, targetPort}` | start a TCP relay; `GET /relay` lists them |
| `GET /config`, `POST /config` | loopback-only operator switches (exec, relay) |
| `GET /watch/app.apk` | the watch client for `adb install` |

## Requirements

* Node.js 22+ (uses `node:sqlite`-free APIs only, but modern ESM).
* `python` with [`vosk`](https://alphacephei.com/vosk/) installed:
  `pip install vosk`, then a model, e.g. `vosk-model-small-cn-0.22`, placed at
  `models/vosk-model-small-cn-0.22` (configurable).
* Windows for `/tts` (`System.Speech`), via `tts_sapi.ps1`. On other platforms point the
  client at a different `/tts` implementation or leave TTS disabled.

## Paths

Nothing is hard-coded. Everything is relative to this folder, overridable:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_WATCH_BRIDGE_DIR` | directory of `index.js` | where `bridge.log`, `tts-cache/`, `models/` live |
| `DSH_PHONE_DIR` | `../phone-dsh-re` | folder served by `/files` and appended to by `/collect` (development helper; 404 when absent) |
| `DSH_PYTHON` | `python` | interpreter that runs `stt_worker.py` |

## Run it

It is a DSH Host plugin, so install it as a bundle (`package.json` declares
`dsh.bundle.patch`), or run the HTTP server standalone for a smoke test:

```sh
node -e "import('./index.js').then(async (m) => {
  const ctx = { get: () => ({ currentSelection: () => ({ provider: 'p', model: 'm' }) }),
                on: () => {} }
  const dispose = typeof m.apply === 'function' ? await m.apply(ctx, { port: 38401 }) : null
  console.log('listening on 38401')
})"
```

`DESIGN.md` records the architecture decisions and every trap met while building this
(session corruption, WAV header validation, PowerShell encoding, adb over a foreign subnet).
