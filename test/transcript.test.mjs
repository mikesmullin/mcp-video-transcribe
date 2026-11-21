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
    if (mode === 'fallback-real') fs.copyFileSync(process.env.WHISPER_INTEGRATION_AUDIO, out.replace('%(ext)s', 'wav'));
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
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'model.bin'), '');
  const python = join(dir, `${name}-python`);
  await writeFile(python, `#!/usr/bin/env node\nconsole.log(JSON.stringify({entries:[{text:'spoken words',offset:0,duration:10000}],device:'cpu',transcriptionSeconds:1,language:'en'}))\n`, { mode: 0o755 });
  process.env.WHISPER_MODEL = runtime;
  process.env.WHISPER_PYTHON = python;
}
function resetFakeAudio() {
  delete process.env.WHISPER_MODEL;
  delete process.env.WHISPER_PYTHON;
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

test('missing captions download audio once and invoke the standalone Whisper Turbo fallback', async () => {
  await reset('fallback');
  const { mkdir } = await import('node:fs/promises');
  const runtime = join(dir, 'model');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'model.bin'), '');
  const python = join(dir, 'fake-python');
  await writeFile(python, `#!/usr/bin/env node
console.log(JSON.stringify({entries:[{text:'spoken words',offset:0,duration:10000}],device:'cpu',transcriptionSeconds:1,language:'en'}))
`, { mode: 0o755 });
  process.env.WHISPER_MODEL = runtime;
  process.env.WHISPER_PYTHON = python;
  try {
    const entries = await fetchTranscript('https://fallback.example/video');
    assert.equal(entries.source, 'whisper');
    assert.equal(entries.device, 'cpu');
    assert.equal(entries[0].text, 'spoken words');
    const rows = await calls();
    assert.equal(rows.length, 3);
    assert.equal(rows.filter(a => a.includes('-f')).length, 1);
    assert.ok(rows.every(a => !a.includes('--list-subs')));
    const directory = rows[2][rows[2].indexOf('--output') + 1].split('/').slice(0, -1).join('/');
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(directory), /ENOENT/);
  } finally {
    delete process.env.WHISPER_MODEL;
    delete process.env.WHISPER_PYTHON;
  }
});

test('real installed Whisper Turbo transcribes downloaded audio through the full fallback', { skip: !process.env.WHISPER_INTEGRATION_AUDIO, timeout: 120000 }, async () => {
  await reset('fallback-real');
  const entries = await fetchTranscript('https://integration.example/video');
  assert.equal(entries.source, 'whisper');
  assert.match(entries.map(e => e.text).join(' ').toLowerCase(), /quick brown fox/);
  assert.equal((await calls()).length, 3);
});

test('audio source skips captions and does not reuse caption-first cache', async () => {
  await reset('fallback');
  await setupFakeAudio('audio-source');
  try {
    const first = await fetchTranscript('https://force-audio.example/video');
    assert.equal(first.source, 'whisper');
    const second = await fetchTranscript('https://force-audio.example/video', { source: 'audio' });
    assert.equal(second.source, 'whisper');
    const rows = await calls();
    assert.equal(rows.length, 4);
    assert.ok(rows[3].includes('-f'));
    assert.ok(!rows[3].includes('--write-subs'));
  } finally { resetFakeAudio(); }
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
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'model.bin'), '');
  const python = join(dir, 'rate-python');
  await writeFile(python, `#!/usr/bin/env node\nconsole.log(JSON.stringify({entries:[{text:'spoken words',offset:0,duration:10000}],device:'cpu',transcriptionSeconds:1,language:'en'}))\n`, { mode: 0o755 });
  process.env.WHISPER_MODEL = runtime;
  process.env.WHISPER_PYTHON = python;
  try {
    const first = await fetchTranscript('https://caption-rate.example/video');
    assert.equal(first.source, 'whisper');
    assert.equal(first[0].text, 'spoken words');
    let rows = await calls();
    assert.equal(rows.length, 2);
    assert.ok(rows[0].includes('--write-subs'));
    assert.ok(rows[1].includes('-f'));
    const second = await fetchTranscript('https://caption-rate.example/other');
    assert.equal(second.source, 'whisper');
    rows = await calls();
    assert.equal(rows.length, 3, 'caption cooldown skips another caption request');
    assert.ok(rows[2].includes('-f'));
    await reset('failure-caption');
    const third = await fetchTranscript('https://caption-error.example/video');
    assert.equal(third.source, 'whisper');
    rows = await calls();
    assert.equal(rows.length, 2);
    assert.ok(rows[0].includes('--write-subs'));
    assert.ok(rows[1].includes('-f'));
  } finally {
    delete process.env.WHISPER_MODEL;
    delete process.env.WHISPER_PYTHON;
  }
});

test('audio 429 is reported and independently cooled down', async () => {
  await reset('429');
  await setupFakeAudio('both-limited');
  try {
    await assert.rejects(fetchTranscript('https://both-limited.example/video'), /Caption fetch.*429.*Whisper Turbo fallback failed.*Audio download.*429/);
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

test('stop interrupts Whisper Turbo inference and removes temporary audio', async () => {
  await reset('fallback');
  const { mkdir, access } = await import('node:fs/promises');
  const runtime = join(dir, 'cancel-model');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'model.bin'), '');
  const marker = join(dir, 'running-stt');
  const python = join(dir, 'slow-python');
  await writeFile(python, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(()=>{}, 1000)\n`, { mode: 0o755 });
  process.env.WHISPER_MODEL = runtime;
  process.env.WHISPER_PYTHON = python;
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
    delete process.env.WHISPER_MODEL;
    delete process.env.WHISPER_PYTHON;
  }
});

test('MCP audio mode reports the transcription time and device', async () => {
  await reset('fallback');
  await setupFakeAudio('mcp-audio');
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const child = spawn('bun', ['server.mjs'], { cwd: new URL('..', import.meta.url), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  try {
    const reply = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`server exited ${code}`)));
      lines.on('line', line => { const msg = JSON.parse(line); if (msg.id === 51) resolve(msg); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'transcript', arguments: { url: 'https://mcp-audio.example/video', source: 'audio' } } }) + '\n');
    const msg = await reply;
    assert.match(msg.result.content[0].text, /Whisper Turbo segments/);
    assert.match(msg.result.content[0].text, /Transcription time: 1\.0s \(cpu/);
    assert.equal((await calls()).length, 1);
  } finally {
    lines.close(); child.kill(); resetFakeAudio();
  }
});
