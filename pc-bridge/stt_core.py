"""Shared offline transcription core for the DSH watch bridge.

Both entry points use it:
    stt_vosk.py    one-shot CLI (also the fallback path)
    stt_worker.py  long-lived worker that keeps the Vosk model loaded

Everything runs locally: no network, no cloud speech service.
"""
import array
import json
import os
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.join(HERE, "models", "vosk-model-small-cn-0.22")


def _load_pcm(audio_path):
    with wave.open(audio_path, "rb") as wf:
        channels = wf.getnchannels()
        rate = wf.getframerate()
        width = wf.getsampwidth()
        if channels != 1 or width != 2:
            raise ValueError("expected mono 16-bit PCM, got channels=%d width=%d" % (channels, width))
        if rate != 16000:
            raise ValueError("expected 16000 Hz, got %d" % rate)
        pcm = array.array("h")
        pcm.frombytes(wf.readframes(wf.getnframes()))
    if not pcm:
        raise ValueError("empty audio")
    return pcm


def _amplify(pcm, peak):
    """Watch mics record very quietly; lift quiet clips to a healthy level."""
    if not (0 < peak < 6000):
        return pcm, 1.0
    scale = min(40.0, 24000.0 / peak)
    # A list comprehension is several times faster than a generator here, which
    # matters for 10s+ clips on a cold interpreter.
    return array.array("h", [
        32767 if (v := int(s * scale)) > 32767 else (-32768 if v < -32768 else v)
        for s in pcm
    ]), scale


def transcribe(audio_path, model, model_rate=16000):
    """Transcribes one WAV file with an already-loaded Vosk model."""
    import vosk

    pcm = _load_pcm(audio_path)
    raw_peak = max(max(pcm), -min(pcm))
    pcm, gain = _amplify(pcm, raw_peak)

    rec = vosk.KaldiRecognizer(model, model_rate)
    rec.SetWords(False)

    pieces = []
    raw = pcm.tobytes()
    block = 4000 * 2  # bytes -> 4000 samples per AcceptWaveform call
    for offset in range(0, len(raw), block):
        if rec.AcceptWaveform(raw[offset: offset + block]):
            pieces.append(json.loads(rec.Result()).get("text", ""))
    pieces.append(json.loads(rec.FinalResult()).get("text", ""))

    text = "".join(part.replace(" ", "") for part in pieces if part).strip()
    rms = int((sum(s * s for s in pcm) / len(pcm)) ** 0.5) if pcm else 0
    return {
        "text": text,
        "peak": raw_peak,
        "rms": rms,
        "gain": round(gain, 2),
        "seconds": round(len(pcm) / 16000.0, 2),
    }


def load_model(model_dir=DEFAULT_MODEL):
    import vosk

    vosk.SetLogLevel(-1)
    return vosk.Model(model_dir)
