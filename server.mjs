#!/usr/bin/env bun
/**
 * mcp-video-transcribe — MCP stdio server for YouTube transcripts.
 *
 * Port of the daemon-v3 youtube plugin, reborn as a normal MCP server:
 * one tool, one result, no environment to discover.
 *
 * Env:
 *   YTDLP_BIN      — yt-dlp binary (default: ./yt-dlp, then PATH)
 *   YTDLP_TIMEOUT_MS — caption fetch deadline, ms (default 60000)
 */

import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runMcpStdioServer, textResult } from './mcp-stdio.mjs';
import { fetchTranscript, listCaptionTracks, resolveTarget, resolveYtdlp } from './transcript.mjs';

/**
 * Resolve the caller's `url` to a fetchable video page URL, reusing the
 * transcript module's resolver (full URL for any yt-dlp-supported site,
 * or a bare YouTube video ID). Kept here so the progress notice names
 * the resolved target, not the raw input.
 */
function resolveUrl(input) {
  return resolveTarget(input);
}

function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatTranscript(entries, lang) {
  const total = entries.length
    ? Math.floor(entries[entries.length - 1].offset / 1000 + entries[entries.length - 1].duration / 1000)
    : 0;
  const lines = entries.map((e) => `[${mmss(e.offset)}] ${e.text}`);
  const out = [
    entries.source === 'audio8'
      ? `Transcript — ${entries.length} Audio8 segments, ~${mmss(total * 1000)} long; language detected from audio, timestamps approximate`
      : `Transcript — ${entries.length} caption segments, ~${mmss(total * 1000)} long, language: ${lang || 'en'}`,
    '',
    lines.join('\n'),
    '',
    '--- full text ---',
    entries.map((e) => e.text).join(' '),
  ].join('\n');
  return out;
}

const SERVER_NAME = 'video-transcribe';
const tools = {
  transcript: {
    description:
      `Get the transcript of a video page (YouTube, X/Twitter, or any ` +
      `other site yt-dlp supports). ` +
      `The url is a full video page URL (a bare YouTube video ID also ` +
      `works); lang is the requested subtitle language (default "en"). ` +
      `Only that caption language is fetched; on caption failure, local Audio8 transcribes downloaded audio. ` +
      `If both caption and audio downloads are rate-limited, do not immediately retry.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Full video page URL (a bare YouTube video ID also works)',
        },
        lang: {
          type: 'string',
          description: 'Preferred subtitle language code (e.g. "en")',
        },
      },
      required: ['url'],
    },
    async handler({ url, lang }, ctx) {
      const target = resolveUrl(url);
      ctx?.notify?.('notifications/started', { text: `fetching transcript for ${target}` });
      const entries = await fetchTranscript(target, { lang, signal: ctx?.signal });
      ctx?.notify?.('notifications/finished', { text: `${entries.length} caption segments` });
      const body = formatTranscript(entries, lang);
      // A full copy on disk, so the transcript survives context compaction:
      // the agent (or user) can re-read or grep it later via file-io/bash.
      const filePath = `/tmp/${randomUUID()}.txt`;
      await writeFile(filePath, body + '\n', 'utf8');
      return textResult(`Full copy of transcript: ${filePath}\n\n${body}`);
    },
  },

  list_caption_tracks: {
    description:
      `List available caption tracks (language codes + names) for a video ` +
      `page (YouTube, X/Twitter, or any other site yt-dlp supports).`,
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Full video page URL (a bare YouTube video ID also works)',
        },
      },
      required: ['url'],
    },
    async handler({ url }, ctx) {
      const target = resolveUrl(url);
      const tracks = await listCaptionTracks(target, { signal: ctx?.signal });
      if (tracks.length === 0) {
        return textResult(`No caption tracks available for ${target}.`);
      }
      return textResult(tracks.map((t) => (t.language ? `${t.languageCode} — ${t.language}` : t.languageCode)).join('\n'));
    },
  },
};

process.stderr.write(
  `mcp-video-transcribe: name=${SERVER_NAME} root=${process.cwd()} yt-dlp=${resolveYtdlp()}\n`,
);

await runMcpStdioServer({ name: SERVER_NAME, version: '0.1.0', tools });
