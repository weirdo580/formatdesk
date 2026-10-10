/**
 * 零依赖原生转换引擎：
 *  - mdToHtml / htmlToMd      —— Markdown ⇄ HTML
 *  - imageToPdf               —— JPG / PNG 嵌入单页 PDF（真实可打开）
 *  - pdfExtractText           —— PDF 文本提取（FlateDecode + ToUnicode/WinAnsi）
 *  - textToDocx/Xlsx/Pptx     —— 纯文本打包为合法 OOXML 文档（复用 zip.js）
 */
import zlib from 'node:zlib';
import { buildZip } from './zip.js';

const B = s => Buffer.from(s, 'utf8');
/* XML 1.0 非法字符（控制符/代理项/\uFFFE\uFFFF）必须剔除，& < > " ' 必须转义，
 * 否则 PDF 提取出的生僻字节会让 OOXML 部件解析失败，被 PowerPoint/WPS"修复"成空白文本框 */
const xmlEsc = s => String(s)
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF\uD800-\uDFFF]/g, '')
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/* ================= Markdown → HTML ================= */
export function mdToHtml(src) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = s => esc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [], list = null, code = null, quote = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>` + list.items.map(i => `<li>${inline(i)}</li>`).join('') + `</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push('<blockquote><p>' + inline(quote.join(' ')) + '</p></blockquote>'); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };
  for (const raw of lines) {
    if (code !== null) {
      if (/^```\s*$/.test(raw)) { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; }
      else code.push(raw);
      continue;
    }
    if (/^```/.test(raw)) { flushAll(); code = []; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(raw.trim())) { flushAll(); out.push('<hr>'); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) { flushAll(); const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(raw);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
    if (ul || ol) {
      flushPara(); flushQuote();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(ul ? ul[1] : ol[1]);
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(raw);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
    if (!raw.trim()) { flushAll(); continue; }
    flushQuote();
    para.push(raw.trim());
  }
  if (code !== null) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
  flushAll();
  return '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>document</title></head><body>\n' + out.join('\n') + '\n</body></html>\n';
}

/* ================= HTML → Markdown ================= */
export function htmlToMd(src) {
  let s = String(src);
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(s);
  if (body) s = body[1];
  s = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (m, t, x) => `\n${'#'.repeat(+t[1])} ${x.trim()}\n`)
    .replace(/<(li)[^>]*>([\s\S]*?)<\/\1>/gi, (m, t, x) => `\n- ${x.trim()}`)
    .replace(/<\/(p|div|ul|ol|blockquote|pre|tr|section|article)>/gi, '\n')
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<img[^>]*src="([^"]*)"[^>]*?alt="([^"]*)"[^>]*>/gi, '![$2]($1)')
    .replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, '![]($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ================= 图片 → PDF ================= */
function jpegInfo(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('非法 JPEG');
  let p = 2;
  while (p < buf.length - 9) {
    if (buf[p] !== 0xff) { p++; continue; }
    const marker = buf[p + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7), comp: buf[p + 9] };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
    p += 2 + buf.readUInt16BE(p + 2);
  }
  throw new Error('未找到 JPEG SOF 段');
}

function pngDecode(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('非法 PNG');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const bd = buf[24], ct = buf[25], interlace = buf[28];
  if (interlace !== 0) throw new Error('不支持隔行扫描 PNG');
  let plte = null;
  const idat = [];
  let p = 8;
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'PLTE') plte = Buffer.from(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  if (!channels) throw new Error('不支持的 PNG 色彩类型 ' + ct);
  const stride = Math.ceil(w * channels * bd / 8);
  const bpp = Math.max(1, Math.floor(channels * bd / 8));
  // 逐行反滤波
  const rows = [];
  let off = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[off++];
    const line = Buffer.from(raw.subarray(off, off + stride)); off += stride;
    const prev = y > 0 ? rows[y - 1] : Buffer.alloc(stride);
    if (ft !== 0) for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (ft === 1) v = line[i] + a;
      else if (ft === 2) v = line[i] + b;
      else if (ft === 3) v = line[i] + ((a + b) >> 1);
      else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else throw new Error('未知 PNG 滤波类型 ' + ft);
      line[i] = v & 0xff;
    }
    rows.push(line);
  }
  // 统一转 8bit RGB（alpha 分离为 SMask）
  const rgb = Buffer.alloc(w * h * 3);
  let alpha = null;
  const sample = (line, idx) => {
    if (bd >= 8) return line[idx * (bd === 16 ? 2 : 1)];
    const per = Math.floor(8 / bd);
    const b = line[Math.floor(idx / per)];
    return ((b >> (8 - bd * (idx % per + 1))) & ((1 << bd) - 1)) * Math.round(255 / ((1 << bd) - 1));
  };
  for (let y = 0; y < h; y++) {
    const line = rows[y];
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 255;
      if (ct === 0) { r = g = b = sample(line, x); }
      else if (ct === 2) { r = sample(line, x * 3); g = sample(line, x * 3 + 1); b = sample(line, x * 3 + 2); }
      else if (ct === 3) { const i = sample(line, x); r = plte[i * 3]; g = plte[i * 3 + 1]; b = plte[i * 3 + 2]; }
      else if (ct === 4) { r = g = b = sample(line, x * 2); a = sample(line, x * 2 + 1); }
      else { r = sample(line, x * 4); g = sample(line, x * 4 + 1); b = sample(line, x * 4 + 2); a = sample(line, x * 4 + 3); }
      const o = (y * w + x) * 3;
      rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
      if (ct === 4 || ct === 6) (alpha || (alpha = Buffer.alloc(w * h)))[y * w + x] = a;
    }
  }
  return { w, h, rgb, alpha };
}

