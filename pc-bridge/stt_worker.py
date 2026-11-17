#!/usr/bin/env python
"""Long-lived transcription worker for the DSH watch bridge.

Keeps the Vosk model resident so each request pays only decoding time instead of
model-load time (about a second per voice message on this machine).

Protocol, one JSON object per line:
    in : {"wav": "C:\\path\\clip.wav"}
    out: {"ok": true, "text": "...", "peak": 0, "rms": 0, "gain": 1.0, "seconds": 0.0}
      or {"ok": false, "error": "..."}

stdout carries protocol lines only; diagnostics go to stderr.
"""
import json
import sys

import stt_core


def main():
    model_dir = stt_core.DEFAULT_MODEL
    try:
        model = stt_core.load_model(model_dir)
    except Exception as exc:  # noqa: BLE001 - report and exit so the host can fall back
        print(json.dumps({"ok": False, "fatal": True, "error": str(exc)}), flush=True)
        return 1

    print(json.dumps({"ok": True, "ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            wav = request.get("wav")
            if not wav:
                raise ValueError("missing wav path")
            result = stt_core.transcribe(wav, model)
            payload = {"ok": True}
            payload.update(result)
        except Exception as exc:  # noqa: BLE001 - always answer, never crash the loop
            payload = {"ok": False, "error": str(exc)}
        print(json.dumps(payload, ensure_ascii=True), flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
