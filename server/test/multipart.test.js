import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMultipart, buildMultipart, sanitizeFilename } from '../src/multipart.js';

test('multipart：字段与文件往返解析', () => {
  const B = 'Xboundary99';
  const buf = buildMultipart(B, [
    { field: 'meta', data: '{"a":1}' },
    { field: 'file', filename: '报告 v2.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 fake bytes') },
  ]);
  const { fields, files } = parseMultipart(buf, `multipart/form-data; boundary=${B}`);
  assert.equal(fields.meta, '{"a":1}');
  assert.equal(files.length, 1);
  assert.equal(decodeURIComponent(files[0].filename), '报告 v2.pdf');
  assert.equal(files[0].data.subarray(0, 5).toString(), '%PDF-');
});

test('multipart：二进制含边界相似字节不截断', () => {
  const B = 'BOUND';
  const payload = Buffer.from('AB--BOUNDx CD\r\nEF');
  const buf = buildMultipart(B, [{ field: 'f', filename: 'a.bin', data: payload }]);
  const { files } = parseMultipart(buf, `multipart/form-data; boundary=${B}`);
  assert.equal(files[0].data.length, payload.length);
  assert.deepEqual([...files[0].data], [...payload]);
});

test('multipart：引号包裹的 boundary 与非法输入', () => {
  const buf = buildMultipart('q', [{ field: 'f', filename: 'a.txt', data: 'hi' }]);
  assert.equal(parseMultipart(buf, 'multipart/form-data; boundary="q"').files.length, 1);
  assert.throws(() => parseMultipart(buf, 'text/plain'), /boundary/);
});

test('文件名清洗：路径穿越与控制字符', () => {
  assert.equal(sanitizeFilename('..\\..\\windows\\system32\\evil.exe'), 'evil.exe');
  assert.equal(sanitizeFilename('a/b/c.pdf'), 'c.pdf');
  assert.equal(sanitizeFilename('bad\x00name'), 'badname');
  assert.equal(sanitizeFilename(''), 'unnamed');
});
