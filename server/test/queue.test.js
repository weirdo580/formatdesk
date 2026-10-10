import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage.js';
import { Scheduler } from '../src/queue.js';

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'fd-q-'));
const cfg = { lanes: { doc: { concurrency: 1, timeoutMs: 2000, maxRetries: 1 }, av: { concurrency: 1, timeoutMs: 2000, maxRetries: 1 } } };
const okEngine = { resolve: () => ({ name: 'test', run: async (t, ctx) => { ctx.report(50); return Buffer.from('result!'); } }) };

async function setup(engine = okEngine) {
  const storage = new Storage(await tmp());
  const s = new Scheduler({ engines: engine, storage, config: cfg });
  const f = await storage.saveUpload({ name: 'demo.mp4', ext: 'mp4', data: Buffer.from('ftyp') });
  return { s, storage, fileId: f.fileId };
}
const waitUntil = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('超时未达成'); await new Promise(r => setTimeout(r, 20)); }
};

test('生命周期：QUEUED -> PROCESSING -> COMPLETED，产物落盘', async () => {
  const { s, fileId } = await setup();
  const events = [];
  s.on('update', t => events.push(t.status));
  const task = await s.add({ fileId, dstExt: 'mp3' });
  await waitUntil(() => task.status === 'COMPLETED');
  assert.equal(task.resultSize, 7);
  assert.equal(task.resultName, 'demo.mp3');
  assert.ok(events.includes('PROCESSING'));
  assert.equal(Scheduler.publicView(task).progress, 100);
});

test('非法组合与未知文件被拒绝', async () => {
  const { s, fileId } = await setup();
  await assert.rejects(s.add({ fileId, dstExt: 'pdf' }), /不支持/);
  await assert.rejects(s.add({ fileId: 'nope', dstExt: 'mp3' }), /不存在/);
});

test('瞬时失败自动重试一次后成功', async () => {
  let calls = 0;
  const engine = { resolve: () => ({ name: 'flaky', run: async () => { if (++calls === 1) throw new Error('引擎崩溃'); return Buffer.from('ok'); } }) };
  const { s, fileId } = await setup(engine);
  const task = await s.add({ fileId, dstExt: 'mp3' });
  await waitUntil(() => ['COMPLETED', 'FAILED'].includes(task.status));
  assert.equal(task.status, 'COMPLETED');
  assert.equal(task.retries, 1);
  assert.equal(calls, 2);
});

test('持续失败：重试耗尽后进入 FAILED', async () => {
  const engine = { resolve: () => ({ name: 'bad', run: async () => { throw new Error('源文件损坏'); } }) };
  const { s, fileId } = await setup(engine);
  const task = await s.add({ fileId, dstExt: 'mp3' });
  await waitUntil(() => ['COMPLETED', 'FAILED'].includes(task.status));
  assert.equal(task.status, 'FAILED');
  assert.equal(task.retries, 1);
  assert.match(task.error, /源文件损坏/);
  // 手动重试再次入队
  s.retry(task.id);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(['QUEUED', 'PROCESSING', 'FAILED'].includes(task.status));
});

test('超时视为瞬时故障：重试后仍超时则 FAILED', async () => {
  const engine = { resolve: () => ({ name: 'slow', run: () => new Promise(() => {}) }) }; // 永不完成
  const { s, fileId } = await setup(engine);
  const task = await s.add({ fileId, dstExt: 'mp3' });
  await waitUntil(() => task.status === 'FAILED', 8000);
  assert.match(task.error, /超时/);
});

test('取消排队任务：不再执行', async () => {
  let started = 0;
  const engine = { resolve: () => ({ name: 'busy', run: async (t, ctx) => { started++; await new Promise(r => setTimeout(r, 150)); return Buffer.from('x'); } }) };
  const storage = new Storage(await tmp());
  const s = new Scheduler({ engines: engine, storage, config: cfg });
  const f1 = await storage.saveUpload({ name: 'a.mp4', ext: 'mp4', data: Buffer.from('ftyp') });
  const f2 = await storage.saveUpload({ name: 'b.mp4', ext: 'mp4', data: Buffer.from('ftyp') });
  const first = await s.add({ fileId: f1.fileId, dstExt: 'mp3' });
  const second = await s.add({ fileId: f2.fileId, dstExt: 'mp3' }); // doc/av 并发=1，第二个排队
  s.cancel(second.id);
  assert.equal(second.status, 'CANCELED');
  await waitUntil(() => first.status === 'COMPLETED');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(started, 1, '被取消的任务不应执行');
});

test('双泳道并行：av 长任务不阻塞 doc 快任务', async () => {
  const running = [];
  const engine = { resolve: (src) => ({ name: src, run: async (t, ctx) => { running.push(src); await new Promise(r => setTimeout(r, 120)); return Buffer.from('x'); } }) };
  const storage = new Storage(await tmp());
  const s = new Scheduler({ engines: engine, storage, config: { lanes: { doc: { concurrency: 1, timeoutMs: 2000, maxRetries: 0 }, av: { concurrency: 1, timeoutMs: 2000, maxRetries: 0 } } } });
  const v = await storage.saveUpload({ name: 'a.mp4', ext: 'mp4', data: Buffer.from('ftyp') });
  const d = await storage.saveUpload({ name: 'b.docx', ext: 'docx', data: Buffer.from('PK\x03\x04') });
  const tv = await s.add({ fileId: v.fileId, dstExt: 'mp3' });
  const td = await s.add({ fileId: d.fileId, dstExt: 'pdf' });
  await waitUntil(() => td.status === 'COMPLETED');
  assert.ok(running.includes('mp4') && running.includes('docx'), '两条泳道应同时在跑');
  await waitUntil(() => tv.status === 'COMPLETED');
});

test('sweepExpired：过期产物被删除，且不因路径置空而崩溃（回归：rm(null) 未处理拒绝）', async () => {
  const { s, fileId } = await setup();
  const task = await s.add({ fileId, dstExt: 'mp3' });
  await waitUntil(() => task.status === 'COMPLETED');
  const resultPath = task.resultPath;
  await fsp.access(resultPath); // 产物确实存在
  task.finishedAt = Date.now() - 10_000; // 伪造为已过期
  const rejections = [];
  const collector = e => rejections.push(e);
  process.on('unhandledRejection', collector);
  const n = s.sweepExpired(1_000);
  await new Promise(r => setTimeout(r, 150)); // 给异步 rm 时间执行
  process.off('unhandledRejection', collector);
  assert.equal(n, 1);
  assert.deepEqual(rejections.map(String), [], 'sweep 不应产生未处理的 Promise 拒绝');
  await assert.rejects(fsp.access(resultPath), '过期产物应被删除');
});
