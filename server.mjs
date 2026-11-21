#!/usr/bin/env bun
/**
 * mcp-video-transcribe — MCP stdio server for YouTube transcripts.
 *
 * Port of the daemon-v3 youtube plugin, reborn as a normal MCP server:
 * one tool, one result, no environment to discover.
 *
 * Env:
 *   YTDLP_BIN      — yt-dlp binary (default: ./yt-dlp, then PATH)
 *   YTDLP_TIMEOUT_MS — per yt-dlp call timeout, ms (default 60000)
 */

import { runMcpStdioServer, textResult } from '../mcp/shared/mcp-stdio.mjs';
import { fetchTranscript, listCaptionTracks, resolveYtdlp } from './transcript.mjs';

function extractVideoId(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('videoId is required');
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const url = s.match(/(?:youtu\.be\/|watch\?v=|v=|embed\/|live\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (url) return url[1];
  const fallback = s.match(/[a-zA-Z0-9_-]{11}/);
  if (fallback) return fallback[0];
  throw new Error(`no YouTube video ID found in: ${s}`);
}

function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatTranscript(entries, lang, maxChars = 0) {
  const total = entries.length
    ? Math.floor(entries[entries.length - 1].offset / 1000 + entries[entries.length - 1].duration / 1000)
    : 0;
  const lines = entries.map((e) => `[${mmss(e.offset)}] ${e.text}`);
  const out = [
    `Transcript — ${entries.length} caption segments, ~${mmss(total * 1000)} long, language: ${lang || 'en'}`,
    '',
    lines.join('\n'),
    '',
    '--- full text ---',
    entries.map((e) => e.text).join(' '),
  ].join('\n');
  if (maxChars > 0 && out.length > maxChars) {
    return out.slice(0, maxChars).replace(/\s+$/, '') + '\n... (truncated to ' + maxChars + ' chars)';
  }
  return out;
}

const SERVER_NAME = 'video-transcribe';
const tools = {
  transcript: {
    description:
      `Get the full transcript of a YouTube video. ` +
      `The videoId is an 11-character YouTube ID or a full watch URL; ` +
      `lang is the preferred subtitle language (default "en"; ` +
      `falls back to English then any available auto-caption track).`,
    inputSchema: {
      type: 'object',
      properties: {
        videoId: {
          type: 'string',
          description: 'YouTube video ID or full watch URL',
        },
        lang: {
          type: 'string',
          description: 'Preferred subtitle language code (e.g. "en")',
        },
        maxChars: {
          type: 'number',
          description: 'Optional cap on the returned text length in characters',
        },
      },
      required: ['videoId'],
    },
    async handler({ videoId, lang, maxChars }, ctx) {
      const id = extractVideoId(videoId);
      ctx?.notify?.('notifications/started', { text: `fetching transcript for ${id}` });
      const entries = await fetchTranscript(id, { lang });
      ctx?.notify?.('notifications/finished', { text: `${entries.length} caption segments` });
      return textResult(formatTranscript(entries, lang, maxChars ? Number(maxChars) : 0));
    },
  },

  list_caption_tracks: {
    description:
      `List available automatic caption tracks (language codes + names) for a YouTube video. ` +
      `The videoId is an 11-character YouTube ID or a full watch URL.`,
    inputSchema: {
      type: 'object',
      properties: {
        videoId: {
          type: 'string',
          description: 'YouTube video ID or full watch URL',
        },
      },
      required: ['videoId'],
    },
    async handler({ videoId }) {
      const id = extractVideoId(videoId);
      const tracks = await listCaptionTracks(id);
      if (tracks.length === 0) {
        return textResult(`No automatic caption tracks available for ${id}.`);
      }
      return textResult(tracks.map((t) => `${t.languageCode} — ${t.language}`).join('\n'));
    },
  },
};

process.stderr.write(
  `mcp-video-transcribe: name=${SERVER_NAME} root=${process.cwd()} yt-dlp=${resolveYtdlp()}\n`,
);

await runMcpStdioServer({ name: 'youtube', version: '0.1.0', tools });
