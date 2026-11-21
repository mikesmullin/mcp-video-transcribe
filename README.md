# 🎬 mcp-video-transcribe

**Turn a video into text using captions or a local Audio8 speech model.**

The tool first fetches captions in the requested language. If neither manual
nor automatic captions are available, it downloads the audio track and runs
Audio8-ASR locally on the CPU. No external transcription service is needed.

## Quick start

```bash
./scripts/install-audio8.sh  # one-time: install CPU runtime, model, yt-dlp, and ffmpeg
node server.mjs
```

The server speaks newline-delimited JSON-RPC over stdio (`tools/list` +
`tools/call`), so any MCP-capable host can spawn it directly. Node.js 20+ or Bun is required. The installer needs Python 3.10–3.12
and internet access; it downloads the Audio8 model (about 645 MB). It uses
`uv` if available, otherwise Python venv/pip, and installs ffmpeg locally via
`imageio-ffmpeg`. The runtime is stored in `.audio8/`, outside Git.

## Tools

| Tool | Args | Returns |
|------|------|---------|
| `transcript` (as `video_transcribe__transcript`) | `url` (full video page URL; a bare YouTube ID also works), optional `lang` (default `en`) | `[mm:ss]` segments + full text, plus a `/tmp/*.txt` copy whose path heads the output |
| `list_caption_tracks` (as `video_transcribe__list_caption_tracks`) | `url` (same shapes as above) | `code — Language` lines |

Only the requested language is fetched (English by default). Manual subtitles
are tried first, then automatic captions. If the caption fetch fails or neither
exists, one audio-only
download is converted to mono 16 kHz WAV in a private temporary directory and
transcribed locally in short chunks. Audio8 detects the spoken language; it
does not translate or guarantee English output. Its timestamps mark chunk
boundaries and are approximate. A caption HTTP 429 triggers the audio fallback
immediately and starts a caption cooldown. If the audio download also receives
a 429, it has a separate cooldown; callers should not immediately retry. Concurrent
identical requests share work, and successful transcripts are cached in memory.

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

- yt-dlp resolution: `YTDLP_BIN` → installed `.audio8/venv/bin/yt-dlp` → bundled `./yt-dlp` → `PATH`.
- `YTDLP_TIMEOUT_MS` sets the caption-fetch deadline in ms (default 60000).
- `AUDIO8_TIMEOUT_MS` sets the download and inference deadline in ms (default 2 hours).
- `AUDIO8_HOME` changes the installation directory; `AUDIO8_PYTHON`, `AUDIO8_RUNTIME`, and `FFMPEG_BIN` override individual paths.
- A long transcription can take minutes or hours on CPU. The MCP host must allow
  the request to run long enough; cancellation stops the local subprocess.
- Audio8 is distributed under [CC BY-NC 4.0](https://huggingface.co/Edge0/Audio8-ASR-0.1B-onnx-runtime/blob/main/README.md); commercial use is not permitted by that license.
- `TRANSCRIPT_CACHE_MS` sets the in-process successful-result cache lifetime (default 30 minutes).
- `TRANSCRIPT_COOLDOWN_MS` sets the per-origin rate-limit cooldown (default 5 minutes).
- Cache, cooldown, and request deduplication are local to each server process.
