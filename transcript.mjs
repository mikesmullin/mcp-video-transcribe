#!/usr/bin/env bun
/**
 * YouTube transcript fetcher for mcp-video-transcribe.
 *
 * Ported from daemon-v3/plugins/youtube/transcript.mjs, adapted for the MCP
 * stdio server: same yt-dlp auto-sub approach (fast — subtitles only, no
 * audio download) and a local Whisper Turbo fallback when captions are absent.
 */

import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// AbortSignal makes Node reject before the child has necessarily exited.
// Wait for close, escalating to SIGKILL if a subprocess ignores SIGTERM.
async function execFileClosed(command, args, options) {
  const pending = execFileAsync(command, args, options);
  const child = pending.child;
  const closed = new Promise(resolve => child.once('close', resolve));
  let timer;
  const abort = () => { timer = setTimeout(() => child.kill('SIGKILL'), 250); };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try { return await pending; }
  catch (err) { await closed; throw err; }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const positiveMs = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const execTimeoutMs = positiveMs('YTDLP_TIMEOUT_MS', 60000);
const audioTimeoutMs = positiveMs('WHISPER_TIMEOUT_MS', 2 * 60 * 60 * 1000);
const projectDir = dirname(fileURLToPath(import.meta.url));
const cacheMs = positiveMs('TRANSCRIPT_CACHE_MS', 30 * 60 * 1000);
const cooldownMs = positiveMs('TRANSCRIPT_COOLDOWN_MS', 5 * 60 * 1000);
const cache = new Map();
const inFlight = new Map();
const cooldowns = new Map();
const MAX_CACHE = 100;

function checkCooldown(url, kind = 'caption') {
  const origin = `${kind}:${new URL(url).origin}`;
  const until = cooldowns.get(origin) || 0;
  if (until > Date.now()) throw new Error(`${kind === 'caption' ? 'Caption fetch' : 'Audio download'} rate-limited; retry after ${new Date(until).toISOString()}. Do not retry immediately.`);
  cooldowns.delete(origin);
  return origin;
}

async function runYtdlp(args, url, deadline, signal, kind = 'caption') {
  const origin = checkCooldown(url, kind);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Transcript request timed out.');
  try {
    return await execFileClosed(resolveYtdlp(), [
      '--no-update', '--retries', '0', '--fragment-retries', '0', '--extractor-retries', '0', ...args,
    ], { timeout: remaining, signal, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    if (signal?.aborted) throw new Error('Transcript request cancelled.');
    const detail = `${err?.stderr || ''} ${err?.stdout || ''} ${err?.message || ''}`;
    if (/\b429\b|too many requests/i.test(detail)) {
      cooldowns.set(origin, Date.now() + cooldownMs);
      throw new Error(`${kind === 'caption' ? 'Caption fetch' : 'Audio download'} returned HTTP 429 (rate limited). Do not retry for ${Math.ceil(cooldownMs / 1000)} seconds.`);
    }
    if (err?.killed || Date.now() >= deadline) throw new Error('Transcript request timed out.');
    throw new Error(`${kind === 'caption' ? 'Caption fetch' : 'Audio download'} failed: ${(err?.stderr || err?.message || String(err)).trim()}`);
  }
}

// A subscriber can stop waiting without cancelling another caller's request.
// If all subscribers leave, abort the underlying yt-dlp process.
function subscribe(entry, signal) {
  if (signal?.aborted) return Promise.reject(new Error('Transcript request cancelled.'));
  entry.users++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      entry.users--;
      if (!entry.users && !entry.done) entry.controller.abort();
      fn(value);
    };
    const abort = () => {
      const error = new Error('Transcript request cancelled.');
      if (entry.users === 1 && !entry.done) {
        // Do not acknowledge the last cancellation until the child has exited
        // and temporary files have been removed.
        entry.controller.abort();
        entry.promise.then(() => finish(reject, error), () => finish(reject, error));
      } else finish(reject, error);
    };
    signal?.addEventListener('abort', abort, { once: true });
    entry.promise.then(v => finish(resolve, v), e => finish(reject, e));
    if (signal?.aborted) abort();
  });
}

/** yt-dlp resolution: env override → installed binary → bundled binary → PATH. */
const YTDLP_CANDIDATES = [
  process.env.YTDLP_BIN,
  join(process.env.WHISPER_HOME || join(__dirname, '.whisper'), 'venv', 'bin', 'yt-dlp'),
  join(__dirname, 'yt-dlp'),
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

/** Fetch only the requested language (English by default), manual then auto. */
export async function fetchTranscript(target, options = {}) {
  const url = resolveTarget(target);
  const lang = String(options.lang || 'en').trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(lang)) throw new Error('Invalid subtitle language code.');
  if (options.signal?.aborted) throw new Error('Transcript request cancelled.');
  const source = options.source || 'auto';
  if (!['auto', 'audio'].includes(source)) throw new Error('Source must be auto or audio.');
  const key = `${url}\0${lang.toLowerCase()}\0${options.fallback === false ? 'captions' : source}`;
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) return cached.entries;
  if (cached) cache.delete(key);
  let entry = inFlight.get(key);
  if (entry?.controller.signal.aborted) { inFlight.delete(key); entry = undefined; }
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, users: 0, done: false, promise: null };
    const current = entry;
    entry.promise = downloadTranscript(url, lang, controller.signal, options.fallback !== false, source).then(entries => {
      if (!controller.signal.aborted) {
        cache.delete(key);
        cache.set(key, { entries, until: Date.now() + cacheMs });
        while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      }
      return entries;
    }).finally(() => {
      current.done = true;
      if (inFlight.get(key) === current) inFlight.delete(key);
    });
    inFlight.set(key, entry);
  }
  return subscribe(entry, options.signal);
}

