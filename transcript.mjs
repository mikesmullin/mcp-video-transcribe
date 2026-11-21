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

/**
 * Resolve a caller-supplied target to a fetchable video page URL.
 *
 * Accepts a full URL for any site yt-dlp supports (YouTube, X/Twitter,
 * …), a bare 11-character YouTube video ID, or a YouTube watch/shorts/
 * live/embed URL. Anything else is rejected loudly rather than fetched
 * as something it is not.
 */
export function resolveTarget(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('url is required');
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return `https://www.youtube.com/watch?v=${s}`;
  const m = s.match(/(?:youtu\.be\/|watch\?v=|v=|embed\/|live\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
  throw new Error(`not a video URL or YouTube video ID: ${s}`);
}

/**
 * Fetch transcript for a video page using yt-dlp subtitles.
 *
 * Tries manual (human-made) subtitles before automatic captions, in the
 * requested language then English, then any listed track. Handles VTT
 * and SRT subtitle files. Works on any site yt-dlp supports, provided
 * the page actually carries a subtitle track.
 *
 * @param {string} target - Full video page URL (or bare YouTube video ID)
 * @param {object} [options]
 * @param {string} [options.lang='en'] Preferred language code
 * @returns {Promise<Array<{text:string, offset:number, duration:number}[]>}
 */
export async function fetchTranscript(target, options = {}) {
  const { lang } = options;
  const url = resolveTarget(target);
  const ytDlp = resolveYtdlp();
  const slug = encodeURIComponent(url).slice(-60);

  // One subtitle fetch: manual (`--write-subs`) or automatic
  // (`--write-auto-subs`). A miss writes no file, which readFile turns
  // into the skip the fallback chain runs on.
  const tryFetch = async (subLang, auto) => {
    const outputTemplate = join(tmpdir(), `yt-transcript-${slug}`) || join(tmpdir(), 'yt-video');
    const kind = auto ? '--write-auto-subs' : '--write-subs';
    await execAsync(
      `"${ytDlp}" --no-update ${kind} --sub-langs "${subLang}" --skip-download --output "${outputTemplate}" "${url}"`,
      { timeout: execTimeoutMs, maxBuffer: 10 * 1024 * 1024 },
    );
    for (const ext of ['vtt', 'srt']) {
      const path = `${outputTemplate}.${subLang}.${ext}`;
      try {
        const content = await readFile(path, 'utf-8');
        await unlink(path).catch(() => { /* ignore */ });
        const parsed = ext === 'srt' ? parseSRT(content) : parseVTT(content);
        if (parsed.length) return parsed;
      } catch {
        /* no such file (or empty) — next extension */
      }
    }
    return [];
  };

  const wanted = [lang || 'en'];
  if ((lang || '').toLowerCase() !== 'en') wanted.push('en');
  // Manual subtitles first (human-made), automatic captions second.
  for (const subLang of wanted) {
    for (const auto of [false, true]) {
      try {
        const t = await tryFetch(subLang, auto);
        if (t.length) return t;
      } catch {}
    }
  }
  // Any listed track, manual then auto.
  try {
    const tracks = await listCaptionTracks(url);
    for (const t of tracks) {
      for (const auto of [false, true]) {
        try {
          const transcript = await tryFetch(t.languageCode, auto);
          if (transcript.length) return transcript;
        } catch {}
      }
    }
  } catch {}
  throw new Error(
    `No subtitles for "${url}" (tried "${(lang || 'en')}" plus available tracks)`,
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
  // (or MM:SS / SS.mmm forms, SRT's comma decimals) — take the first
  // numeric time token.
  const m = String(timestamp).match(/\d{1,2}:\d{2}(:\d{2}(?:[.,]\d{1,3})?)?/);
  if (!m) return 0;
  const parts = m[0].replace(',', '.').split(':');
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
 * Parse SubRip (.srt) captions. Same {text, offset, duration} shape as VTT:
 * numeric cue identifiers are skipped (they are never cue headers), and
 * comma decimals are normalised by parseVTTTimestamp.
 * @param {string} srtContent - SRT file content
 * @returns {Array} Parsed transcript entries
 */
function parseSRT(srtContent) {
  const transcript = [];
  const lines = srtContent.split('\n');
  const isCueStart = (l) => /-->/.test(l);

  let i = 0;
  while (i < lines.length && !isCueStart(lines[i])) i++;
  while (i < lines.length) {
    if (!isCueStart(lines[i])) { i++; continue; }
    const line = lines[i];
    const offset = parseVTTTimestamp(line.split('-->')[0]);
    const endOffset = parseVTTTimestamp(line.split('-->')[1]);
    const duration = endOffset - offset;
    const body = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (l.trim() === '' || isCueStart(l)) break;
      if (l.trim()) body.push(l.trim());
      j++;
    }
    const text = body
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    i = j;
    if (text) transcript.push({ text, offset, duration });
  }

  return transcript;
}

/**
 * List available caption tracks for a video using yt-dlp
 * @param {string} target - Full video page URL (or bare YouTube video ID)
 * @returns {Promise<Array<{languageCode, language}>>
 */
export async function listCaptionTracks(target) {
  const url = resolveTarget(target);
  const ytDlp = resolveYtdlp();
  const cmd = `"${ytDlp}" --no-update --list-subs "${url}"`;
  const { stdout } = await execAsync(cmd, { timeout: execTimeoutMs, maxBuffer: 5 * 1024 * 1024 });
  // Some sites print a formats column instead of a language name
  // ("en  vtt"); those tokens are not languages.
  const SUB_FORMATS = new Set([
    'vtt', 'srt', 'ttml', 'srv1', 'srv2', 'srv3', 'json3',
    'lrc', 'sbv', 'smi', 'ssa', 'ass', 'dfxp',
  ]);
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
      const name = match[2].trim();
      tracks.push({
        languageCode: match[1],
        language: SUB_FORMATS.has(name.toLowerCase()) ? '' : name,
      });
    }
  }
  return tracks;
}