/** 图片 -> 单页 PDF。JPEG 直通(DCTDecode)，PNG 解码归一化后 FlateDecode。 */
export function imageToPdf(buf, ext) {
  let w, h, cs, imgDict, imgData, smaskData = null;
  if (ext === 'jpg' || ext === 'jpeg') {
    const j = jpegInfo(buf);
    if (j.comp !== 1 && j.comp !== 3) throw new Error('不支持的 JPEG 通道数（转交 LibreOffice）');
    w = j.w; h = j.h; cs = j.comp === 1 ? '/DeviceGray' : '/DeviceRGB';
    imgData = buf; imgDict = `/Width ${w} /Height ${h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode`;
  } else if (ext === 'png') {
    const p = pngDecode(buf);
    w = p.w; h = p.h; cs = '/DeviceRGB';
    imgData = zlib.deflateSync(p.rgb);
    imgDict = `/Width ${w} /Height ${h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /FlateDecode`;
    if (p.alpha) smaskData = zlib.deflateSync(p.alpha);
  } else throw new Error('不支持的图片格式 ' + ext);

  // 以 96dpi 折算为磅
  const wp = +(w * 0.75).toFixed(2), hp = +(h * 0.75).toFixed(2);
  const smaskRef = smaskData ? 6 : 0;
  const content = B(`q ${wp} 0 0 ${hp} 0 0 cm /Im0 Do Q\n`);
  const res = smaskData
    ? `<< /XObject << /Im0 4 0 R /Im1 ${smaskRef} 0 R >> >>`
    : `<< /XObject << /Im0 4 0 R >> >>`;
  const objs = new Map();
  objs.set(1, B(`<< /Type /Catalog /Pages 2 0 R >>`));
  objs.set(2, B(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`));
  objs.set(3, B(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wp} ${hp}] /Resources ${res} /Contents 5 0 R >>`));
  objs.set(4, Buffer.concat([B(`<< /Type /XObject /Subtype /Image ${imgDict} /Length ${imgData.length} >>\nstream\n`), imgData, B('\nendstream')]));
  objs.set(5, Buffer.concat([B(`<< /Length ${content.length} >>\nstream\n`), content, B('\nendstream')]));
  if (smaskData) objs.set(6, Buffer.concat([B(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${smaskData.length} >>\nstream\n`), smaskData, B('\nendstream')]));

  let pdf = B('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const maxNum = Math.max(...objs.keys());
  const positions = new Map();
  for (const n of [...objs.keys()].sort((a, b) => a - b)) {
    positions.set(n, pdf.length);
    pdf = Buffer.concat([pdf, B(`${n} 0 obj\n`), objs.get(n), B('\nendobj\n')]);
  }
  const xref = pdf.length;
  let table = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxNum; n++)
    table += (positions.has(n) ? String(positions.get(n)).padStart(10, '0') + ' 00000 n ' : '0000000000 65535 f ') + '\n';
  table += `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([pdf, B(table)]);
}

/* ================= PDF 文本提取 ================= */
function parseObjects(buf) {
  const s = buf.toString('latin1');
  const objs = new Map();
  const re = /(?:^|[\s\]>])(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = +m[1];
    const bodyStart = re.lastIndex;
    const endIdx = s.indexOf('endobj', bodyStart);
    if (endIdx < 0) continue;
    const body = s.slice(bodyStart, endIdx);
    re.lastIndex = endIdx;
    const streamM = /stream\r?\n/.exec(body);
    let dict = body, data = null;
    if (streamM) {
      dict = body.slice(0, streamM.index);
      // 从原始 buffer 精确定位二进制流（dict 文本定位关键字，再跳过分隔符）
      const kw = buf.indexOf(b2('stream'), bodyStart);
      if (kw > 0) {
        let dataFrom = kw + 6;
        if (buf[dataFrom] === 13) dataFrom += 2; else if (buf[dataFrom] === 10) dataFrom += 1;
        const endAt = buf.indexOf(b2('endstream'), dataFrom);
        if (endAt > 0) data = buf.subarray(dataFrom, Math.max(dataFrom, endAt - (buf[endAt - 1] === 10 ? 1 : 0)));
      }
    }
    if (!objs.has(num)) objs.set(num, { dict, data });
  }
  return objs;
}
const b2 = s => Buffer.from(s, 'latin1');

function inflateMaybe(obj) {
  if (!obj?.data) return null;
  if (/\/FlateDecode/.test(obj.dict)) {
    try { return zlib.inflateSync(obj.data); } catch {
      try { return zlib.inflateRawSync(obj.data); } catch { return null; }
    }
  }
  return Buffer.from(obj.data);
}

function parseToUnicode(str) {
  const map = new Map();
  const hex = h => { let s = ''; for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); if (h.length === 2) s = String.fromCharCode(parseInt(h, 16)); return s; };
  for (const blk of str.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(m[1], 16), hex(m[2]));
  for (const blk of str.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (m[3] !== undefined) { const base = parseInt(m[3], 16); for (let c = lo; c <= hi; c++) map.set(c, hex((base + c - lo).toString(16).padStart(m[3].length, '0'))); }
      else { let i = 0; for (const d of m[4].matchAll(/<([0-9a-fA-F]+)>/g)) if (lo + i <= hi) map.set(lo + i++, hex(d[1])); }
    }
  return map;
}

function decodePdfString(tok, font) {
  // tok: 原始 (literal) 或 <hex> 串
  let bytes;
  if (tok[0] === '<') {
    const hx = tok.slice(1, -1).replace(/[^0-9a-fA-F]/g, '');
    bytes = Buffer.from(hx, 'hex');
  } else {
    const body = tok.slice(1, -1);
    const out = [];
    for (let i = 0; i < body.length; i++) {
      let c = body[i];
      if (c === '\\') {
        const n = body[++i];
        if (n === 'n') out.push(10); else if (n === 'r') out.push(13); else if (n === 't') out.push(9);
        else if (n === '(' || n === ')' || n === '\\') out.push(n.charCodeAt(0));
        else if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(body[i + 1])) o += body[++i]; out.push(parseInt(o, 8)); }
        else if (n === '\n' || n === '\r') { /* 续行 */ }
        else out.push(n.charCodeAt(0));
      } else if (c === '\n') out.push(10);
      else out.push(c.charCodeAt(0));
    }
    bytes = Buffer.from(out);
  }
  const { cid, map, ucs2 } = font || {};
  let text = '';
  if (cid) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = bytes.readUInt16BE(i);
      if (map && map.has(code)) text += map.get(code);
      else if (ucs2) text += String.fromCharCode(code);
    }
  } else if (map && map.size) {
    for (const byte of bytes) text += map.has(byte) ? map.get(byte) : (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '');
  } else {
    text = bytes.toString('latin1').replace(/[\x00-\x08\x0b-\x1f]/g, '');
  }
  return text;
}

