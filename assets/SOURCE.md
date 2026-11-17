# Bundled watch app

`assets/dsh-watch-chat.apk` is the client that talks to this bridge.

- Package / launcher: `com.dsh.watchchat/.MainActivity`
- Permissions: `android.permission.INTERNET`, `android.permission.RECORD_AUDIO`
- minSdk 26, targetSdk 34, ABIs `armeabi-v7a` / `armeabi` / `arm64-v8a`
- Built and verified on a Xiaomi Watch 5 (M2505W1, 480×480 round AMOLED, Android 14)

The APK is compiled from the `watch-app/` Gradle project of the same source tree
(Java, AGP 8.2, JDK 17, release signed with a local debug keystore so it installs with
`adb install -r`).

What the client does:

- One chat transcript with green pills for your turns and dark pills for the assistant.
- A large hold-to-talk pill: press → red waveform + `正在听… Ns`; release → upload to `/stt`,
  then the recognised text is sent to `/chat` automatically.
- Replies are played through `/tts` (host-side synthesis, because the watch has no TTS engine).
  `[表情:…]` stage directions are stripped before speaking.
- Host discovery: saved address → known gateways → /24 scan on port 38402;
  tap the status line (or long-press the transcript) to type an address by hand.

Rebuilding the APK requires the watch source tree; this package ships the built artifact only.

## Sanitised build (0.1.6)

The APK shipped from 0.1.6 on is built from the `watch-app/` tree in this repository,
in which every private address has been replaced with a documentation-range default
(RFC 5737: `203.0.113.1` for the phone-as-hotspot gateway, `198.51.100.20` for the
phone on Wi-Fi, `192.0.2.10`/`192.0.2.1` for a PC bridge). Those defaults are hints
only: the client remembers the address you save, and falls back to a `/24` scan for
port 38402 on the LAN it is attached to.

No keystore, Wi-Fi name, hotspot password, device serial or machine path is part of
this repository.
