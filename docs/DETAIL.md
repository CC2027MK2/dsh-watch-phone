# 手表对话桥 · Watch talk bridge

## 中文

把安卓智能手表变成 DSH 的「对讲机」：按住屏幕上的绿色胶囊说话，松手即发送；识别、思考、朗读都在 DSH 这一侧完成，手表只负责录音和播放。

### 它做了什么

- 启动一个 `0.0.0.0:38402` 的 HTTP 桥，供手表调用 `/chat`、`/stt`、`/tts`。
- `/chat` 走**真实 DSH 会话**：用你的默认预设（人格、模型）建一个 `watch-voice` 会话，手表里说的话和 DSH 里看到的对话是同一份，侧栏能看到标题、模型和人格设定。
- `/stt` 用本机 `speechToText` 服务（如 sensevoice）做离线转写；录音会先归一化成 16 kHz 单声道，并把手表的小音量放大到可用范围。
- `/tts` 调小米 MiMo 语音合成（缓存复用），失败时回落到 `proxyBase` 指定的机器。
- 打包附带手表 APK，`GET /watch/app.apk` 直接下载，`adb install` 即可。

### 用法

1. 装好本插件，确认 `/health` 返回 `ok: true`，且其中的 `stt` 不是 `unavailable`。
2. 下载并安装手表 APK，授予麦克风权限。
3. 手表连到与 DSH 主机同一网段（手机热点或同一 Wi-Fi），App 会自动发现桥的地址；必要时点顶部状态文字手填。
4. 按住绿色胶囊说话 → 松手 → 听见回复。

### 配置要点

`port`、`token`（局域网不可信时装上）、`sessionId`、`cwd`、`tts.apiKey` / `tts.voice`、`proxyBase`。
`allowExec` 与 `allowRelay` 默认关闭：前者给主机执行 shell 的能力，后者是原始 TCP 中继，只有在你明确需要时才打开。

### 已知限制

- 本地转写依赖构建里的 `speechToText` 服务；没有该服务时 `/stt` 返回 503。
- 本地朗读需要一个 MiMo 密钥（或配置 `proxyBase`）。
- 目前只在小米手表 5（480×480 圆屏、Android 14、armv7）上端到端验证；其他手表与 ABI 未测。
- 桥是局域网明文 HTTP，不要把端口暴露到公网。

## English

Turns an Android watch into a push-to-talk client for DSH: hold the green pill, speak, release.
Transcription, the agent turn and speech synthesis all happen on the DSH host; the watch only
records and plays audio.

- Serves `/chat`, `/stt`, `/tts` on `0.0.0.0:38402`.
- `/chat` runs through a **real DSH session** (`watch-voice`), so the conversation appears in the
  app with your preset, persona and model — same history, not a side channel.
- `/stt` uses the local `speechToText` service after normalising the recording to 16 kHz mono and
  lifting quiet input; `/tts` synthesises with a MiMo voice and caches results.
- The watch APK is bundled and served at `/watch/app.apk`.

Limitations: needs the `speechToText` service and a MiMo key (or a proxy) for full voice;
verified only on a Xiaomi Watch 5 running Android 14; the bridge is plain HTTP on the LAN, so set
`token` and keep `allowExec`/`allowRelay` off outside a trusted network.