function loadFonts(pageDict, objs) {
  const fonts = new Map();
  const resRef = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(pageDict);
  let resStr = null;
  if (resRef) resStr = objs.get(+resRef[1])?.dict;
  else { const ri = pageDict.indexOf('/Resources'); resStr = ri >= 0 ? pageDict.slice(ri) : null; }
  if (!resStr) return fonts;
  const fIdx = resStr.search(/\/Font\s+/);
  if (fIdx < 0) return fonts;
  const after = resStr.slice(fIdx + 6).trimStart();
  let fontDictStr = null;
  const refM = /^(\d+)\s+\d+\s+R/.exec(after);
  if (refM) fontDictStr = objs.get(+refM[1])?.dict || '';
  else if (after.startsWith('<<')) {
    // 取平衡的 <<...>> 内容
    let d = 0, k = 0;
    for (; k < after.length - 1; k++) {
      if (after[k] === '<' && after[k + 1] === '<') { d++; k++; }
      else if (after[k] === '>' && after[k + 1] === '>') { if (!--d) { k += 2; break; } k++; }
    }
    fontDictStr = after.slice(0, k);
  }
  if (!fontDictStr) return fonts;
  for (const m of fontDictStr.matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)) {
    const fo = objs.get(+m[2]);
    if (!fo) continue;
    const tuRef = (fo.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/) || [])[1];
    let map = null;
    if (tuRef) { const tu = inflateMaybe(objs.get(+tuRef)); if (tu) map = parseToUnicode(tu.toString('latin1')); }
    const cid = /\/Subtype\s*\/Type0|\/CIDFontType/.test(fo.dict);
    const ucs2 = /\/UCS2/.test(fo.dict);
    fonts.set(m[1], { cid, map, ucs2 });
  }
  return fonts;
}

