# 🎬 mcp-video-transcribe

**Turn any YouTube video into text in ~2 seconds — no downloads, no GPU, no API key.**

Getting a video into an LLM usually means downloading the whole file,
extracting the audio, and running a local transcription model for
minutes. mcp-video-transcribe skips all of that: it pulls YouTube's own
auto-generated captions straight off the video page and hands them back
as timestamped text plus one clean full-text block. A 75-minute video
resolves in about two seconds.

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
| `transcript` (as `video_transcribe__transcript`) | `videoId` (ID or full watch/shorts/live URL), optional `lang` (default `en`) | `[mm:ss]` segments + full text |
| `list_caption_tracks` (as `video_transcribe__list_caption_tracks`) | `videoId` | `code — Language` lines |

Language fallback: requested track → English → any listed auto-caption
track → error (`No automatic subtitles for …`). Videos with no captions
at all fail loudly, so the caller knows to fall back to a
download-and-transcribe pipeline instead.

## Example

Input (`tools/call` → `transcript`):

```json
{ "videoId": "https://www.youtube.com/watch?v=ZC7rQ3BYu6I" }
```

Output (truncated):

```
Transcript — 3562 caption segments, ~74:45 long, language: en

[0:00] Ladies and gentlemen, uh, we're doing a
[0:01] Ladies and gentlemen, uh, we're doing a
...

--- full text ---
Ladies and gentlemen, uh, we're doing a few shows here. If you go to ...
```

## Notes

- yt-dlp resolution: `YTDLP_BIN` env → bundled `./yt-dlp` → `PATH`.
- `YTDLP_TIMEOUT_MS` sets the per-call timeout in ms (default 60000).
