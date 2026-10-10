import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { mdToHtml, htmlToMd, imageToPdf, pdfExtractText, textToDocx, textToXlsx, textToPptx } from '../src/native.js';
import { crc32 } from '../src/zip.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/* ---- 测试辅助：最小 PNG 构造器（store 滤波行） ---- */
function makePng(w, h, ct, bd, pixels, plte) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = bd; ihdr[9] = ct;
  const stride = pixels.length / h;
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.from([0]), pixels.subarray(y * stride, (y + 1) * stride));
  const parts = [Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr)];
  if (plte) parts.push(chunk('PLTE', plte));
  parts.push(chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/* ---- 测试辅助：store-ZIP 解包 ---- */
function unzipStore(buf) {
  const out = new Map();
  let p = 0;
  while (p + 30 < buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(p + 26), extraLen = buf.readUInt16LE(p + 28);
    const compSize = buf.readUInt32LE(p + 18);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const ds = p + 30 + nameLen + extraLen;
    out.set(name, buf.subarray(ds, ds + compSize));
    p = ds + compSize;
  }
  return out;
}

/* ---- 测试辅助：拼 PDF（提取器不依赖 xref，可省略） ---- */
function makePdf(objs) {
  let s = '%PDF-1.4\n';
  objs.forEach((o, i) => { s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  return Buffer.from(s, 'latin1');
}
function streamObjBody(dict, dataBuf) {
  return { toString: () => `<< ${dict} /Length ${dataBuf.length} >>\nstream\n${dataBuf.toString('latin1')}\nendstream` };
}

test('mdToHtml：标题/加粗/列表/代码/转义', () => {
  const html = mdToHtml('# 标题\n\n段落 **粗** 与 <危险> 字符\n\n- 甲\n- 乙\n\n```\ncode <x>\n```\n\n[链接](http://a.b)\n');
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>粗<\/strong>/);
  assert.match(html, /&lt;危险&gt;/);
  assert.match(html, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/);
  assert.match(html, /<pre><code>code &lt;x&gt;/);
  assert.match(html, /<a href="http:\/\/a\.b">链接<\/a>/);
});

test('htmlToMd：标题/链接/加粗/去标签', () => {
  const md = htmlToMd('<html><head><style>x{}</style></head><body><h2>Hello</h2><p>一段 <strong>粗</strong> <a href="u.v">l</a></p><ul><li>一</li></ul></body></html>');
  assert.match(md, /## Hello/);
  assert.match(md, /\*\*粗\*\*/);
  assert.match(md, /\[l\]\(u\.v\)/);
  assert.match(md, /- 一/);
  assert.ok(!md.includes('<'));
});

test('imageToPdf：JPEG 直通 DCTDecode', () => {
  const buf = fs.readFileSync(path.join(fixtures, 'sample.jpg'));
  const pdf = imageToPdf(buf, 'jpg');
  assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.ok(pdf.toString('latin1').includes('/DCTDecode'));
  assert.ok(pdf.toString('latin1').includes('/MediaBox [0 0 48 36]')); // 64x48 @96dpi
  assert.ok(pdf.toString('latin1').trimEnd().endsWith('%%EOF'));
});

test('imageToPdf：真实 PNG（含 alpha）生成 SMask', () => {
  const buf = fs.readFileSync(path.join(fixtures, 'sample.png'));
  const pdf = imageToPdf(buf, 'png');
  const s = pdf.toString('latin1');
  assert.ok(s.includes('/FlateDecode'));
  assert.ok(s.includes('/Subtype /Image'));
});

test('imageToPdf：灰度/调色板/RGBA 构造 PNG 均可嵌入', () => {
  const gray = makePng(2, 2, 0, 8, Buffer.from([0, 128, 255, 64]));
  const rgb = makePng(2, 2, 2, 8, Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 1, 2, 3]));
  const rgba = makePng(1, 1, 6, 8, Buffer.from([9, 8, 7, 200]));
  const pal = makePng(2, 1, 3, 8, Buffer.from([0, 1]), Buffer.from([255, 0, 0, 0, 255, 0]));
  for (const [name, buf] of [['gray', gray], ['rgb', rgb], ['rgba', rgba], ['pal', pal]]) {
    const pdf = imageToPdf(buf, 'png').toString('latin1');
    assert.ok(pdf.includes('%PDF-1.4'), name);
    assert.ok(pdf.includes('/DeviceRGB'), name);
  }
  const withAlpha = imageToPdf(rgba, 'png').toString('latin1');
  assert.ok(withAlpha.includes('/Im1'), 'RGBA 应带 SMask');
});

test('pdfExtractText：WinAnsi 明文字符串', () => {
  const content = 'BT /F1 12 Tf 72 700 Td (Hello World) Tj 0 -20 Td (A\\(B\\)C) Tj ET';
  const pdf = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    streamObjBody('/Length 0', Buffer.alloc(0)) /* placeholder, replaced below */,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ].map((o, i) => i === 3 ? `<< /Length ${content.length} >>\nstream\n${content}\nendstream` : o));
  const text = pdfExtractText(pdf);
  assert.match(text, /Hello World/);
  assert.match(text, /A\(B\)C/);
});

