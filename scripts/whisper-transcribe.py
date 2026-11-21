#!/usr/bin/env python3
"""Transcribe downloaded audio with standalone faster-whisper Turbo."""
import json
import os
import sys
import time

start = time.monotonic()
import ctranslate2
from faster_whisper import BatchedInferencePipeline, WhisperModel

model_path, audio = sys.argv[1:3]
requested = os.environ.get('WHISPER_DEVICE', 'auto')
if requested not in ('auto', 'cuda', 'cpu'):
    raise ValueError('WHISPER_DEVICE must be auto, cuda, or cpu')
device = ('cuda' if ctranslate2.get_cuda_device_count() else 'cpu') if requested == 'auto' else requested
compute = 'float16' if device == 'cuda' else 'int8'
model = WhisperModel(model_path, device=device, compute_type=compute, local_files_only=True)
# Batched inference uses VAD and keeps segment timestamps in the original audio.
# Batch 8 is a compromise between GPU throughput and memory consumption.
size = int(os.environ.get('WHISPER_BATCH_SIZE', '8' if device == 'cuda' else '1'))
if size < 1:
    raise ValueError('WHISPER_BATCH_SIZE must be positive')
segments, info = BatchedInferencePipeline(model=model).transcribe(audio, batch_size=size, beam_size=5)
entries = [
    {'text': segment.text.strip(), 'offset': round(segment.start * 1000),
     'duration': round((segment.end - segment.start) * 1000)}
    for segment in segments if segment.text.strip()
]
print(json.dumps({'entries': entries, 'device': device, 'language': info.language,
                  'transcriptionSeconds': time.monotonic() - start}, ensure_ascii=False))
