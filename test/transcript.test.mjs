import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'video-transcribe-test-'));
const bin = join(dir, 'fake-ytdlp');
const log = join(dir, 'calls');
process.env.YTDLP_BIN = bin;
process.env.MOCK_LOG = log;
process.env.YTDLP_TIMEOUT_MS = '700';
process.env.TRANSCRIPT_COOLDOWN_MS = '30000';
await writeFile(bin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(args) + '\\n');
const mode = process.env.MOCK_MODE;
if (mode === '429' || (mode === '429-caption' && !args.includes('-f'))) { console.error('ERROR: HTTP Error 429: Too Many Requests'); process.exit(1); }
if (mode === 'failure' || (mode === 'failure-caption' && !args.includes('-f'))) { console.error('network failure'); process.exit(1); }
if (mode === 'delay') awaitDelay(); else finish();
function awaitDelay() { setTimeout(finish, Number(process.env.MOCK_DELAY || 200)); }
function finish() {
  if ((mode === 'fallback' || mode === 'fallback-real' || mode === '429-caption' || mode === 'failure-caption') && args.includes('-f')) {
    const out = args[args.indexOf('--output') + 1];
    if (mode === 'fallback-real') fs.copyFileSync(process.env.AUDIO8_INTEGRATION_AUDIO, out.replace('%(ext)s', 'wav'));
    else fs.writeFileSync(out.replace('%(ext)s', 'm4a'), 'audio');
  }
  if (mode !== 'missing' && mode !== 'fallback' && mode !== 'fallback-real' && mode !== '429-caption' && mode !== 'failure-caption' && args.includes('--write-auto-subs')) {
    const out = args[args.indexOf('--output') + 1];
    const lang = args[args.indexOf('--sub-langs') + 1];
    fs.writeFileSync(out + '.' + lang + '.vtt', 'WEBVTT\\n\\n00:00:00.000 --> 00:00:02.000\\nHello there\\n');
  }
}
`, { mode: 0o755 });
const { fetchTranscript, listCaptionTracks } = await import('../transcript.mjs');
after(() => rm(dir, { recursive: true, force: true }));
async function calls() { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } }
async function reset(mode) { process.env.MOCK_MODE = mode; await writeFile(log, ''); }
async function setupFakeAudio(name) {
  const { mkdir } = await import('node:fs/promises');
  const runtime = join(dir, `${name}-model`);
  await mkdir(join(runtime, 'model_bundle'), { recursive: true });
  await writeFile(join(runtime, 'asr_onnx_runtime.py'), '');
  await writeFile(join(runtime, 'model_bundle', 'metadata.json'), '{}');
  const python = join(dir, `${name}-python`);
  const ffmpeg = join(dir, `${name}-ffmpeg`);
  await writeFile(python, `#!/usr/bin/env node\nconsole.log(JSON.stringify([{text:'spoken words',offset:0,duration:10000}]))\n`, { mode: 0o755 });
  await writeFile(ffmpeg, `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.argv.at(-1), 'wav')\n`, { mode: 0o755 });
  process.env.AUDIO8_RUNTIME = runtime;
  process.env.AUDIO8_PYTHON = python;
  process.env.FFMPEG_BIN = ffmpeg;
}
function resetFakeAudio() {
  delete process.env.AUDIO8_RUNTIME;
  delete process.env.AUDIO8_PYTHON;
  delete process.env.FFMPEG_BIN;
}


test('missing English tries only manual and automatic English once each', async () => {
  await reset('missing');
  await assert.rejects(fetchTranscript('https://missing.example/video', { fallback: false }), /No English transcript available/);
  const rows = await calls();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(a => a[a.indexOf('--sub-langs') + 1]), ['en', 'en']);
  assert.ok(rows[0].includes('--write-subs'));
  assert.ok(rows[1].includes('--write-auto-subs'));
  assert.ok(rows.every(a => !a.includes('--list-subs') && a.includes('--retries')));
});

test('missing captions download audio once and invoke the standalone Audio8 fallback', async () => {
  await reset('fallback');
  const { mkdir } = await import('node:fs/promises');
  const runtime = join(dir, 'model');
  await mkdir(join(runtime, 'model_bundle'), { recursive: true });
  await writeFile(join(runtime, 'asr_onnx_runtime.py'), '');
  await writeFile(join(runtime, 'model_bundle', 'metadata.json'), '{}');
  const python = join(dir, 'fake-python');
  const ffmpeg = join(dir, 'fake-ffmpeg');
  await writeFile(python, `#!/usr/bin/env node
console.log(JSON.stringify([{text:'spoken words',offset:0,duration:10000}]))
`, { mode: 0o755 });
  await writeFile(ffmpeg, `#!/usr/bin/env node
require('fs').writeFileSync(process.argv.at(-1), 'wav')
`, { mode: 0o755 });
  process.env.AUDIO8_RUNTIME = runtime;
  process.env.AUDIO8_PYTHON = python;
  process.env.FFMPEG_BIN = ffmpeg;
  try {
    const entries = await fetchTranscript('https://fallback.example/video');
    assert.equal(entries.source, 'audio8');
    assert.equal(entries[0].text, 'spoken words');
    const rows = await calls();
    assert.equal(rows.length, 3);
    assert.equal(rows.filter(a => a.includes('-f')).length, 1);
    assert.ok(rows.every(a => !a.includes('--list-subs')));
    const directory = rows[2][rows[2].indexOf('--output') + 1].split('/').slice(0, -1).join('/');
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(directory), /ENOENT/);
  } finally {
    delete process.env.AUDIO8_RUNTIME;
    delete process.env.AUDIO8_PYTHON;
    delete process.env.FFMPEG_BIN;
  }
});

