#!/usr/bin/env bun
/**
 * YouTube transcript fetcher for mcp-video-transcribe.
 *
 * Ported from daemon-v3/plugins/youtube/transcript.mjs, adapted for the MCP
 * stdio server: same yt-dlp auto-sub approach (fast — subtitles only, no
 * audio download), same VTT parser, plus a language fallback when the
 * requested track isn't available.
 */

import { exec } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execTimeoutMs = Number(process.env.YTDLP_TIMEOUT_MS || 60000);

/** yt-dlp resolution: env override → bundled binary → legacy daemon-v3 → PATH. */
const YTDLP_CANDIDATES = [
  process.env.YTDLP_BIN,
  join(__dirname, 'yt-dlp'),
  join(__dirname, '..', 'daemon-v3', 'plugins', 'youtube', 'yt-dlp'),
];

export function resolveYtdlp() {
  for (const p of YTDLP_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  for (const d of (process.env.PATH || '').split(':')) {
    const p = join(d, 'yt-dlp');
    if (existsSync(p)) return p;
  }
  return 'yt-dlp';
}

function videoUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

/**
 * Fetch transcript for a YouTube video using yt-dlp auto-subtitles.
 *
 * @param {string} videoId - The YouTube video ID (or URL; extracted below)
 * @param {object} [options]
 * @param {string} [options.lang='en'] Preferred language code
 * @returns {Promise<Array<{text:string, offset:number, duration:number}[]>}
 */
export async function fetchTranscript(videoId, options = {}) {
  const { lang } = options;
  const ytDlp = resolveYtdlp();

  const tryFetch = async (subLang) => {
    const outputTemplate = join(tmpdir(), `yt-transcript-${encodeURIComponent(videoId).slice(0, 60)}` || 'video');
    await execAsync(
      `"${ytDlp}" --write-auto-sub --sub-lang "${subLang}" --skip-download --output "${outputTemplate}" "${videoUrl(videoId)}"`,
      { timeout: execTimeoutMs, maxBuffer: 10 * 1024 * 1024 },
    );
    const vttPath = `${outputTemplate}.${subLang}.vtt`;
    const vttContent = await readFile(vttPath, 'utf-8');
    await unlink(vttPath).catch(() => { /* ignore */ });
    return parseVTT(vttContent);
  };

  // 1) Fast path: requested language, exactly as daemon-v3 did.
  try {
    const t = await tryFetch(lang || 'en');
    if (t.length) return t;
  } catch {}
  // 2) English fallback.
  if ((lang || '').toLowerCase() !== 'en') {
    try {
      const t = await tryFetch('en');
      if (t.length) return t;
    } catch {}
  }
  // 3) Any available auto-sub title.
  try {
    const tracks = await listCaptionTracks(videoId);
    for (const t of tracks) {
      try {
        const transcript = await tryFetch(t.languageCode);
        if (transcript.length) return transcript;
      } catch {}
    }
  } catch {}
  throw new Error(
    `No automatic subtitles for "${videoId}" (tried "${lang || 'en'}" plus available tracks)`,
  );
}

/**
 * Parse WebVTT format captions.
 * @param {string} vttContent - VTT file content
 * @returns {Array} Parsed transcript entries
 */
function parseVTT(vttContent) {
  const transcript = [];
  const lines = vttContent.split('\n');
  const isCueStart = (l) => /-->/.test(l);

  // Cue body: all non-empty lines until the next empty line or next cue header.
  const cueText = (from) => {
    const body = [];
    let j = from;
    while (j < lines.length) {
      const l = lines[j];
      // A truly blank line or the next cue header ends the body; a
      // whitespace-only line is legitimate VTT text (YouTube's auto subs
      // start cues with one).
      if (l === '' || isCueStart(l)) break;
      if (l.trim()) body.push(l.trim());
      j++;
    }
    return body;
  };

  // Skip the VTT header block (WEBVTT / Kind / Language) to the first cue.
  let i = 0;
  while (i < lines.length && !isCueStart(lines[i])) i++;
  while (i < lines.length) {
    if (!isCueStart(lines[i])) { i++; continue; }
    const line = lines[i];
    const offset = parseVTTTimestamp(line.split('-->')[0]);
    const endOffset = parseVTTTimestamp(line.split('-->')[1]);
    const duration = endOffset - offset;
    const text = cueText(i + 1)
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    i++;
    if (text) transcript.push({ text, offset, duration });
  }

  return transcript;
}

function parseVTTTimestamp(timestamp) {
  // Cue heads may be "00:00:01.910" or "00:00:01.910 align:start position:0%"
  // (or MM:SS / SS.mmm forms) — take the first numeric time token.
  const m = String(timestamp).match(/\d{1,2}:\d{2}(:\d{2}(?:\.\d{1,3})?)?/);
  if (!m) return 0;
  const parts = m[0].split(':');
  let hours = 0,
    minutes = 0,
    seconds = 0;

  if (parts.length === 3) {
    // HH:MM:SS.mmm
    hours = parseInt(parts[0], 10) || 0;
    minutes = parseInt(parts[1], 10) || 0;
    seconds = parseFloat(parts[2]) || 0;
  } else {
    // MM:SS.mmm (or SS.mmm)
    minutes = parseInt(parts[0], 10) || 0;
    seconds = parseFloat(parts[1]) || 0;
  }

  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

/**
 * List available caption tracks for a video using yt-dlp
 * @param {string} videoId - The YouTube video ID or full URL
 * @returns {Promise<Array<{languageCode, language}>>
 */
export async function listCaptionTracks(videoId) {
  const ytDlp = resolveYtdlp();
  const cmd = `"${ytDlp}" --list-subs "${videoUrl(videoId)}"`;
  const { stdout } = await execAsync(cmd, { timeout: execTimeoutMs, maxBuffer: 5 * 1024 * 1024 });
  const tracks = [];
  const lines = stdout.split('\n');
  let inSubtitlesSection = false;
  for (const line of lines) {
    if (line.includes('Available subtitles') || line.includes('automatic captions')) {
      inSubtitlesSection = true;
      continue;
    }
    if (!inSubtitlesSection || !line.trim()) continue;
    const match = line.match(/^([a-z]{2}(?:-[A-Z]{2})?)\s+(.+?)(?:\s|$)/);
    if (match) {
      tracks.push({
        languageCode: match[1],
        language: match[2].trim(),
      });
    }
  }
  return tracks;
}
