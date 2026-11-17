# dsh-watch-draft design notes

小米手表 5（Xiaomi Watch 5 eSIM，Android 14 / SDK 34，armeabi-v7a，480×480 @320dpi＝逻辑 240dp）
通过局域网和本机 DSH 对话，支持语音输入与语音播报。

## 实际架构（当前实现）

对话后端已经搬到**手机上的 DSH Go**（`io.github.ccch1mneyyy.dsh_app`，PRoot Ubuntu 里的同一套
DSH 引擎，profile `/root/.dsh/profiles/web`）。PC 侧的 `dsh-watch-draft` 退化为"语音外设"：
手机容器里既没有 Vosk 也没有 TTS 引擎，所以 `/stt`、`/tts` 由手机桥透明代理回 PC。

```
手表 App (com.dsh.watchchat)                  手机 DSH Go 插件 (dsh-watch-phone :38402)
  ├─ 点麦克风 → AudioRecord 录 16k/mono PCM16 WAV ──POST /stt──▶ ┐ proxy
  ├─ 转写文本 → 气泡 + POST /chat               ──POST /chat──▶ ctx.get('llm').stream(...)
  ├─ 收到回复 → 气泡                            ◀──{reply}──── │ 手机自己的模型
  └─ 播放语音 ← MediaPlayer ← 下载 WAV           ◀──audio/wav─── ┘ proxy
                                                PC 侧 dsh-watch-draft (:38401)
                                                  ├─ /stt → Vosk 离线转写（常驻 worker）
                                                  └─ /tts → Windows SAPI 合成 16k WAV
```

手表端服务器地址：`KNOWN_SERVERS = {http://198.51.100.20:38402 (手机), http://192.0.2.1:38401 (PC 备用)}`，
启动时按序探 `/health`，都失败才在本网段扫 `38402/38401/38400`。改地址后要 `pm clear com.dsh.watchchat`
清掉旧的 SharedPreferences，否则仍用旧地址。

关键约束与决策：

- **手表没有 TextToSpeech 服务**（`cmd text-to-speech` 报 `Can't find service`，
  `settings get secure tts_default_synth` 为 null，包里只有 `com.xiaomi.miwear.voiceassist`）。
  因此"离线 TTS"落在主机侧：`tts_sapi.ps1` 用 Windows 内置中文语音（Microsoft Huihui Desktop）
  合成 16kHz/mono WAV，按文本 SHA-1 缓存在 `tts-cache/`，手表 `HostTts.java` 下载后用 MediaPlayer 播放。
  全链路只走局域网，不依赖任何云服务。
- **手表也没有可用的 SpeechRecognizer**（无 Google 语音服务），所以语音输入是
  "录音 → 上传 → 主机离线转写"：`AudioRecorder.java`（AudioRecord，VOICE_RECOGNITION + AGC）→
  `SttUploader.java`（multipart 上传 `name=audio`）→ `index.js` 的 `/stt` →
  `stt_core.py` + Vosk `vosk-model-small-cn-0.22`。
- **手表麦克风增益极低**（说话时 peak 常只有几百 / 32767），`stt_core.py` 在解码前做静音归一并
  最多放大 40 倍；`/stt` 返回值里带 `peak`/`rms`/`gain`/`seconds`，日志里可直接判断"没录到"
  还是"录到了但没听懂"。
- **Vosk 常驻 worker**（`stt_worker.py`，stdin/stdout 每行一个 JSON）：模型只加载一次，
  之后每次请求省掉约 1.5–2 秒；worker 挂掉时 `index.js` 自动回落 `stt_vosk.py` 一次性进程。
- **桥接不经过 Agent 会话层**：link 安装的插件解析不到 `@deepseek-ai/*`，改为直接
  `ctx.get('llm').stream({ provider, model, messages, system })`；模型路由取
  `ctx.get('agentDefaultModel').currentSelection()`。assistant 历史消息必须带完整
  `{id, role:'assistant', source:{kind:'model', provider, model}, content:[{type:'text'}]}`，
  否则 provider 会静默返回空（表现为 16ms 的空回复）。
- **插件重载**：`ctx.effect()` 会立即触发清理，改用 `ctx.on('dispose')`；同时把 server 存在
  `globalThis[Symbol.for('dsh-watch-draft.server')]`，apply 时先 `previous.close()` 再 listen，
  避免 `EADDRINUSE` 后请求仍打到旧实例。

## HTTP 接口

