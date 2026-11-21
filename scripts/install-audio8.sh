#!/usr/bin/env bash
# Install the public Audio8 runtime and its CPU model into this project.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
home="${AUDIO8_HOME:-$root/.audio8}"
revision=5b6d058a54853700223dd23cb4fe466b86c8fece
python="${AUDIO8_INSTALL_PYTHON:-}"
if [[ -z "$python" ]]; then
  if command -v python3.12 >/dev/null; then python=python3.12; else python=python3; fi
fi
"$python" -c 'import sys; assert (3,10) <= sys.version_info[:2] <= (3,12), "Audio8 requires Python 3.10–3.12"'
mkdir -p "$home"
if command -v uv >/dev/null; then
  uv venv --allow-existing --python "$python" "$home/venv"
  uv pip install --python "$home/venv/bin/python" 'huggingface_hub>=0.34,<1.0' 'imageio-ffmpeg>=0.5,<1.0' 'yt-dlp>=2025.1.1' \
    'numpy==1.26.4' 'onnxruntime==1.22.0' 'psutil==7.0.0' 'tokenizers==0.22.2' 'transformers==4.57.6'
else
  "$python" -m venv "$home/venv"
  "$home/venv/bin/python" -m pip install 'huggingface_hub>=0.34,<1.0' 'imageio-ffmpeg>=0.5,<1.0' 'yt-dlp>=2025.1.1' \
    'numpy==1.26.4' 'onnxruntime==1.22.0' 'psutil==7.0.0' 'tokenizers==0.22.2' 'transformers==4.57.6'
fi
AUDIO8_INSTALL_DIR="$home/model" AUDIO8_REVISION="$revision" "$home/venv/bin/python" - <<'PY'
import os
from huggingface_hub import snapshot_download
snapshot_download(
    'Edge0/Audio8-ASR-0.1B-onnx-runtime', revision=os.environ['AUDIO8_REVISION'],
    local_dir=os.environ['AUDIO8_INSTALL_DIR'], allow_patterns=[
        'asr_onnx_runtime.py', 'hotword/*.py', 'LICENSE',
        'model_bundle/*.json', 'model_bundle/*.txt', 'model_bundle/*.jinja',
        'model_bundle/audio_hidden_int8.onnx', 'model_bundle/lm_cache_prefill_int4.onnx*',
        'model_bundle/lm_cache_decode_int4.onnx*', 'model_bundle/weights/*',
        'model_bundle/qwen3_asr_feature_extractor/*',
    ],
)
PY
printf 'Audio8 installed in %s\n' "$home"