function tokenizeContent(contentBuf, fonts) {
  const s = contentBuf.toString('latin1');
  let out = '', curFont = null;
  let i = 0;
  const readLiteral = () => { // s[i] === '('，返回含首尾括号的完整串
    const start = i; i++; let depth = 1;
    for (; i < s.length && depth > 0; i++) {
      const c = s[i];
      if (c === '\\') i++;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    return s.slice(start, i);
  };
  const readHex = () => { const start = i; let j = ++i; while (j < s.length && s[j] !== '>') j++; i = j; return s.slice(start, j + 1); };
  while (i < s.length) {
    const c = s[i];
    if (c === '(') { out += decodePdfString(readLiteral(), curFont); continue; }
    if (c === '<' && s[i + 1] !== '<' && s[i + 1] !== '/') { out += decodePdfString(readHex(), curFont); i++; continue; }
    if (c === '[') { // TJ 数组
      const arrEnd = findArrayEnd(s, i);
      const seg = s.slice(i + 1, arrEnd);
      let j = 0;
      while (j < seg.length) {
        if (seg[j] === '(') {
          const st = j; j++; let d = 1;
          for (; j < seg.length && d > 0; j++) { const ch = seg[j]; if (ch === '\\') j++; else if (ch === '(') d++; else if (ch === ')') d--; }
          out += decodePdfString(seg.slice(st, j), curFont);
        } else if (seg[j] === '<') {
          const st = j; while (j < seg.length && seg[j] !== '>') j++; out += decodePdfString(seg.slice(st, j + 1), curFont); j++;
        } else j++;
      }
      i = arrEnd + 1; continue;
    }
    const rest = s.slice(i, i + 60);
    const op = /^\/([\w.]+)\s+[\d.]+\s+Tf\b/.exec(rest);
    if (op) { curFont = fonts.get(op[1]) || curFont; i += op[0].length; continue; }
    const nl = /^(Td|TD|ET|T\*)\b/.exec(rest);
    if (nl) { if (out && !out.endsWith('\n')) out += '\n'; i += nl[0].length; continue; }
    i++;
  }
  return out;
}
function findArrayEnd(s, from) {
  let i = from + 1, depth = 1;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '[') depth++;
    else if (c === ']') { if (!--depth) return i; }
    else if (c === '(') { i++; let d = 1; for (; i < s.length && d > 0; i++) { const ch = s[i]; if (ch === '\\') i++; else if (ch === '(') d++; else if (ch === ')') d--; } }
  }
  return i;
}

/** 提取 PDF 文本；无法提取（扫描件等）时抛错。 */
export function pdfExtractText(buf) {
  const objs = parseObjects(buf);
  let text = '';
  let pages = 0;
  for (const [, o] of objs) {
    if (!/\/Type\s*\/Page[^s]/.test(o.dict)) continue;
    pages++;
    const fonts = loadFonts(o.dict, objs);
    const crefs = [...o.dict.matchAll(/\/Contents\s*(?:(\d+)\s+\d+\s+R|\[([^\]]*)\])/g)];
    const nums = [];
    for (const cr of crefs) {
      if (cr[1]) nums.push(+cr[1]);
      else if (cr[2]) for (const r of cr[2].matchAll(/(\d+)\s+\d+\s+R/g)) nums.push(+r[1]);
    }
    for (const n of nums) {
      const data = inflateMaybe(objs.get(n));
      if (data) text += tokenizeContent(data, fonts) + '\n\n';
    }
  }
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\r/g, '').trim();
  if (!text) throw new Error(pages ? '未能提取到文本（可能是扫描图片或特殊编码 PDF）' : 'PDF 结构无法解析');
  return text;
}