test('real installed Audio8 transcribes downloaded audio through the full fallback', { skip: !process.env.AUDIO8_INTEGRATION_AUDIO, timeout: 120000 }, async () => {
  await reset('fallback-real');
  const entries = await fetchTranscript('https://integration.example/video');
  assert.equal(entries.source, 'audio8');
  assert.match(entries.map(e => e.text).join(' ').toLowerCase(), /quick brown fox/);
  assert.equal((await calls()).length, 3);
});

test('a 429 stops immediately and blocks subsequent requests to the origin', async () => {
  await reset('429');
  await assert.rejects(fetchTranscript('https://limited.example/video', { fallback: false }), /429.*Do not retry/);
  await assert.rejects(fetchTranscript('https://limited.example/other', { fallback: false }), /rate-limited/);
  await assert.rejects(listCaptionTracks('https://limited.example/other'), /rate-limited/);
  assert.equal((await calls()).length, 1);
});

test('caption 429 immediately falls back to audio while caption cooldown is active', async () => {
  await reset('429-caption');
  const { mkdir } = await import('node:fs/promises');
  const runtime = join(dir, 'rate-model');
  await mkdir(join(runtime, 'model_bundle'), { recursive: true });
  await writeFile(join(runtime, 'asr_onnx_runtime.py'), '');
  await writeFile(join(runtime, 'model_bundle', 'metadata.json'), '{}');
  const python = join(dir, 'rate-python');
  const ffmpeg = join(dir, 'rate-ffmpeg');
  await writeFile(python, `#!/usr/bin/env node\nconsole.log(JSON.stringify([{text:'spoken words',offset:0,duration:10000}]))\n`, { mode: 0o755 });
  await writeFile(ffmpeg, `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.argv.at(-1), 'wav')\n`, { mode: 0o755 });
  process.env.AUDIO8_RUNTIME = runtime;
  process.env.AUDIO8_PYTHON = python;
  process.env.FFMPEG_BIN = ffmpeg;
  try {
    const first = await fetchTranscript('https://caption-rate.example/video');
    assert.equal(first.source, 'audio8');
    assert.equal(first[0].text, 'spoken words');
    let rows = await calls();
    assert.equal(rows.length, 2);
    assert.ok(rows[0].includes('--write-subs'));
    assert.ok(rows[1].includes('-f'));
    const second = await fetchTranscript('https://caption-rate.example/other');
    assert.equal(second.source, 'audio8');
    rows = await calls();
    assert.equal(rows.length, 3, 'caption cooldown skips another caption request');
    assert.ok(rows[2].includes('-f'));
    await reset('failure-caption');
    const third = await fetchTranscript('https://caption-error.example/video');
    assert.equal(third.source, 'audio8');
    rows = await calls();
    assert.equal(rows.length, 2);
    assert.ok(rows[0].includes('--write-subs'));
    assert.ok(rows[1].includes('-f'));
  } finally {
    delete process.env.AUDIO8_RUNTIME;
    delete process.env.AUDIO8_PYTHON;
    delete process.env.FFMPEG_BIN;
  }
});

test('audio 429 is reported and independently cooled down', async () => {
  await reset('429');
  await setupFakeAudio('both-limited');
  try {
    await assert.rejects(fetchTranscript('https://both-limited.example/video'), /Caption fetch.*429.*Audio8 fallback failed.*Audio download.*429/);
    assert.equal((await calls()).length, 2);
    await assert.rejects(fetchTranscript('https://both-limited.example/other'), /Caption fetch.*rate-limited.*Audio download rate-limited/);
    assert.equal((await calls()).length, 2, 'neither operation retries during its cooldown');
  } finally { resetFakeAudio(); }
});

test('other downloader errors are surfaced without more attempts', async () => {
  await reset('failure');
  await assert.rejects(fetchTranscript('https://failure.example/video', { fallback: false }), /network failure/);
  assert.equal((await calls()).length, 1);
});

test('same requests share work and successful result is cached', async () => {
  await reset('delay');
  const url = 'https://dedup.example/video';
  const [a, b] = await Promise.all([fetchTranscript(url), fetchTranscript(url)]);
  assert.deepEqual(a, b);
  assert.equal(a[0].text, 'Hello there');
  assert.equal((await calls()).length, 2);
  await fetchTranscript(url);
  assert.equal((await calls()).length, 2);
});

