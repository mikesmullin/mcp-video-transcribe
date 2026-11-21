# mcp-video-transcribe

YouTube transcript MCP server (stdio, newline-delimited JSON-RPC).

Port of the daemon-v3 `youtube` plugin's transcript path: yt-dlp fetches
**auto-generated subtitles only** (no audio/video download), the VTT is
parsed to timestamped segments, and the result is returned as text with a
`--- full text ---` tail. ~2 s for a 75-minute video, no GPU, no API key.

## Tools

| Tool | Args | Returns |
|------|------|---------|
| `transcript` (as `video_transcribe__transcript`) | `videoId` (ID or full watch/shorts/live URL), optional `lang` (default `en`), optional `maxChars` | `[mm:ss] segment…` lines + full text |
| `list_caption_tracks` (as `video_transcribe__list_caption_tracks`) | `videoId` | `code — Language` lines |

Language fallback: requested track → English → any listed auto-caption
track → error (`No automatic subtitles for …`). Videos with no captions at
all fail loudly so the caller can fall back to a download+whisper pipeline.

## yt-dlp resolution

`YTDLP_BIN` → `./yt-dlp` (bundled, same 2025.12.08 binary as daemon-v3) →
`../daemon-v3/plugins/youtube/yt-dlp` → `PATH`. `YTDLP_TIMEOUT_MS` per call
(default 60000).

## Run

```bash
bun /workspace/mcp-video-transcribe/server.mjs
```

chat `.angela/mcp.json` preset (mirrors the other local servers):

```json
"video-transcribe": {
  "command": "bun",
  "args": ["/workspace/mcp-video-transcribe/server.mjs"],
  "cwd": "${projectRoot}",
  "timeout": 600,
  "exposure": "direct",
  "env": { "YTDLP_TIMEOUT_MS": "60000" }
}
```