/* ================= 文本 → Office 文档 ================= */
export function textToDocx(text) {
  const paras = String(text).replace(/\r\n?/g, '\n').split('\n')
    .map(l => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(l)}</w:t></w:r></w:p>`).join('');
  return buildZip([
    { name: '[Content_Types].xml', data: B(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`) },
    { name: '_rels/.rels', data: B(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: 'word/document.xml', data: B(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`) },
  ]);
}

const colName = n => { let s = ''; n++; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

export function textToXlsx(text) {
  const rows = String(text).replace(/\r\n?/g, '\n').split('\n');
  const sheetRows = rows.map((line, ri) => {
    const cells = (line.includes('\t') ? line.split('\t') : (ri === 0 && line.includes(',') ? line.split(',') : [line]))
      .map((c, ci) => `<c r="${colName(ci)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c)}</t></is></c>`).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  return buildZip([
    { name: '[Content_Types].xml', data: B(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`) },
    { name: '_rels/.rels', data: B(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: B(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: B(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: B(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`) },
    { name: 'xl/worksheets/sheet1.xml', data: B(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`) },
  ]);
}

export function textToPptx(text, titleHint) {
  const groups = [];
  let cur = [];
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) { if (cur.length) { groups.push(cur); cur = []; } continue; }
    cur.push(line.trim());
    if (cur.length >= 9) { groups.push(cur); cur = []; }
  }
  if (cur.length) groups.push(cur);
  if (!groups.length) groups.push([titleHint || 'Untitled']);
  const slides = groups.map(g => g);
  const aNS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const pNS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const rNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const paraRun = t => `<a:p><a:r><a:rPr lang="zh-CN"/><a:t>${xmlEsc(t)}</a:t></a:r></a:p>`;
  const box = (id, name, x, y, cx, cy, paras) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paras}</p:txBody></p:sp>`;
  const slideXml = g => {
    const [first, ...rest] = g;
    const title = box(2, 'Title', 457200, 274632, 8229600, 1143000, paraRun(first));
    const body = rest.length ? box(3, 'Body', 457200, 1600200, 8229600, 4900000, rest.map(paraRun).join('')) : '';
    return `${X}<p:sld ${aNS} ${pNS} ${rNS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${title}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  };
  const theme = `${X}<a:theme xmlns:a="${'http://schemas.openxmlformats.org/drawingml/2006/main'}" name="FD"><a:themeElements><a:clrScheme name="FD"><a:dk><a:sysClr val="windowText" lastClr="000000"/></a:dk><a:lt><a:sysClr val="window" lastClr="FFFFFF"/></a:lt><a:dk2><a:srgbClr val="444444"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="FD"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="FD"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  const masterXml = `${X}<p:sldMaster ${aNS} ${pNS} ${rNS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
  const layoutXml = `${X}<p:sldLayout ${aNS} ${pNS} ${rNS} type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const rels = r => `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${r}</Relationships>`;
  const R = (id, type, target) => `<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;

  const entries = [
    { name: '[Content_Types].xml', data: B(`${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`) },
    { name: '_rels/.rels', data: B(rels(R(1, 'officeDocument', 'ppt/presentation.xml'))) },
    { name: 'ppt/presentation.xml', data: B(`${X}<p:presentation ${aNS} ${pNS} ${rNS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`) },
    { name: 'ppt/_rels/presentation.xml.rels', data: B(rels(R(1, 'slideMaster', 'slideMasters/slideMaster1.xml') + slides.map((_, i) => R(i + 2, 'slide', `slides/slide${i + 1}.xml`)).join(''))) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: B(masterXml) },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: B(rels(R(1, 'slideLayout', '../slideLayouts/slideLayout1.xml') + R(2, 'theme', '../theme/theme1.xml'))) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: B(layoutXml) },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: B(rels(R(1, 'slideMaster', '../slideMasters/slideMaster1.xml'))) },
    { name: 'ppt/theme/theme1.xml', data: B(theme) },
    ...slides.map((g, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, data: B(slideXml(g)) })),
    ...slides.map((_, i) => ({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: B(rels(R(1, 'slideLayout', '../slideLayouts/slideLayout1.xml'))) })),
  ];
  return buildZip(entries);
}
