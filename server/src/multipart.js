/**
 * 零依赖 multipart/form-data 解析器（buffer 模式，适合 ≤100MB 上传）。
 * 分隔符按 RFC 2046 严格匹配 "\r\n--boundary" 且其后必须紧跟 CRLF 或 "--"（结束），
 * 防止文件内容中的相似字节造成截断。
 * 生产大文件应替换为流式分片上传（tus），接口层不变。
 */
export function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw Object.assign(new Error('缺少 multipart boundary'), { status: 400 });
  const boundary = '--' + (m[1] || m[2]).trim();
  const delim = Buffer.from('\r\n' + boundary);
  const fields = {};
  const files = [];

  if (!buffer.subarray(0, boundary.length).equals(Buffer.from(boundary)))
    throw Object.assign(new Error('multipart 格式非法'), { status: 400 });

  // 首个边界：跳过 "--boundary" 及其后 CRLF
  let pos = boundary.length;
  for (;;) {
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break; // "--" 结束标记
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2; // 跳过 CRLF

    // 找下一个真正的分隔符（其后必须是 CRLF 或 "--"）
    let end = -1, search = pos;
    for (;;) {
      const i = buffer.indexOf(delim, search);
      if (i === -1) break;
      const after = i + delim.length;
      if (buffer[after] === 0x2d && buffer[after + 1] === 0x2d) { end = i; break; } // 结束
      if (buffer[after] === 0x0d && buffer[after + 1] === 0x0a) { end = i; break; }  // 下一 part
      search = i + 1; // 数据中的伪分隔符，继续
    }
    if (end === -1) break;

    const part = buffer.subarray(pos, end);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) throw Object.assign(new Error('part 头不完整'), { status: 400 });
    const headers = part.subarray(0, headerEnd).toString('utf8'); // 浏览器 FormData 以 UTF-8 原样写文件名
    const body = part.subarray(headerEnd + 4); // 尾部 CRLF 已属于分隔符

    const nameM = /name="([^"]*)"/i.exec(headers);
    const fileM = /filename="([^"]*)"/i.exec(headers);
    const field = nameM ? nameM[1] : '';
    if (fileM !== null && fileM !== undefined) {
      files.push({
        field,
        filename: sanitizeFilename(safeDecode(fileM[1])),
        data: Buffer.from(body),
      });
    } else if (field) {
      fields[field] = body.toString('utf8');
    }
    pos = end + delim.length;
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break; // 结束
  }
  return { fields, files };
}

function safeDecode(s) {
  if (s.includes('%')) { try { return decodeURIComponent(s); } catch { return s; } }
  return s;
}

/** 取 basename 后清洗控制字符；原始名仅用于展示与产物命名 */
export function sanitizeFilename(name) {
  const base = String(name).split(/[\\/]/).pop() || '';
  const clean = base.replace(/[\x00-\x1f<>:"|?*]/g, '').trim();
  return (clean || 'unnamed').slice(0, 180);
}

/** 测试与演示用的 multipart 构造器 */
export function buildMultipart(boundary, parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.field}"` +
      (p.filename !== undefined ? `; filename="${encodeURIComponent(p.filename)}"` : '') +
      `\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ''}\r\n`));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data ?? '')));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}
