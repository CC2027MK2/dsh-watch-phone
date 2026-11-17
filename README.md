# dsh-watch-phone

Hold-to-talk chat between an **Android smartwatch** and **DeepSeek Harness** running on your phone (or on a PC — anything that runs DSH).

Press the green pill on the watch, speak, release: the audio is transcribed on the DSH host, sent to a **real DSH session** (the same one you see in the app, with your preset, persona and model), and the reply is spoken back with a local TTS voice. No cloud round-trip for the watch itself, and no keyboard on a 240 dp round screen.

```text
watch APK  ──HTTP──▶  this plugin (0.0.0.0:38402)
   │                    ├─ POST /chat → DSH agent session → reply text
   │                    ├─ POST /stt  → ctx.get('speechToText')  (local ASR)
   │                    └─ POST /tts  → MiMo speech API (local cache) or fallback proxy
   └─ bundled at /watch/app.apk
```

## Requirements

- DSH **0.2.1-rc.2 ≤ version < 0.3.0** (tested against 0.2.2-rc.1).
- For local speech-to-text: a build with the `speechToText` service (e.g. the official
  `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` bundle). Without it `/stt`
  returns 503 and the watch reports “没听清，再说一次”.
- For local text-to-speech: a Xiaomi MiMo `sk-…` key (`https://api.xiaomimimo.com/v1`),
  or set `proxyBase` to another machine that answers `/tts`.
- An Android watch that can run the bundled APK (built and verified on a 480×480
  round AMOLED watch, Android 14 / armv7).

## Install

```sh
# 1. the bridge
dsh plugin --profile <your-profile> add dsh-watch-phone

# 2. the watch app: the bundle ships the APK, fetch it from the bridge
curl -O http://<host>:38402/watch/app.apk
adb install -r app.apk
adb shell pm grant com.dsh.watchchat android.permission.RECORD_AUDIO
```

The watch discovers the host by itself: it tries the address saved in its settings, then a
list of known gateways (`203.0.113.1:38402`, `198.51.100.20:38402`, `192.0.2.1:38402`),
then scans its /24 for port 38402. You can also type an address into the watch — tap the
status line at the top, or long-press the chat area.

### Build the watch app yourself

The prebuilt APK is only signed with a throwaway key, so rebuild it if you want to change the
UI. The full Android source lives in [`watch-app/`](watch-app/README.md) — JDK 17, Gradle 8.7
(wrapper included), SDK 34:

```sh
cd watch-app
echo "sdk.dir=/path/to/Android/Sdk" > local.properties
./gradlew assembleRelease        # add keystore.properties to sign it
adb install -r app/build/outputs/apk/release/app-release.apk
```

The watch has **no `text-to-speech` service and no `SpeechRecognizer`** (Xiaomi ships neither),
which is exactly why all speech work happens on the phone: the watch records a WAV, posts it to
`/stt`, shows the reply, and plays whatever `/tts` returns.

## Repository layout

| Path | What it is |
| --- | --- |
| `index.js`, `cordis.patch.yml`, `locale/`, `docs/`, `icon.svg` | the plugin bundle itself (`dsh.bundle.patch`) |
| `assets/dsh-watch-chat.apk` | the prebuilt watch client served by `GET /watch/app.apk` |
| `watch-app/` | full Android source of that client (Gradle project, no keystore) |
| `pc-bridge/` | the desktop-only predecessor: a PC DSH plugin with Vosk speech-to-text and SAPI text-to-speech, plus the `/relay` TCP helper used to reach a watch's wireless-debugging port from another subnet |
| `.github/workflows/build-watch-app.yml` | compiles `watch-app/` on every push and uploads the unsigned APK |
| `.github/workflows/publish.yml` | publishes the bundle to npm through Trusted Publishing (OIDC, no token) |

Everything in this repository is sanitised: addresses are documentation ranges
(RFC 5737 — `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`), Wi-Fi names and hotspot
passwords are placeholders, and no keystore, device serial or machine path is committed.
`pc-bridge/` resolves its paths from the file location or from
`DSH_WATCH_BRIDGE_DIR` / `DSH_PHONE_DIR` / `DSH_PYTHON`.

## Configuration

