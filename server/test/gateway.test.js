import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage.js';
import { Scheduler } from '../src/queue.js';
import { createHandler } from '../src/gateway.js';

let server, base, storage, scheduler;
const config = {
  dataDir: null, siteDir: null, secret: 'k',
  maxSize: 5 * 1024 * 1024, ttlMs: 3600_000, downloadTtlSec: 300,
  lanes: { doc: { concurrency: 1, timeoutMs: 5000, maxRetries: 1 }, av: { concurrency: 1, timeoutMs: 5000, maxRetries: 1 } },
  rate: { capacity: 100, refillPerSec: 50 },
  rateUpload: { capacity: 100, refillPerSec: 50 },
};

const fastEngine = {
  resolve: () => ({ name: 'fast', run: async (t, ctx) => { ctx.report(100); return Buffer.from('PK\x03\x04mock-docx'); } }),
};

before(async () => {
  config.dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fd-gw-'));
  config.siteDir = config.dataDir;
  storage = new Storage(config.dataDir);
  scheduler = new Scheduler({ engines: fastEngine, storage, config });
  server = http.createServer(createHandler({ storage, scheduler, config }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function upload(name, content) {
  const fd = new FormData();
  fd.append('file', new Blob([content]), name);
  return fetch(base + '/api/upload', { method: 'POST', body: fd });
}

test('健康检查与矩阵下发', async () => {
  const h = await (await fetch(base + '/api/health')).json();
  assert.equal(h.ok, true);
  const m = await (await fetch(base + '/api/matrix')).json();
  assert.deepEqual(m.mp4.targets, ['mp3', 'aac', 'wav']);
});

test('完整链路：上传 -> 建任务 -> 轮询完成 -> 签名下载', async () => {
  const up = await upload('季度报告.pdf', Buffer.from('%PDF-1.4 real-ish content'));
  assert.equal(up.status, 201);
  const { fileId } = await up.json();

  let tk = await (await fetch(base + '/api/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId, dst: 'docx' }),
  })).json();
  for (let i = 0; i < 50 && tk.status !== 'COMPLETED' && tk.status !== 'FAILED'; i++) {
    await new Promise(r => setTimeout(r, 30));
    tk = await (await fetch(base + `/api/tasks/${tk.taskId}`)).json();
  }
  assert.equal(tk.status, 'COMPLETED'); // 异步管线最终完成
  assert.equal(tk.fileName, '季度报告.pdf');
  assert.ok(tk.downloadUrl.includes('/api/download/'));

  const dl = await fetch(base + tk.downloadUrl);
  assert.equal(dl.status, 200);
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  assert.ok(decodeURIComponent(dl.headers.get('content-disposition')).includes('季度报告.docx'));
});

test('下载链接：篡改 token 与未知任务被拒', async () => {
  assert.equal((await fetch(base + '/api/download/t1?token=bad')).status, 403);
  assert.equal((await fetch(base + '/api/download/nope?token=x.y.z')).status, 403);
});

test('安全：可执行文件与伪装扩展名被拒', async () => {
  const exe = await upload('game.exe', Buffer.from('MZ\x90\x00pe'));
  assert.equal(exe.status, 415);
  const zipAsPdf = await upload('fake.pdf', Buffer.from('PK\x03\x04zip'));
  assert.equal(zipAsPdf.status, 415);
  const unknown = await upload('mystery.xyz', Buffer.from('hello'));
  assert.equal(unknown.status, 415);
});

test('非法转换组合：mp4 -> pdf 建任务被拒', async () => {
  const { fileId } = await (await upload('clip.mp4', Buffer.from('\x00\x00\x00\x18ftyp'))).json();
  const r = await fetch(base + '/api/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId, dst: 'pdf' }),
  });
  assert.equal(r.status, 400);
});

test('限流：突发请求触发 429', async () => {
  const tight = { ...config, rate: { capacity: 3, refillPerSec: 0.001 } };
  const s2 = http.createServer(createHandler({ storage, scheduler, config: tight }));
  await new Promise(r => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await fetch(b2 + '/api/health')).status);
  s2.close();
  assert.ok(codes.filter(c => c === 200).length <= 4, `应出现限流: ${codes}`);
  assert.ok(codes.includes(429));
});

test('SSE 进度流：完成前收到至少一次事件', async () => {
  const slow = { resolve: () => ({ name: 'slow', run: async (t, ctx) => { for (let i = 1; i <= 4; i++) { await new Promise(r => setTimeout(r, 40)); ctx.report(i * 25); } return Buffer.from('ok'); } }) };
  const sch = new Scheduler({ engines: slow, storage, config });
  const s3 = http.createServer(createHandler({ storage, scheduler: sch, config }));
  await new Promise(r => s3.listen(0, '127.0.0.1', r));
  const b3 = `http://127.0.0.1:${s3.address().port}`;

  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('%PDF-1.4')]), 'doc.pdf');
  const { fileId } = await (await fetch(b3 + '/api/upload', { method: 'POST', body: fd })).json();
  const task = await (await fetch(b3 + '/api/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId, dst: 'txt' }),
  })).json();

  const ac = new AbortController();
  const res = await fetch(`${b3}/api/tasks/${task.taskId}/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
    buf = buf.slice(buf.lastIndexOf('\n') + 1);
    if (done || events.at(-1)?.status === 'COMPLETED') break;
  }
  ac.abort(); s3.close();
  assert.ok(events.length >= 2, '应收到多次进度事件');
  assert.equal(events.at(-1).status, 'COMPLETED');
  assert.ok(events.at(-1).progress === 100);
});
