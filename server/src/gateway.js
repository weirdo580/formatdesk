import fs from 'node:fs';
import path from 'node:path';
import { parseMultipart } from './multipart.js';
import { sniff, extMatchesMagic } from './storage.js';
import { matrixView, extOf, DANGEROUS } from './matrix.js';
import { sign, verify } from './signer.js';
import { Scheduler } from './queue.js';
import { TokenBucket } from './ratelimit.js';
import { buildZip, dedupeName } from './zip.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * API 网关：路由 / 限流 / 校验 / 静态托管。
 * POST /api/upload            multipart(file)            -> {fileId,...}
 * POST /api/tasks             {fileId,dst,opts,priority} -> {taskId,...}
 * GET  /api/tasks/:id                                    -> 任务状态
 * GET  /api/tasks/:id/events                             -> SSE 进度流
 * POST /api/tasks/:id/retry   |  DELETE /api/tasks/:id
 * GET  /api/download/:id?token=                          -> 签名下载
 * GET  /api/matrix | /api/health
 */
export function createHandler({ storage, scheduler, config }) {
  const buckets = {
    api: new TokenBucket(config.rate.capacity, config.rate.refillPerSec),
    upload: new TokenBucket(config.rateUpload.capacity, config.rateUpload.refillPerSec),
  };
  const sessions = new Map(); // uploadId -> 分片上传会话
  const view = t => {
    const v = Scheduler.publicView(t);
    if (t.status === 'COMPLETED')
      v.downloadUrl = `/api/download/${t.id}?token=${sign(t.id, config.downloadTtlSec, config.secret)}`;
    return v;
  };

  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '?').trim();
    const seg = url.pathname.split('/').filter(Boolean); // ['api','tasks',':id',...]

    try {
      /* ---------- API ---------- */
      if (seg[0] === 'api') {
        if (!buckets.api.take(ip)) return httpError(res, 429, '请求过于频繁，请稍后再试');

        if (req.method === 'GET' && url.pathname === '/api/health')
          return json(res, 200, { ok: true, engines: scheduler.engines.available, lanes: laneStats(scheduler) });
        if (req.method === 'GET' && url.pathname === '/api/matrix')
          return json(res, 200, matrixView());

        if (req.method === 'POST' && url.pathname === '/api/upload') {
          if (!buckets.upload.take(ip)) return httpError(res, 429, '上传过于频繁，请稍后再试');
          return await handleUpload(req, res, storage, config);
        }

        /* ---------- 分片上传（>32MB）：start -> chunk* -> complete，支持秒传 ---------- */
        if (req.method === 'POST' && url.pathname === '/api/upload/start') {
          if (!buckets.upload.take(ip)) return httpError(res, 429, '上传过于频繁，请稍后再试');
          const body = await readJson(req);
          const name = String(body.name || 'unnamed');
          const ext = extOf(name);
          if (DANGEROUS.includes(ext) || !matrixView()[ext]) return httpError(res, 415, `暂不支持 .${ext}`);
          const size = Number(body.size) || 0;
          if (size > config.maxSize) return httpError(res, 413, '文件超过大小限制');
          if (body.sha256) {
            const hit = await storage.findByHash(String(body.sha256));
            if (hit) return json(res, 200, { instant: true, fileId: hit.fileId, name: hit.name, size: hit.size });
          }
          const s = storage.createSession({ name, ext, size });
          sessions.set(s.uploadId, s);
          return json(res, 200, { uploadId: s.uploadId, chunkSize: 8 * 1024 * 1024, received: s.received });
        }
        if (req.method === 'POST' && url.pathname === '/api/upload/chunk') {
          const s = sessions.get(url.searchParams.get('uploadId'));
          if (!s) return httpError(res, 404, '上传会话不存在或已过期');
          const data = await readBody(req, config.maxSize);
          const received = await storage.appendChunk(s, data);
          return json(res, 200, { received, size: s.size });
        }
        if (req.method === 'POST' && url.pathname === '/api/upload/complete') {
          const body = await readJson(req);
          const s = sessions.get(String(body.uploadId));
          if (!s) return httpError(res, 404, '上传会话不存在或已过期');
          const meta = await storage.finalizeSession(s, { sha256: body.sha256 ? String(body.sha256) : null });
          sessions.delete(s.uploadId);
          return json(res, 201, { fileId: meta.fileId, name: meta.name, ext: meta.ext, size: meta.size });
        }

        /* ---------- 批量打包 ZIP ---------- */
        if (req.method === 'POST' && url.pathname === '/api/zip') {
          const body = await readJson(req);
          const ids = Array.isArray(body.taskIds) ? body.taskIds.slice(0, 100) : [];
          const entries = [];
          const used = new Set();
          for (const id of ids) {
            const t = scheduler.get(String(id));
            if (t?.status === 'COMPLETED' && t.resultPath && fs.existsSync(t.resultPath))
              entries.push({ name: dedupeName(used, t.resultName), data: fs.readFileSync(t.resultPath) });
          }
          if (!entries.length) return httpError(res, 404, '没有可下载的已完成任务');
          const zip = buildZip(entries);
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': zip.length,
            'Content-Disposition': `attachment; filename="formatdesk-${Date.now()}.zip"`,
          });
          return res.end(zip);
        }

        if (req.method === 'POST' && url.pathname === '/api/tasks') {
          const body = await readJson(req, config.maxSize);
          const task = await scheduler.add({
            fileId: String(body.fileId || ''), dstExt: String(body.dst || '').toLowerCase(),
            opts: body.opts || {}, priority: Number(body.priority) || 0,
          });
          return json(res, 201, view(task));
        }

        if (seg[1] === 'tasks' && seg[2]) {
          const t = scheduler.get(seg[2]);
          if (!t) return httpError(res, 404, '任务不存在');
          if (req.method === 'GET' && !seg[3]) return json(res, 200, view(t));
          if (req.method === 'GET' && seg[3] === 'events') return sse(req, res, scheduler, t, view);
          if (req.method === 'POST' && seg[3] === 'retry') { scheduler.retry(t.id); return json(res, 200, view(t)); }
          if (req.method === 'DELETE') { await scheduler.remove(t.id); return json(res, 200, { ok: true }); }
        }

        if (req.method === 'GET' && seg[1] === 'download') {
          const t = scheduler.get(seg[2]);
          const v = verify(url.searchParams.get('token'), config.secret);
          if (!t || !v || v.payload !== t.id) return httpError(res, 403, '下载链接无效或已过期');
          if (t.status !== 'COMPLETED' || !t.resultPath || !fs.existsSync(t.resultPath))
            return httpError(res, 410, '文件已删除，请重新转换');
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': t.resultSize,
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(t.resultName)}`,
          });
          return fs.createReadStream(t.resultPath).pipe(res);
        }

        return httpError(res, 404, '接口不存在');
      }

      /* ---------- 静态前端 ---------- */
      if (req.method === 'GET') {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = path.resolve(config.siteDir, rel);
        if (file.startsWith(path.resolve(config.siteDir)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
          return fs.createReadStream(file).pipe(res);
        }
      }
      return httpError(res, 404, 'Not Found');
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[gateway]', err);
      if (!res.headersSent) httpError(res, status, err.message || '服务器内部错误');
      else res.destroy();
    }
  };
}

async function handleUpload(req, res, storage, config) {
  const ct = req.headers['content-type'] || '';
  if (!ct.startsWith('multipart/form-data')) return httpError(res, 400, '请使用 multipart/form-data 上传');
  const body = await readBody(req, config.maxSize);
  const { files } = parseMultipart(body, ct);
  const f = files[0];
  if (!f || !f.data.length) return httpError(res, 400, '未收到文件');

  const ext = extOf(f.filename);
  if (DANGEROUS.includes(ext)) return httpError(res, 415, `不支持的文件类型: .${ext}`);
  const magic = sniff(f.data);
  if (magic.dangerous) return httpError(res, 415, '检测到可执行文件，已拒绝');
  if (magic.kind && !extMatchesMagic(ext, magic.kind))
    return httpError(res, 415, `文件内容与扩展名 .${ext} 不符`);
  if (!matrixView()[ext]) return httpError(res, 415, `暂不支持 .${ext}，请查看转换矩阵`);

  const meta = await storage.saveUpload({ name: f.filename, ext, data: f.data });
  return json(res, 201, { fileId: meta.fileId, name: meta.name, ext: meta.ext, size: meta.size });
}

function sse(req, res, scheduler, task, view) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = t => res.write(`data: ${JSON.stringify(view(t))}\n\n`);
  send(task);
  const onUpdate = t => { if (t.id === task.id) { send(t); if (['COMPLETED','FAILED','CANCELED'].includes(t.status)) done(); } };
  const hb = setInterval(() => res.write(': hb\n\n'), 15000);
  const done = () => { clearInterval(hb); scheduler.off('update', onUpdate); res.end(); };
  scheduler.on('update', onUpdate);
  req.on('close', () => { clearInterval(hb); scheduler.off('update', onUpdate); });
}

function laneStats(scheduler) {
  return Object.fromEntries(Object.entries(scheduler.lanes).map(([k, l]) =>
    [k, { running: l.running, waiting: l.queue.length, concurrency: l.concurrency }]));
}

/* ---------- HTTP 小工具 ---------- */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('文件超过大小限制'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, max) {
  const raw = await readBody(req, 1024 * 1024);
  try { return JSON.parse(raw.toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON 解析失败'), { status: 400 }); }
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function httpError(res, status, message) { json(res, status, { error: message, status }); }
