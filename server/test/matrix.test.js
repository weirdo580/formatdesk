import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canConvert, laneOf, extOf, matrixView, MATRIX } from '../src/matrix.js';

test('矩阵：视频到音频合法，反向与跨类非法', () => {
  assert.equal(canConvert('mp4', 'mp3'), true);
  assert.equal(canConvert('mkv', 'wav'), true);
  assert.equal(canConvert('mp3', 'mp4'), false);
  assert.equal(canConvert('docx', 'docx'), false);
  assert.equal(canConvert('exe', 'pdf'), false);
});

test('矩阵：Office 与 PDF 组合', () => {
  assert.equal(canConvert('docx', 'pdf'), true);
  assert.equal(canConvert('pdf', 'docx'), true);
  assert.equal(canConvert('pdf', 'mp3'), false);
  assert.equal(canConvert('xlsx', 'csv'), true);
});

test('泳道划分：av 与 doc 互不混用', () => {
  assert.equal(laneOf('mp4'), 'av');
  assert.equal(laneOf('docx'), 'doc');
  assert.equal(laneOf('nope'), null);
});

test('扩展名解析与矩阵视图', () => {
  assert.equal(extOf('My.File.DOCX'), 'docx');
  assert.equal(extOf('noext'), 'noext');
  const v = matrixView();
  assert.deepEqual(v.mp4.targets, ['mp3', 'aac', 'wav']);
  for (const [k, m] of Object.entries(MATRIX))
    for (const t of m.targets) assert.equal(canConvert(k, t), true, `${k}->${t}`);
});
