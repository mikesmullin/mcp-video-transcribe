# 🎬 mcp-video-transcribe

**Turn a video into text using captions or a local Whisper Turbo speech model.**

The tool first fetches captions in the requested language. If neither manual
nor automatic captions are available, it downloads the audio track and runs
Whisper large-v3 Turbo locally, using an NVIDIA GPU when available. No external transcription service is needed.

## Quick start

```bash
./scripts/install-whisper.sh  # one-time: install runtime, model, yt-dlp, and NVIDIA libraries
node server.mjs
```

The server speaks newline-delimited JSON-RPC over stdio (`tools/list` +
`tools/call`), so any MCP-capable host can spawn it directly. Node.js 20+ or Bun is required. The installer needs Python 3.9–3.13
and internet access; it downloads the Whisper Turbo model (about 1.6 GB). It uses
`uv` if available, otherwise Python venv/pip. On Linux it also installs the
NVIDIA CUDA 12 and cuDNN 9 libraries (roughly 2.6 GB installed); set
`WHISPER_INSTALL_CUDA=0` for a CPU-only install. The runtime is stored in
`.whisper/`, outside Git.

## Tools

| Tool | Args | Returns |
|------|------|---------|
| `transcript` (as `video_transcribe__transcript`) | `url` (full video page URL; a bare YouTube ID also works), optional `lang` (default `en`), optional `source` (`auto` or `audio`) | `[mm:ss]` segments + full text, plus a `/tmp/*.txt` copy whose path heads the output |
| `list_caption_tracks` (as `video_transcribe__list_caption_tracks`) | `url` (same shapes as above) | `code — Language` lines |

Only the requested language is fetched (English by default). Manual subtitles
are tried first, then automatic captions. If the caption fetch fails or neither
exists, one audio-only
download is stored in a private temporary directory and transcribed locally
with faster-whisper, using batched inference and segment timestamps. Whisper
detects the spoken language; it does not translate or guarantee English output. A caption HTTP 429 triggers the audio fallback
immediately and starts a caption cooldown. If the audio download also receives
a 429, it has a separate cooldown; callers should not immediately retry. Concurrent
identical requests share work, and successful transcripts are cached in memory.
Set `source` to `audio` to skip captions and measure Whisper Turbo directly.

## Example

Input (`tools/call` → `transcript`):

```json
{ "url": "https://x.com/neuralink/status/2123890949029818800" }
```

Output (truncated):

```
Full copy of transcript: /tmp/3f9d7a1e-4b2c-4e8f-9a1d-7c6e5f0a1b2c.txt

Transcript — 36 caption segments, ~1:59 long, language: en

[0:00] GTA VI with the brain and a robot arm.
[0:04] Is this the future?
...

--- full text ---
GTA VI with the brain and a robot arm. Is this the future? ...
```

## Notes

- yt-dlp resolution: `YTDLP_BIN` → installed `.whisper/venv/bin/yt-dlp` → bundled `./yt-dlp` → `PATH`.
- `YTDLP_TIMEOUT_MS` sets the caption-fetch deadline in ms (default 60000).
- `WHISPER_TIMEOUT_MS` sets the download and inference deadline in ms (default 2 hours).
- `WHISPER_HOME` changes the installation directory; `WHISPER_PYTHON` and `WHISPER_MODEL` override individual paths.
- `WHISPER_DEVICE` can be `auto` (default), `cuda`, or `cpu`; `WHISPER_BATCH_SIZE` controls batched inference. The output reports the chosen device and transcription time (model loading and inference, excluding download).
- A long transcription can take minutes or hours on CPU. The MCP host must allow
  the request to run long enough; cancellation stops the local subprocess.
- The Whisper Turbo model is distributed under the [MIT license](https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo).
- `TRANSCRIPT_CACHE_MS` sets the in-process successful-result cache lifetime (default 30 minutes).
- `TRANSCRIPT_COOLDOWN_MS` sets the per-origin rate-limit cooldown (default 5 minutes).
- Cache, cooldown, and request deduplication are local to each server process.