Add these keys to the bundle's row config (`cordis.patch.yml`):

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `38402` | HTTP listen port (all interfaces). |
| `token` | `''` | When set, every route except `/health`, `/log` and `/watch/app.apk` requires `Authorization: Bearer <token>`. |
| `sessionId` | `watch-voice` | DSH session id the watch talks to. Reused if it already exists. |
| `cwd` | `process.cwd()` | Working directory for that session. |
| `allowExec` | `false` | Enables `POST /exec` (shell on the host). Leave off unless you know why. |
| `allowRelay` | `false` | Enables `POST /relay` (raw TCP relay, used to reach a watch on another subnet). |
| `proxyBase` | `''` | Fallback host for `/stt` and `/tts`, e.g. `http://192.0.2.10:38401`. |
| `logFile` | `<home>/.dsh/watch-phone/bridge.log` | Bridge log; recordings are archived next to it in `rec/`. |
| `tts.apiKey` | — | MiMo key. If omitted, the plugin reads the `local-voice` plugin's saved settings (`/root/.dsh/dsh-go/plugins/local-voice/data/settings.json`). |
| `tts.baseURL` | `https://api.xiaomimimo.com/v1` | MiMo endpoint. |
| `tts.model` | `mimo-v2.5-tts` | Also supports `mimo-v2.5-tts-voicedesign`. |
| `tts.voice` | `BingTang` | Voice id (e.g. `冰糖`). |
| `tts.instruction` | `''` | Optional style instruction sent as the first message. |

Example that keeps the shell off but pins the voice:

```yaml
- id: watch-phone
  name: dsh-watch-phone
  config:
    port: 38402
    sessionId: watch-voice
    tts:
      apiKey: sk-...
      voice: 冰糖
```

## HTTP API

| Route | Method | Body | Result |
| --- | --- | --- | --- |
| `/health` | GET | — | `{ ok, service, host, platform, uptime, stt, chat, features }` |
| `/chat` | POST | `{"text":"…"}` | `{ ok:true, reply }` — goes through a real DSH session when `@deepseek-ai/dsh-agent` is resolvable, otherwise straight to the model |
| `/stt` | POST | multipart (`audio`) or raw WAV | `{ ok, text, bytes, language, seconds, peak, gain }` |
| `/tts` | POST | `{"text":"…"}` | `audio/wav` bytes |
| `/reset` | POST | — | clears the conversation |
| `/log` | GET | `?lines=80` | tail of the bridge log |
| `/watch/app.apk` | GET | — | the bundled watch APK |
| `/exec` | POST | `{"cmd":"…"}` | `{ ok, code, stdout, stderr, ms }` — needs `allowExec` |
| `/relay` | POST/GET | `{port,targetHost,targetPort}` | starts / lists TCP relays — needs `allowRelay` |
| `/config` | GET/POST | `{"allowExec":true}` | **loopback only**: read or flip the runtime switches; remembered in `~/.dsh/watch-phone/settings.json` |

### Flipping the operator switches on a phone

`allowExec` and `allowRelay` deliberately cannot be turned on from the LAN. On a phone you
reach loopback with adb, so the switch stays available without exposing it:

```sh
adb forward tcp:13842 tcp:38402
curl -s http://127.0.0.1:13842/config                                  # read
curl -s -X POST http://127.0.0.1:13842/config -d '{"allowExec":true}'  # enable
```

This is how the watch is deployed over a hotspot: `allowRelay` lets the host open a TCP
tunnel to the watch's wireless-debugging port while `adb` stays on the PC.


## Notes and limits

- `/stt` normalises any WAV to 16 kHz mono 16-bit and lifts quiet recordings
  (`peak < 6000` → up to 40× gain), because watch microphones record very low.
- The reply is read from the **last assistant message of the finished turn**, and only its
  `text` parts — reasoning and tool calls are never spoken.
- Sessions are real DSH sessions: the chat shows up in the app's sidebar with an
  auto-generated title, your preset, persona and model. If a session log is ever corrupted
  by an older version, delete `<dsh home>/sessions/*/<sessionId>` and it is recreated.
- The bridge is plain HTTP on your LAN; set `token` if the network is not trusted, and keep
  `allowExec`/`allowRelay` off by default.
- Verified end-to-end on a Xiaomi Watch 5 (M2505W1) with Android 14 talking to DSH Go on
  Android: watch microphone → local sensevoice ASR (0.2–0.8 s warm) → DSH session → MiMo
  TTS (24 kHz WAV) → watch speaker. Other watches/ABIs are untested.

## License

MIT. The bundled APK is built from `watch-app/` in the same project and carries the same
license; see `assets/SOURCE.md`.
