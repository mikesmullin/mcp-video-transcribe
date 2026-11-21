#!/usr/bin/env python3
"""Transcribe an entire 16 kHz WAV using the installed Audio8 ONNX runtime."""
import io
import json
import sys
import wave
from pathlib import Path

runtime = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(runtime))
from asr_onnx_runtime import OnnxCacheAsrEngine

engine = OnnxCacheAsrEngine(runtime / 'model_bundle', cache_precision='int4', audio_precision='int8')


def transcribe_frames(frames, start, rate, depth=0):
    if not frames:
        return []
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(frames)
    result = engine.transcribe(buf.getvalue(), language=None, max_new_tokens=128, hotwords=None)
    # The runtime reports whether generation ended naturally. Split and retry
    # a truncated chunk so a long answer is never silently cut off.
    if result.get('hit_stop') is False:
        samples = len(frames) // 2
        if samples < rate * 2 or depth >= 8:
            raise RuntimeError(f'Audio8 output was truncated at {start / rate:.1f}s')
        split = (samples // 2) * 2
        return (transcribe_frames(frames[:split], start, rate, depth + 1)
                + transcribe_frames(frames[split:], start + split // 2, rate, depth + 1))
    text = str(result.get('text') or '').strip()
    if not text:
        return []
    return [{'text': text, 'offset': round(start * 1000 / rate),
             'duration': round((len(frames) // 2) * 1000 / rate)}]


entries = []
with wave.open(sys.argv[2], 'rb') as wav:
    if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000:
        raise ValueError('Audio must be 16 kHz mono 16-bit PCM WAV')
    rate = wav.getframerate()
    offset = 0
    while True:
        frames = wav.readframes(rate * 10)
        if not frames:
            break
        entries.extend(transcribe_frames(frames, offset, rate))
        offset += len(frames) // 2
print(json.dumps(entries, ensure_ascii=False))