async function downloadTranscript(url, lang, signal, fallback, source) {
  const deadline = Date.now() + execTimeoutMs;
  const dir = await mkdtemp(join(tmpdir(), 'yt-transcript-'));
  const output = join(dir, 'captions');
  try {
    if (source === 'audio') return await transcribeAudio(url, dir, signal);
    let captionError;
    try {
      for (const kind of ['--write-subs', '--write-auto-subs']) {
        if (signal.aborted) throw new Error('Transcript request cancelled.');
        await runYtdlp([kind, '--sub-langs', lang, '--sub-format', 'vtt/srt', '--skip-download', '--output', output, '--', url], url, deadline, signal);
        for (const ext of ['vtt', 'srt']) {
          let content;
          try { content = await readFile(`${output}.${lang}.${ext}`, 'utf-8'); }
          catch (err) { if (err.code === 'ENOENT') continue; throw err; }
          const parsed = ext === 'srt' ? parseSRT(content) : parseVTT(content);
          if (parsed.length) return parsed;
        }
      }
      captionError = new Error(`No ${lang.toLowerCase() === 'en' ? 'English' : lang} transcript available.`);
    } catch (err) {
      if (signal.aborted) throw new Error('Transcript request cancelled.');
      captionError = err;
    }
    if (!fallback) throw captionError;
    try {
      return await transcribeAudio(url, dir, signal);
    } catch (err) {
      if (signal.aborted) throw new Error('Transcript request cancelled.');
      throw new Error(`Caption fetch failed: ${captionError.message} Whisper Turbo fallback failed: ${err.message}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Download audio once and transcribe with the installed Whisper Turbo model. */
async function transcribeAudio(url, dir, signal) {
  const home = process.env.WHISPER_HOME || join(projectDir, '.whisper');
  const python = process.env.WHISPER_PYTHON || join(home, 'venv', 'bin', 'python');
  const model = process.env.WHISPER_MODEL || join(home, 'model');
  if (!existsSync(python) || !existsSync(join(model, 'model.bin'))) {
    throw new Error('Whisper Turbo is not installed. Run ./scripts/install-whisper.sh.');
  }
  const deadline = Date.now() + audioTimeoutMs;
  const template = join(dir, 'audio.%(ext)s');
  await runYtdlp(['--no-playlist', '-f', 'bestaudio/best', '--output', template, '--', url], url, deadline, signal, 'audio');
  const files = (await readdir(dir)).filter(name => name.startsWith('audio.') && !name.endsWith('.part') && !name.endsWith('.ytdl'));
  if (files.length !== 1) throw new Error('Audio download did not produce one audio file.');
  const audio = join(dir, files[0]);
  const left = deadline - Date.now();
  if (left <= 0) throw new Error('Whisper Turbo transcription timed out.');
  // CTranslate2 needs CUDA library paths at process start, before Python
  // imports it. They live in this tool's venv, not another project's venv.
  const lib = join(home, 'venv', 'lib');
  let cudaPaths = [];
  try {
    const versions = (await readdir(lib)).filter(name => name.startsWith('python'));
    cudaPaths = versions.flatMap(v => ['cublas', 'cudnn'].map(n => join(lib, v, 'site-packages', 'nvidia', n, 'lib'))).filter(existsSync);
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const env = { ...process.env, LD_LIBRARY_PATH: [...cudaPaths, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  let result;
  try {
    result = await execFileClosed(python, [join(projectDir, 'scripts', 'whisper-transcribe.py'), model, audio],
      { signal, timeout: left, maxBuffer: 10 * 1024 * 1024, env });
  } catch (err) {
    if (signal.aborted) throw new Error('Transcript request cancelled.');
    if (err.killed || Date.now() >= deadline) throw new Error('Whisper Turbo transcription timed out.');
    throw new Error(`Whisper Turbo failed: ${(err.stderr || err.message || String(err)).trim()}`);
  }
  let output;
  try { output = JSON.parse(result.stdout); } catch { throw new Error('Whisper Turbo returned an invalid transcript.'); }
  const entries = output.entries;
  if (!Array.isArray(entries) || entries.length === 0 || entries.some(e => typeof e.text !== 'string' || !Number.isFinite(e.offset) || !Number.isFinite(e.duration))) {
    throw new Error('Whisper Turbo returned no usable transcript.');
  }
  Object.defineProperties(entries, {
    source: { value: 'whisper' },
    device: { value: output.device },
    transcriptionSeconds: { value: output.transcriptionSeconds },
    language: { value: output.language },
  });
  return entries;
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
export async function listCaptionTracks(target, options = {}) {
  const url = resolveTarget(target);
  const { stdout } = await runYtdlp(['--list-subs', '--', url], url, Date.now() + execTimeoutMs, options.signal);
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
