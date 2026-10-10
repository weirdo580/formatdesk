import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { newId } from './signer.js';

/**
 * 磁盘对象存储：源文件与产物按随机 UUID 存放，原始文件名只存元数据。
 * 生产替换为 OSS/S3 + 生命周期规则；本类接口保持一致。
 */
export class Storage {
  constructor(dataDir) {
    this.root = dataDir;
    this.uploads = path.join(dataDir, 'uploads');
    this.results = path.join(dataDir, 'results');
    this.meta = path.join(dataDir, 'meta');
    for (const d of [this.uploads, this.results, this.meta]) fs.mkdirSync(d, { recursive: true });
  }

  async saveUpload({ name, ext, data }) {
    const fileId = newId();
    const p = path.join(this.uploads, `${fileId}.${ext}`);
    await fsp.writeFile(p, data);
    const meta = { fileId, name, ext, size: data.length, createdAt: Date.now(), path: p };
    await fsp.writeFile(this.#metaPath(fileId), JSON.stringify(meta));
    // 直传路径同样写入秒传索引，后续相同内容可免上传
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    await this.#indexHash(hash, fileId);
    return meta;
  }

  async saveResult(taskId, ext, data) {
    const p = path.join(this.results, `${taskId}.${ext}`);
    await fsp.writeFile(p, data);
    return { path: p, size: data.length };
  }

  async readUpload(fileId) {
    const meta = await this.readMeta(fileId);
    if (!meta || !fs.existsSync(meta.path)) return null;
    return { meta, data: await fsp.readFile(meta.path) };
  }

  async readMeta(fileId) {
    try { return JSON.parse(await fsp.readFile(this.#metaPath(fileId), 'utf8')); }
    catch { return null; }
  }

  #metaPath(fileId) {
    if (!/^[0-9a-f-]{36}$/.test(fileId)) throw Object.assign(new Error('bad id'), { status: 400 });
    return path.join(this.meta, `${fileId}.json`);
  }

  async remove(fileId) {
    const meta = await this.readMeta(fileId);
    if (meta) await fsp.rm(meta.path, { force: true });
    await fsp.rm(this.#metaPath(fileId), { force: true });
  }

  /* ---------- 分片上传会话（生产替换为 OSS Multipart Upload，接口一致） ---------- */
  createSession({ name, ext, size }) {
    const uploadId = newId();
    const partPath = path.join(this.uploads, `.part-${uploadId}`);
    fs.writeFileSync(partPath, '');
    return { uploadId, name, ext, size, received: 0, partPath, createdAt: Date.now() };
  }

  async appendChunk(session, data) {
    await fsp.appendFile(session.partPath, data);
    session.received += data.length;
    return session.received;
  }

  /** 完成分片上传：校验大小与 SHA-256 后转正，写入秒传索引 */
  async finalizeSession(session, { sha256 } = {}) {
    const st = await fsp.stat(session.partPath);
    if (session.size && st.size !== session.size)
      throw Object.assign(new Error(`分片不完整：期望 ${session.size}，实际 ${st.size}`), { status: 400 });
    let hash = sha256;
    if (sha256) {
      const actual = await this.#sha256File(session.partPath);
      if (actual !== sha256)
        throw Object.assign(new Error('SHA-256 校验不一致，请重传'), { status: 400 });
    } else {
      hash = await this.#sha256File(session.partPath);
    }
    const fileId = newId();
    const finalPath = path.join(this.uploads, `${fileId}.${session.ext}`);
    await fsp.rename(session.partPath, finalPath);
    const meta = { fileId, name: session.name, ext: session.ext, size: st.size, createdAt: Date.now(), path: finalPath };
    await fsp.writeFile(this.#metaPath(fileId), JSON.stringify(meta));
    if (hash) await this.#indexHash(hash, fileId);
    return meta;
  }

  async #sha256File(p) {
    const h = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      fs.createReadStream(p).on('data', d => h.update(d)).on('end', resolve).on('error', reject);
    });
    return h.digest('hex');
  }

  /* ---------- 秒传索引：sha256 -> fileId（命中则免上传） ---------- */
  #hashFile() { return path.join(this.meta, 'hashes.json'); }

  async findByHash(sha256) {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
    try {
      const idx = JSON.parse(await fsp.readFile(this.#hashFile(), 'utf8'));
      const fileId = idx[sha256];
      if (!fileId) return null;
      const meta = await this.readMeta(fileId);
      if (!meta || !fs.existsSync(meta.path)) return null;
      return meta;
    } catch { return null; }
  }

  async #indexHash(sha256, fileId) {
    const f = this.#hashFile();
    let idx = {};
    try { idx = JSON.parse(await fsp.readFile(f, 'utf8')); } catch { /* 首次 */ }
    idx[sha256] = fileId;
    await fsp.writeFile(f, JSON.stringify(idx));
  }

  /** 分片会话过期清理（1 小时未完成即废弃） */
  sweepSessions(ttlMs) {
    const now = Date.now();
    let n = 0;
    for (const name of fs.readdirSync(this.uploads)) {
      if (!name.startsWith('.part-')) continue;
      const p = path.join(this.uploads, name);
      try {
        if (now - fs.statSync(p).mtimeMs > ttlMs) { fs.rmSync(p, { force: true }); n++; }
      } catch { /* 竞态忽略 */ }
    }
    return n;
  }

  /** TTL 清理：扫描 uploads/results，删除超过 ttlMs 的文件 */
  async sweep(ttlMs) {
    let removed = 0;
    const now = Date.now();
    for (const dir of [this.uploads, this.results]) {
      let names = [];
      try { names = await fsp.readdir(dir); } catch { continue; }
      for (const n of names) {
        const p = path.join(dir, n);
        try {
          const st = await fsp.stat(p);
          if (now - st.mtimeMs > ttlMs) { await fsp.rm(p, { force: true }); removed++; }
        } catch { /* 竞态忽略 */ }
      }
    }
    return removed;
  }
}

/* ---------- 文件魔数嗅探 ---------- */
const MAGIC = [
  { kind: 'pdf',   test: b => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { kind: 'zip',   test: b => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[3] === 4) }, // docx/xlsx/pptx
  { kind: 'mp3',   test: b => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { kind: 'mp4',   test: b => b.subarray(4, 8).toString('latin1') === 'ftyp' },
  { kind: 'riff',  test: b => b.subarray(0, 4).toString('latin1') === 'RIFF' }, // wav / avi
  { kind: 'webm',  test: b => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { kind: 'asf',   test: b => b.subarray(0, 3).toString('hex') === '3026b7' },  // wmv/flv 容器族
  { kind: 'flv',   test: b => b.subarray(0, 3).toString('latin1') === 'FLV' },
  { kind: 'png',   test: b => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' },
  { kind: 'jpeg',  test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'gzip',  test: b => b[0] === 0x1f && b[1] === 0x8b },
];
const DANGEROUS_MAGIC = [
  { kind: 'exe',   test: b => b[0] === 0x4d && b[1] === 0x5a },                 // MZ
  { kind: 'elf',   test: b => b.subarray(0, 4).toString('hex') === '7f454c46' },// ELF
  { kind: 'macho', test: b => ['feedfacf','cefaedfe','cffaedfe'].includes(b.subarray(0,4).toString('hex')) },
];

/** 返回 { kind, dangerous }；kind=null 表示未识别（白名单扩展名时降级放行并记录） */
export function sniff(data) {
  const head = data.subarray(0, 16);
  for (const d of DANGEROUS_MAGIC) if (d.test(head)) return { kind: d.kind, dangerous: true };
  for (const g of MAGIC) if (g.test(head)) return { kind: g.kind, dangerous: false };
  return { kind: null, dangerous: false };
}

/** 扩展名与魔数一致性（宽松校验：zip 可承载全部 OOXML，riff 覆盖 wav/avi） */
export function extMatchesMagic(ext, kind) {
  if (!kind) return true;
  const map = {
    pdf: ['pdf'], zip: ['docx','xlsx','pptx'], mp3: ['mp3'], mp4: ['mp4','mov','m4a'],
    riff: ['wav','avi'], webm: ['webm','mkv'], flv: ['flv'], asf: ['wmv','flv'],
    png: ['png'], jpeg: ['jpg','jpeg'], gzip: [],
  };
  return (map[kind] || []).includes(ext);
}