test('a non-English request stays in that language', async () => {
  await reset('missing');
  await assert.rejects(fetchTranscript('https://spanish.example/video', { lang: 'es', fallback: false }), /No es transcript/);
  assert.deepEqual((await calls()).map(a => a[a.indexOf('--sub-langs') + 1]), ['es', 'es']);
});

test('cancelling one subscriber preserves shared work for another', async () => {
  await reset('delay');
  const controller = new AbortController();
  const url = 'https://shared.example/video';
  const first = fetchTranscript(url, { signal: controller.signal });
  const second = fetchTranscript(url);
  controller.abort();
  await assert.rejects(first, /cancelled/);
  assert.equal((await second)[0].text, 'Hello there');
  assert.equal((await calls()).length, 2);
});

test('cancelling the only subscriber aborts its work', async () => {
  await reset('delay');
  const controller = new AbortController();
  const first = fetchTranscript('https://cancel.example/video', { signal: controller.signal });
  await new Promise(r => setTimeout(r, 80));
  controller.abort();
  await assert.rejects(first, /cancelled/);
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await calls()).length, 1);
});

test('the deadline applies across both subtitle attempts', async () => {
  await reset('delay');
  process.env.MOCK_DELAY = '500';
  const start = Date.now();
  await assert.rejects(fetchTranscript('https://deadline.example/video', { fallback: false }), /timed out/);
  assert.ok(Date.now() - start < 1500);
  delete process.env.MOCK_DELAY;
});

test('MCP transcript reports both caption and audio rate limits without retrying', async () => {
  await reset('429');
  await setupFakeAudio('mcp');
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const child = spawn('bun', ['server.mjs'], { cwd: new URL('..', import.meta.url), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  try {
    const reply = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`server exited ${code}`)));
      lines.on('line', line => {
        const msg = JSON.parse(line);
        if (msg.id === 42) resolve(msg);
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'transcript', arguments: { url: 'https://mcp-limited.example/video' } } }) + '\n');
    const msg = await reply;
    assert.equal(msg.result.isError, true);
    assert.match(msg.result.content[0].text, /429.*Do not retry/);
    assert.equal((await calls()).length, 2);
    assert.match(msg.result.content[0].text, /Audio download returned HTTP 429/);
  } finally {
    lines.close();
    child.kill();
    resetFakeAudio();
  }
});

test('Audio8 runner covers long audio and splits truncated chunks', async () => {
  const runtime = join(dir, 'runner-model');
  const { mkdir } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'asr_onnx_runtime.py'), `import io,wave
class OnnxCacheAsrEngine:
 def __init__(self,*args,**kwargs): pass
 def transcribe(self,data,**kwargs):
  w=wave.open(io.BytesIO(data),'rb')
  seconds=w.getnframes()/w.getframerate()
  return {'hit_stop':seconds<=5,'text':f'{seconds:.1f} seconds'}
`);
  const wav = join(dir, 'long.wav');
  execFileSync('python3', ['-c', `import wave,sys
with wave.open(sys.argv[1], 'wb') as w:
 w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b'\\0' * (16000 * 21 * 2))`, wav]);
  const output = execFileSync('python3', ['scripts/audio8-transcribe.py', runtime, wav], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  const entries = JSON.parse(output);
  assert.deepEqual(entries.map(e => e.offset), [0, 5000, 10000, 15000, 20000]);
  assert.deepEqual(entries.map(e => e.duration), [5000, 5000, 5000, 5000, 1000]);
});

test('stop interrupts Audio8 inference and removes temporary audio', async () => {
  await reset('fallback');
  const { mkdir, access } = await import('node:fs/promises');
  const runtime = join(dir, 'cancel-model');
  await mkdir(join(runtime, 'model_bundle'), { recursive: true });
  await writeFile(join(runtime, 'asr_onnx_runtime.py'), '');
  await writeFile(join(runtime, 'model_bundle', 'metadata.json'), '{}');
  const marker = join(dir, 'running-stt');
  const python = join(dir, 'slow-python');
  const ffmpeg = join(dir, 'cancel-ffmpeg');
  await writeFile(python, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(()=>{}, 1000)\n`, { mode: 0o755 });
  await writeFile(ffmpeg, `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.argv.at(-1), 'wav')\n`, { mode: 0o755 });
  process.env.AUDIO8_RUNTIME = runtime;
  process.env.AUDIO8_PYTHON = python;
  process.env.FFMPEG_BIN = ffmpeg;
  try {
    const controller = new AbortController();
    const promise = fetchTranscript('https://stop-audio.example/video', { signal: controller.signal });
    const cancelled = assert.rejects(promise, /cancelled/);
    for (let i = 0; i < 200; i++) {
      try { await access(marker); break; } catch { await new Promise(r => setTimeout(r, 10)); }
    }
    const pid = Number(await readFile(marker, 'utf8'));
    controller.abort();
    await cancelled;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    const rows = await calls();
    const directory = rows[2][rows[2].indexOf('--output') + 1].split('/').slice(0, -1).join('/');
    await assert.rejects(access(directory), /ENOENT/);
  } finally {
    delete process.env.AUDIO8_RUNTIME;
    delete process.env.AUDIO8_PYTHON;
    delete process.env.FFMPEG_BIN;
  }
});