手机端插件 `dsh-watch-phone`（`:38402`；`/exec` `/log` 仅内网自用）：

| 方法 | 路径      | 请求                     | 响应 |
|------|-----------|--------------------------|------|
| GET  | `/health` | –                        | `{ok, service, stt:{providerId,language}}` |
| POST | `/chat`   | `{"text":"..."}`         | `{ok:true, reply}` |
| POST | `/stt`    | multipart 字段 `audio`，或裸 WAV | `{ok:true, text, bytes}` |
| POST | `/tts`    | `{"text":"..."}`         | `audio/wav`（MiMo 本地合成，24kHz） |
| POST | `/reset`  | –                        | `{ok:true}` |
| POST | `/exec`   | `{"cmd":"..."}`          | `{ok, code, stdout, stderr, ms}` |

PC 端插件 `dsh-watch-draft`（`:38401`）保留同构的 `/chat` `/stt` `/tts`，另有无鉴权的
`/files/<name>`（从 `phone-dsh-re/dist` 发文件）与 `POST /collect?name=x`（收日志），
这两个是给"手机还没法直连 PC"时送脚本用的，装好 `/exec` 之后一般不再需要。

### 音频归一化（`prepareWav`）

本地识别器只吃**规范 44 字节头、单声道、16bit、16kHz** 的 PCM WAV，其它一律
`Invalid speech WAV`。而实际输入五花八门：Windows SAPI 输出带 18 字节 `fmt ` 扩展块、
手机 MiMo 合成是 24kHz/单声道。所以 `/stt` 入口先做一遍归一：按 RIFF 块解析（不假设头长度）
→ 混成单声道 → 线性插值重采样到 16kHz → 回写标准头。

同时做**增益归一**：手表麦克风距离远，峰值往往只有 200~600（满量程 32767），
`peak < 6000` 时放大 `min(40, 24000/peak)`。实测把 MiMo 语音衰减到 peak=260 再送进去，
`sensevoice` 仍能完整转出"帮我订一张明天下午3点从西安去北京的高铁票。"——加增益前后都准，
但不加增益时更长的句子会开始丢字。

### 访问日志

每个请求都记 `access: <method> <path> from <ip>`。多网卡同时在线时，这是判断
"手表到底是走 PC 热点中转、还是直连到手机"的唯一可靠手段（NAT 后源地址会变成 PC 的地址）。


## 圆屏 UI

480×480 @320dpi → 逻辑宽度只有 240dp，横向一行塞不下"麦克风 + 输入框 + 发送"。
因此底部输入区改成两行：第一行整行输入框，第二行左边 44dp 麦克风、右边"发送"占满剩余宽度；
外层 `paddingHorizontal=28dp`、`paddingBottom=22dp`，聊天区 `marginBottom=116dp`、`paddingTop=44dp`，
保证所有控件落在圆形安全区内。

## 构建与部署

```powershell
# 构建（JDK 17 必须写进 gradle.properties 的 org.gradle.java.home，JDK 21 会 jlink 失败）
Set-Location ...\watch-app
$env:JAVA_HOME="<jdk17>"
$env:ANDROID_HOME="<android-sdk>"
& "<gradle>" assembleRelease --no-daemon

# 部署（connect → install -r → 启动 → 截图回传）
.\deploy-watch.ps1 -Device 192.0.2.11:42883
```

截图必须 `adb shell screencap -p /sdcard/x.png` + `adb pull`；`exec-out screencap -p > x.png`
在 PowerShell 下会被文本管道截断成不到 4KB 的坏 PNG。

## 状态

- 2026-11-17：插件桥 `/health` `/chat` `/stt` `/tts` 全部可用；手表端录音、转写、对话、播报
  全链路打通（声学回环实测：手表外放 → 手表麦克风 → 主机转写 → DSH → 回复 → 主机合成 → 手表播放）。
- 2026-11-17 傍晚：后端已切到**手机**。手机插件 `dsh-watch-phone` 用 `speechToText`（sensevoice-local）
  做本地转写、用 `local-voice` 里的 MiMo key 做本地合成（冰糖音色），`/exec` 打通了免 UI 的远程运维。
  用户实测多轮："测试测试123听得到吗？" 2.7s（冷）/ "现在你是连在电脑上还是连在手机上的？" 208ms /
  "看到手机上的。" 122ms，回复与朗读都在手机侧完成。
