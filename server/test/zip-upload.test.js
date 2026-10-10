import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildZip, dedupeName, crc32 } from '../src/zip.js';
import { Storage } from '../src/storage.js';
import { Scheduler } from '../src/queue.js';
import { createHandler } from '../src/gateway.js';

/* ---------------- ZIP 结构与 CRC ---------------- */
function parseZip(buf) {
  const files = [];
  let i = 0;
  while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(i + 26), extraLen = buf.readUInt16LE(i + 28);
    const compSize = buf.readUInt32LE(i + 18);
    files.push({
      name: buf.subarray(i + 30, i + 30 + nameLen).toString('utf8'),
      data: buf.subarray(i + 30 + nameLen + extraLen, i + 30 + nameLen + extraLen + compSize),
      crc: buf.readUInt32LE(i + 14),
    });
    i += 30 + nameLen + extraLen + compSize;
  }
  return { files, eocdAt: buf.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) };
}

test('ZIP：两文件往返，UTF-8 中文名与 CRC 一致', () => {
  const a = Buffer.from('%PDF-1.4 报告内容'), b = Buffer.from('ID3 音频');
  const zip = buildZip([{ name: '报告.pdf', data: a }, { name: 'song.mp3', data: b }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const { files, eocdAt } = parseZip(zip);
  assert.ok(eocdAt > 0, '必须含 EOCD');
  assert.equal(files.length, 2);
  assert.equal(files[0].name, '报告.pdf');
  assert.deepEqual(files[0].data, a);
  assert.equal(files[0].crc, crc32(a));
  assert.equal(files[1].crc, crc32(b));
});

test('ZIP：空文件与重名去重', () => {
  const zip = buildZip([{ name: 'x.txt', data: Buffer.alloc(0) }]);
  assert.equal(parseZip(zip).files[0].data.length, 0);
  const used = new Set();
  assert.equal(dedupeName(used, 'a.pdf'), 'a.pdf');
  assert.equal(dedupeName(used, 'a.pdf'), 'a(2).pdf');
  assert.equal(dedupeName(used, 'a.pdf'), 'a(3).pdf');
});

/* ---------------- 分片上传 + 秒传 + ZIP 端点（HTTP 级） ---------------- */
let server, base, storage, scheduler;
const config = {
  dataDir: null, siteDir: null, secret: 'k',
  maxSize: 5 * 1024 * 1024, ttlMs: 3600_000, downloadTtlSec: 300,
  lanes: { doc: { concurrency: 1, timeoutMs: 5000, maxRetries: 0 }, av: { concurrency: 1, timeoutMs: 5000, maxRetries: 0 } },
  rate: { capacity: 500, refillPerSec: 200 },
  rateUpload: { capacity: 500, refillPerSec: 200 },
};
const CONTENT = Buffer.concat([Buffer.from('%PDF-1.4'), crypto.randomBytes(200_000)]);
const SHA = crypto.createHash('sha256').update(CONTENT).digest('hex');
const fastEngine = { resolve: () => ({ name: 'fast', run: async (t, ctx) => { ctx.report(100); return Buffer.from('result-bytes'); } }) };

before(async () => {
  config.dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fd-chunk-'));
  config.siteDir = config.dataDir;
  storage = new Storage(config.dataDir);
  scheduler = new Scheduler({ engines: fastEngine, storage, config });
  server = http.createServer(createHandler({ storage, scheduler, config }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const postJson = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function chunkUpload(name, data, sha256) {
  const start = await (await postJson('/api/upload/start', { name, size: data.length, sha256 })).json();
  if (start.instant) return { instant: true, ...start };
  const CS = 64 * 1024;
  for (let off = 0; off < data.length; off += CS) {
    const r = await fetch(`${base}/api/upload/chunk?uploadId=${start.uploadId}`, { method: 'POST', body: data.subarray(off, off + CS) });
    assert.equal(r.status, 200);
  }
  const fin = await (await postJson('/api/upload/complete', { uploadId: start.uploadId, sha256 })).json();
  return { instant: false, ...fin };
}

test('分片上传：start->chunk->complete 成功，元数据一致', async () => {
  const r = await chunkUpload('大文件.pdf', CONTENT, SHA);
  assert.equal(r.instant, false);
  assert.equal(r.size, CONTENT.length);
  const meta = await storage.readMeta(r.fileId);
  assert.equal(meta.name, '大文件.pdf');
  assert.deepEqual(await (await storage.readUpload(r.fileId)).data, CONTENT);
});

test('秒传：相同 SHA-256 直接命中，不再传分片', async () => {
  const r = await chunkUpload('副本.pdf', CONTENT, SHA);
  assert.equal(r.instant, true);
  assert.ok(r.fileId, '秒传返回已有 fileId');
});

test('秒传跨路径：直传过的文件，分片 start 时按哈希命中', async () => {
  const fd = new FormData();
  const data = Buffer.from('%PDF-1.4 direct-then-instant');
  fd.append('file', new Blob([data]), '直传.pdf');
  const up = await (await fetch(base + '/api/upload', { method: 'POST', body: fd })).json();
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  const start = await (await postJson('/api/upload/start', { name: '又传.pdf', size: data.length, sha256: hash })).json();
  assert.equal(start.instant, true, '直传应写入秒传索引');
  assert.equal(start.fileId, up.fileId);
});

test('分片校验：SHA 不一致被拒；未知会话 404', async () => {
  const start = await (await postJson('/api/upload/start', { name: 'bad.pdf', size: CONTENT.length })).json();
  await fetch(`${base}/api/upload/chunk?uploadId=${start.uploadId}`, { method: 'POST', body: CONTENT.subarray(0, 1000) });
  const bad = await postJson('/api/upload/complete', { uploadId: start.uploadId, sha256: 'a'.repeat(64) });
  assert.equal(bad.status, 400);
  const ghost = await fetch(`${base}/api/upload/chunk?uploadId=nope`, { method: 'POST', body: 'x' });
  assert.equal(ghost.status, 404);
});

test('分片上传：不支持的扩展名被拒', async () => {
  const r = await postJson('/api/upload/start', { name: 'tool.exe', size: 10 });
  assert.equal(r.status, 415);
});

test('ZIP 端点：批量下载已完成任务', async () => {
  const up = await chunkUpload('clip1.pdf', Buffer.from('%PDF-1.4 one'), crypto.createHash('sha256').update(Buffer.from('%PDF-1.4 one')).digest('hex'));
  const t1 = await (await postJson('/api/tasks', { fileId: up.fileId, dst: 'txt' })).json();
  for (let i = 0; i < 50 && !['COMPLETED', 'FAILED'].includes(t1.status); i++) {
    await new Promise(r => setTimeout(r, 30));
    Object.assign(t1, await (await fetch(base + `/api/tasks/${t1.taskId}`)).json());
  }
  assert.equal(t1.status, 'COMPLETED');
  const res = await postJson('/api/zip', { taskIds: [t1.taskId, 'unknown-id'] });
  assert.equal(res.status, 200);
  const zip = Buffer.from(await res.arrayBuffer());
  const { files } = parseZip(zip);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'clip1.txt');
  assert.deepEqual(files[0].data, Buffer.from('result-bytes'));
});

test('ZIP 端点：无有效任务返回 404', async () => {
  assert.equal((await postJson('/api/zip', { taskIds: ['x'] })).status, 404);
});
