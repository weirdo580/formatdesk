import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Storage, sniff, extMatchesMagic } from '../src/storage.js';

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'fd-test-'));

test('存储：保存/读取/元数据/删除', async () => {
  const dir = await tmp();
  const st = new Storage(dir);
  const meta = await st.saveUpload({ name: '秘密文件.pdf', ext: 'pdf', data: Buffer.from('%PDF-1.4 x') });
  assert.equal(meta.name, '秘密文件.pdf');
  assert.match(meta.fileId, /^[0-9a-f-]{36}$/, '落盘路径必须是 UUID，不暴露原始名');

  const got = await st.readUpload(meta.fileId);
  assert.equal(got.meta.name, '秘密文件.pdf');

  await st.remove(meta.fileId);
  assert.equal(await st.readUpload(meta.fileId), null);
});

test('存储：TTL 清扫只删过期文件', async () => {
  const dir = await tmp();
  const st = new Storage(dir);
  const a = await st.saveUpload({ name: 'old.mp4', ext: 'mp4', data: Buffer.from('ftyp') });
  const b = await st.saveUpload({ name: 'new.mp4', ext: 'mp4', data: Buffer.from('ftyp') });
  await fsp.utimes(a.path, new Date(0), new Date(0)); // 伪造为很旧
  const removed = await st.sweep(60_000);
  assert.equal(removed, 1);
  assert.equal(await st.readUpload(a.fileId), null, '过期文件不可再读取');
  assert.ok(await st.readUpload(b.fileId), '未过期文件保留');
});

test('魔数嗅探：识别类型与危险文件', () => {
  assert.equal(sniff(Buffer.from('%PDF-1.7')).kind, 'pdf');
  assert.equal(sniff(Buffer.from('PK\x03\x04rest')).kind, 'zip');
  assert.equal(sniff(Buffer.from('MZ\x90\x00')).dangerous, true);
  assert.equal(sniff(Buffer.from('\x7fELF\x02')).dangerous, true);
  assert.equal(sniff(Buffer.from('hello world')).kind, null);
});

test('魔数与扩展名一致性', () => {
  assert.equal(extMatchesMagic('pdf', 'pdf'), true);
  assert.equal(extMatchesMagic('docx', 'zip'), true);
  assert.equal(extMatchesMagic('pdf', 'zip'), false, 'zip 伪装成 pdf 必须拒绝');
  assert.equal(extMatchesMagic('mp4', null), true, '未识别时降级放行');
});
