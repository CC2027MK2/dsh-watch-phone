#!/usr/bin/env python
"""One-shot offline transcription for the DSH watch bridge.

Usage:
    python stt_vosk.py <audio-file> [model-dir]

Prints a single JSON object on stdout:
    {"text": "...", "peak": 123, "rms": 45, "gain": 12.0, "seconds": 4.1}

Audio must be mono 16-bit PCM WAV at 16 kHz (exactly what the watch records).
Errors are reported as {"error": "..."} so the caller never parses a traceback.
"""
import json
import os
import sys

import stt_core


def fail(message):
    print(json.dumps({"error": str(message)}, ensure_ascii=True))
    sys.exit(1)


def main():
    if len(sys.argv) < 2:
        fail("usage: stt_vosk.py <audio.wav> [model-dir]")

    audio_path = sys.argv[1]
    model_dir = sys.argv[2] if len(sys.argv) > 2 else stt_core.DEFAULT_MODEL

    if not os.path.isfile(audio_path):
        fail("audio file not found: " + audio_path)
    if not os.path.isdir(model_dir):
        fail("model dir not found: " + model_dir)

    try:
        model = stt_core.load_model(model_dir)
    except ImportError:
        fail("vosk is not installed (pip install vosk)")

    try:
        result = stt_core.transcribe(audio_path, model)
    except Exception as exc:  # noqa: BLE001 - reported as JSON, never a traceback
        fail(exc)

    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
