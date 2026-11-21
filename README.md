# 🎬 mcp-video-transcribe

**Turn any captioned video into text in ~2 seconds — no downloads, no GPU, no API key.**

Getting a video into an LLM usually means downloading the whole file,
extracting the audio, and running a local transcription model for
minutes. mcp-video-transcribe skips all of that: it pulls the page's
own subtitle track — YouTube auto-captions, X/Twitter captions, or any
other site yt-dlp supports — and hands it back as timestamped text plus
one clean full-text block. A 75-minute video resolves in about two
seconds.

## Quick start

```bash
bun /workspace/mcp-video-transcribe/server.mjs
```

The server speaks newline-delimited JSON-RPC over stdio (`tools/list` +
`tools/call`), so any MCP-capable host can spawn it directly. No config
required — yt-dlp ships bundled.

## Tools

| Tool | Args | Returns |
|------|------|---------|
| `transcript` (as `video_transcribe__transcript`) | `url` (full video page URL; a bare YouTube ID also works), optional `lang` (default `en`) | `[mm:ss]` segments + full text |
| `list_caption_tracks` (as `video_transcribe__list_caption_tracks`) | `url` (same shapes as above) | `code — Language` lines |

Language fallback: requested track → English → any listed auto-caption
track → error (`No automatic subtitles for …`). Videos with no captions
at all fail loudly, so the caller knows to fall back to a
download-and-transcribe pipeline instead.

## Example

Input (`tools/call` → `transcript`):

```json
{ "url": "https://x.com/neuralink/status/2123890949029818800" }
```

Output (truncated):

```
Transcript — 36 caption segments, ~1:59 long, language: en

[0:00] GTA VI with the brain and a robot arm.
[0:04] Is this the future?
...

--- full text ---
GTA VI with the brain and a robot arm. Is this the future? ...
```

## Notes

- yt-dlp resolution: `YTDLP_BIN` env → bundled `./yt-dlp` → `PATH`.
- `YTDLP_TIMEOUT_MS` sets the per-call timeout in ms (default 60000).