test('pdfExtractText：FlateDecode 内容流 + TJ 数组', () => {
  const content = 'BT /F1 12 Tf [(Second) -30 ( para)] TJ ET';
  const comp = zlib.deflateSync(Buffer.from(content));
  const pdf = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Filter /FlateDecode /Length ${comp.length} >>\nstream\n${comp.toString('latin1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
  assert.match(pdfExtractText(pdf), /Second para/);
});

test('pdfExtractText：Type0 CID 字体经 ToUnicode 还原中文', () => {
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\nbeginbfchar\n<0041> <4E2D>\n<0042> <6587>\nendbfchar\nendcmap`;
  const content = 'BT /C1 12 Tf <00410042> Tj ET';
  const pdf = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /C1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>`,
    `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,
  ]);
  assert.equal(pdfExtractText(pdf), '中文');
});

test('pdfExtractText：无文本 PDF 明确报错', () => {
  const pdf = makePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\nendstream',
  ]);
  assert.throws(() => pdfExtractText(pdf), /未能提取|无法解析/);
});

test('textToDocx：包结构与转义', () => {
  const zip = textToDocx('第一行 & <b>标记</b>\n第二行');
  assert.equal(zip.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  const files = unzipStore(zip);
  assert.ok(files.has('[Content_Types].xml'));
  assert.ok(files.has('_rels/.rels'));
  const doc = files.get('word/document.xml').toString('utf8');
  assert.ok(doc.includes('第一行 &amp; &lt;b&gt;标记&lt;/b&gt;'));
  assert.equal(doc.match(/<w:p>/g).length, 2);
});

test('textToXlsx：制表符拆列', () => {
  const files = unzipStore(textToXlsx('name\tage\n张三\t12'));
  const sheet = files.get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.ok(sheet.includes('r="A1"'));
  assert.ok(sheet.includes('r="B1"'));
  assert.ok(sheet.includes('张三'));
  assert.ok(files.has('xl/styles.xml'));
});

test('textToPptx：空行分片多页', () => {
  const files = unzipStore(textToPptx('页一标题\n内容A\n\n页二标题\n内容B'));
  assert.ok(files.has('ppt/presentation.xml'));
  assert.ok(files.has('ppt/slides/slide1.xml'));
  assert.ok(files.has('ppt/slides/slide2.xml'));
  assert.ok(!files.has('ppt/slides/slide3.xml'));
  const pres = files.get('ppt/presentation.xml').toString('utf8');
  assert.equal(pres.match(/<p:sldId /g).length, 2);
  assert.ok(files.get('ppt/theme/theme1.xml').toString('utf8').includes('a:theme'));
});

test('textToPptx：XML 特殊字符与控制字符不再毁掉文本（PDF→PPT 文字丢失回归）', () => {
  const tricky = 'R&D 年报 <2024>\n"引用" 与 \'单引号\'\n坏字节\x07\x0B\x1F测试';
  const slide1 = unzipStore(textToPptx(tricky)).get('ppt/slides/slide1.xml').toString('utf8');
  assert.ok(slide1.includes('R&amp;D'), '& 必须转义');
  assert.ok(slide1.includes('&lt;2024&gt;'), '< > 必须转义');
  assert.ok(slide1.includes('&quot;引用&quot;'), '引号必须转义');
  assert.ok(!slide1.includes('\x07') && !slide1.includes('\x0B') && !slide1.includes('\x1F'), 'XML 非法控制字符必须剔除');
  assert.ok(slide1.includes('坏字节') && slide1.includes('测试'), '剔除后正文保留');
  // 结构自检：任意 <a:t> 内不得残留裸 & < >
  for (const m of slide1.matchAll(/<a:t>(.*?)<\/a:t>/g))
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(m[1]) && !/[<>]/.test(m[1]), '存在未转义字符: ' + m[1]);
});