- 2026-11-17 傍晚：`/stt` 加音频归一化（任意 WAV → 16k/mono/16bit + 增益），24kHz 的 MiMo 语音和
  带扩展头的 SAPI 语音都能直接识别；安静样本（peak=260, gain=40）仍能准确转写。
- 仍未解决：**网络路径**。手表连的是 PC 热点（192.0.2.11），手机在办公网（198.51.100.20），
  中间由 PC 做 NAT 中转——关掉 PC 链路就断。手机侧 shell 无权开热点
  （`SecurityException: Uid 2000 does not have access to start-softap`），手表侧也没有
  `cmd wifi connect-network`，所以这一段需要用户手动点一下：手机开热点，或手表加入办公 Wi-Fi。
  手表 APK 已预置候选地址（`198.51.100.20` / `192.168.43.1` / `192.0.2.1`）并带网段扫描，
  网络一换会自动重新找到手机。

## 2026-11-17 深夜：真会话 + 同网段 + 按住说话

### 1. 手表对话现在是手机 DSH 的**真会话**
`dsh-watch-phone` 的 `/chat` 不再直连 `llm.stream()`，改为在手机 DSH 里创建/复用一个会话
（`sessionId: watch-voice`），走官方 `ctx.agents.create()` + `presets.mount()`：

- `setup: async (c) => { installModelSelection(c); await presets.mount(c, resolved.id) }`
- 默认预设解析为 `dsh-go-companion-full`，所以手表里说话的是用户自己配置的**鲸鱼娘**人格，
  模型是 `custom-deepseek / deepseek-v4.1-flash`，会话侧栏能看到标题、模型、人格设定。
- 发消息必须 `createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })`，
  少了 `source` 会话日志会被判 `SessionFormatError` 而整段作废。
- 取回复只认 `type === 'text'` 的 part，并等 `turn/end` 后取最后一条 `assistant/message`：
  `reasoning`（内心戏）和 `tool-call` part 不能念给用户听。
- 依赖：`@deepseek-ai/*` 需要软链
  `ln -s /opt/dsh/node_modules/@deepseek-ai <plugin>/node_modules/@deepseek-ai`。

### 2. 网络：手表直连手机热点
手表已加入手机热点 `watch-hotspot`（WPA2，`<hotspot-password>`），手机侧 `ap0 = 203.0.113.1/24`，
手表 `203.0.113.42`。手表 APK 的 `KNOWN_SERVERS` 第一项就是 `http://203.0.113.1:38402`，
PC 不再参与数据通路。

PC 与手表不同网段时想用 adb：插件提供 TCP 中继
`POST /relay {port, targetHost, targetPort}`，PC 用 `adb pair/connect 198.51.100.20:<中继端口>` 即可。
配对码在手表「无线调试」里；adbd 的**连接端口**每次不同，可手机侧并发扫 30000–50000 找。

### 3. 按住说话（微信式）
`MainActivity`：`micButton.setOnTouchListener` → `beginHold()` / `endHold()`。
按下：震动 + `micSpinner` 转圈 + 红底 `mic_bg_recording` + `ic_wave_a/b/c` 三帧波动动画 +
顶部 `正在听… Ns` 计时（150ms 一帧，20s 上限）。松手：`<600ms` 判「说话时间太短」，
否则上传 `/stt` → `识别中…` → 成功直接发消息，空结果提示「没听清，再说一次」。
服务器地址入口从「长按麦克风」挪到「点状态文字 / 长按聊天区」，避免和按住说话冲突。
朗读前会剥掉 `[表情:开心]` 这类方括号舞台提示，不念给耳朵听。

### 4. 语音优先的输入区（2026-11-17 晚）
手表 240dp 宽、圆形，键盘输入本来就难受，所以底部把语音做成主控件：

- Row1 文字框压到 34dp 高（备用路径，视觉上退到次要位置）；
- Row2 = **大绿胶囊**（`@drawable/talk_bg`，`layout_weight=1`，54dp 高，占满除发送键外的全部宽度）
  + **小圆发送**（44dp，`@drawable/send_bg` 圆形 + `@drawable/ic_send` 上箭头，不再用「发送」二字）。
- 录音时胶囊切换成 `talk_bg_recording`（红色）+ 波形帧；识别中胶囊降到 0.35 alpha 并叠 spinner，
  顶部状态文字「正在听… Ns / 识别中…」。
- 聊天区 `marginBottom=126dp` 跟着新的输入区高度调整。



