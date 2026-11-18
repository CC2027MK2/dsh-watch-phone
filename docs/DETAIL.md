# 手表对话桥 · Watch talk bridge

## 中文

把安卓智能手表（或另一台安卓手机）变成 DSH 的「对讲机」：按住屏幕上的绿色胶囊说话，松手后识别结果**先填进输入框**，你确认无误再点发送；思考与朗读都在 DSH 这一侧完成，客户端只负责录音和播放。

### 它做了什么

- 启动一个 `0.0.0.0:38402` 的 HTTP 桥，供客户端调用 `/chat`、`/stt`、`/tts`。
- `/chat` 走**真实 DSH 会话**：用你的默认预设（人格、模型）建一个 `watch-voice` 会话，客户端里说的话和 DSH 里看到的对话是同一份，侧栏能看到标题、模型和人格设定。
- `/stt` 用本机 `speechToText` 服务（如 sensevoice）做离线转写；录音会先归一化成 16 kHz 单声道，并把手表的小音量放大到可用范围。识别文本只填进输入框，**不会自动发出**。
- `/tts` 调小米 MiMo 语音合成（缓存复用），失败时回落到 `proxyBase` 指定的机器。
- **自动发现**：桥在 UDP `38403` 上回答客户端的 `dsh-watch?` 广播（回一份带本机地址的 JSON），同时用 mDNS 发布 `_dsh-watch._tcp.local`。客户端还会退回到扫描本地 /24 和手填地址，所以换了网络（热点、家里 Wi-Fi、公司 Wi-Fi）只要两边在同一网络就能直接连上。
- 打包附带客户端 APK，`GET /watch/app.apk` 直接下载，`adb install` 即可。同一份 APK 在手机上会自动换成单行输入区布局。

### 用法

1. 装好本插件，确认 `/health` 返回 `ok: true`，且其中的 `stt` 不是 `unavailable`。
2. 下载并安装客户端 APK，授予麦克风权限。
3. 客户端连到与 DSH 主机同一网段（手机热点或同一 Wi-Fi），App 会自动发现桥的地址；必要时点顶部状态文字手填。
4. 按住绿色胶囊说话 → 松手 → 检查输入框里的文字 → 点发送 → 听见回复。
5. 想在另一台安卓手机上用？装同一个 APK 即可，它会自动用手机布局连同一个桥。

### 配置要点

`port`、`discoveryPort`、`token`（局域网不可信时装上）、`sessionId`、`cwd`、`tts.apiKey` / `tts.voice`、`proxyBase`。
`allowExec` 与 `allowRelay` 默认关闭：前者给主机执行 shell 的能力，后者是原始 TCP 中继，只有在你明确需要时才打开。

### 已知限制

- 本地转写依赖构建里的 `speechToText` 服务；没有该服务时 `/stt` 返回 503。
- 本地朗读需要一个 MiMo 密钥（或配置 `proxyBase`）。
- 广播与 mDNS 需要同一二层网络；跨网段时用扫描或手填地址。个别安卓机型在息屏时会丢广播 UDP，所以「上次成功的地址」优先。
- 目前只在小米手表 5（480×480 圆屏、Android 14、armv7）与小米手机（Android 16）上端到端验证；其他设备与 ABI 未测。
- 桥是局域网明文 HTTP，不要把端口暴露到公网。

## English

Turns an Android watch — or another Android phone — into a push-to-talk client for DSH: hold the
green pill, speak, release. The transcript lands in the input box and waits for you; transcription,
the agent turn and speech synthesis all happen on the DSH host.

- Serves `/chat`, `/stt`, `/tts` on `0.0.0.0:38402`.
- `/chat` runs through a **real DSH session** (`watch-voice`), so the conversation appears in the
  app with your preset, persona and model — same history, not a side channel.
- `/stt` uses the local `speechToText` service after normalising the recording to 16 kHz mono and
  lifting quiet input; the text is placed in the composer and **never sent automatically**.
  `/tts` synthesises with a MiMo voice and caches results.
- Discovery: the bridge answers a `dsh-watch?` UDP broadcast on 38403 with its URLs and publishes
  `_dsh-watch._tcp.local` over mDNS, so client and host find each other on any shared network. The
  client falls back to a /24 port scan and manual entry.
- The client APK is bundled and served at `/watch/app.apk`; the same APK switches to a
  phone-shaped, single-row composer on screens 320 dp and wider.

Limitations: needs the `speechToText` service and a MiMo key (or a proxy) for full voice; broadcast
and mDNS need the same L2 segment; verified only on a Xiaomi Watch 5 (Android 14) and a Xiaomi
phone (Android 16); the bridge is plain HTTP on the LAN, so set `token` and keep
`allowExec`/`allowRelay` off outside a trusted network.
