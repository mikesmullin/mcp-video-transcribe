#!/usr/bin/env bash
# Install faster-whisper Turbo, its CPU runtime and optional NVIDIA libraries.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
home="${WHISPER_HOME:-$root/.whisper}"
revision=0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf
python="${WHISPER_INSTALL_PYTHON:-}"
if [[ -z "$python" ]]; then
  if command -v python3.12 >/dev/null; then python=python3.12; else python=python3; fi
fi
"$python" -c 'import sys; assert (3,9) <= sys.version_info[:2] <= (3,13), "Whisper requires Python 3.9–3.13"'
mkdir -p "$home"
packages=('faster-whisper==1.2.1' 'av==17.0.1' 'ctranslate2==4.7.1' 'huggingface_hub>=0.34,<1.0' 'yt-dlp>=2025.1.1')
if [[ "$(uname -s)" == Linux && "${WHISPER_INSTALL_CUDA:-1}" != 0 ]]; then
  packages+=('nvidia-cublas-cu12' 'nvidia-cudnn-cu12==9.*')
fi
if command -v uv >/dev/null; then
  uv venv --allow-existing --python "$python" "$home/venv"
  uv pip install --python "$home/venv/bin/python" "${packages[@]}"
else
  "$python" -m venv "$home/venv"
  "$home/venv/bin/python" -m pip install "${packages[@]}"
fi
WHISPER_INSTALL_DIR="$home/model" WHISPER_REVISION="$revision" "$home/venv/bin/python" - <<'PY'
import os
from huggingface_hub import snapshot_download
snapshot_download('mobiuslabsgmbh/faster-whisper-large-v3-turbo',
                  revision=os.environ['WHISPER_REVISION'], local_dir=os.environ['WHISPER_INSTALL_DIR'],
                  allow_patterns=['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.json', 'preprocessor_config.json'])
PY
printf 'Whisper Turbo installed in %s\n' "$home"
