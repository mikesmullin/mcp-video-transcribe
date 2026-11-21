#!/usr/bin/env bun
/**
 * transcribe-local.mjs — local-file speech-to-text via audio8 (CPU ONNX).
 *
 * Usage: bun transcribe-local.mjs <audio-or-video-file> [segment_seconds=60]
 *
 * Pipeline: ffmpeg -> 16 kHz mono WAV -> N-second segments -> audio8
 * `transcribe` binary per segment -> `[mm:ss]` timestamped transcript +
 * full-text tail (same shape as mcp-youtube's transcript output, so agents
 * see one format).
 *
 * Needs: ffmpeg/ffprobe, the audio8 `transcribe` binary, and the audio8 ONNX
 * bundle (~/.cache/audio8-asr-onnx, 647 MB).
 * Override with: TRANSCRIBE_BIN=..., AUDIO8_ASR_BUNDLE=...
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TRANSCRIBE_BIN =
  process.env.TRANSCRIBE_BIN ?? '/workspace/perception-voice/target/release/transcribe';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    const tail = (r.stderr || '').trim().split('\n').at(-1) || `exit ${r.status}`;
    throw new Error(`${cmd} failed: ${tail}`);
  }
  return (r.stdout || '').trim();
}

function checkTool(cmd) {
  const r = spawnSync(cmd, ['-version'], { encoding: 'utf8' });
  if (r.status !== 0 && r.error) {
    throw new Error(`required tool not found: ${cmd}`);
  }
}

function mmss(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Pull the transcribed sentence out of the `transcribe` binary's output. */
function extractText(output) {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('text:'));
  if (!line) return '';
  return line
    .slice('text:'.length)
    .trim()
    .replace(/^"|"$/g, '');
}

function main() {
  const [input, segArg] = process.argv.slice(2);
  if (!input) {
    console.error('usage: transcribe-local.mjs <audio-or-video-file> [segment_seconds=60]');
    process.exit(1);
  }
  if (!existsSync(input)) {
    console.error(`error: no such file: ${input}`);
    process.exit(1);
  }
  try {
    checkTool('ffmpeg');
    checkTool('ffprobe');
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  if (!existsSync(TRANSCRIBE_BIN)) {
    console.error(`error: audio8 transcribe binary not found: ${TRANSCRIBE_BIN}`);
    process.exit(1);
  }

  const SEG = Math.max(5, Number(segArg) || 60);
  const tmp = mkdtempSync(join(tmpdir(), 'a8local-'));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    // Normalise to 16 kHz mono WAV first (handles video + any audio codec).
    const src = join(tmp, 'src.wav');
    run('ffmpeg', ['-y', '-v', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', src]);

    const dur = Number(
      run('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        src,
      ]),
    );
    if (!Number.isFinite(dur) || dur < 1) throw new Error('could not read audio duration');

    const stamped = [];
    const full = [];
    let segments = 0;
    for (let start = 0; start < Math.floor(dur); start += SEG) {
      const seg = join(tmp, 'seg.wav');
      run('ffmpeg', ['-y', '-v', 'error', '-ss', String(start), '-t', String(SEG), '-i', src, '-c', 'copy', seg]);
      const text = extractText(run(TRANSCRIBE_BIN, [seg]));
      if (text) {
        stamped.push(`[${mmss(start)}] ${text}`);
        full.push(text);
        segments++;
      }
    }

    console.log(stamped.join('\n'));
    console.log('');
    console.log('--- full text ---');
    console.log(full.join(' ').replace(/ {2,}/g, ' '));
    console.log('');
    console.log(`(transcribed ${segments} segment(s) of ${SEG}s from ${input} via audio8)`);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

main();
