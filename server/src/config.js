import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // server/src
const serverDir = path.resolve(here, '..');

const conc = (name, def) => {
  const n = Number(process.env[`FD_${name}_CONC`]);
  return Number.isInteger(n) && n > 0 ? n : def;
};

export const CONFIG = {
  port: Number(process.env.FD_PORT || 8787),
  host: process.env.FD_HOST || '127.0.0.1',
  siteDir: path.resolve(serverDir, '..'),          // 前端 index.html 所在目录
  dataDir: process.env.FD_DATA || path.join(serverDir, 'data'),
  secret: process.env.FD_SECRET || 'dev-secret-change-me',

  maxSize: 100 * 1024 * 1024,   // 游客单文件上限 100MB
  ttlMs: 60 * 60 * 1000,        // 文件 60 分钟自动删除
  downloadTtlSec: 10 * 60,      // 下载签名链接有效期

  // 双泳道：文档快任务 / 音视频慢任务，互不饿死；并发可用环境变量压到 1（小内存机器）
  lanes: {
    doc: { concurrency: conc('DOC', 2), timeoutMs: 120_000, maxRetries: 1 },
    av:  { concurrency: conc('AV', 1), timeoutMs: 600_000, maxRetries: 1 },
  },

  rate: { capacity: 60, refillPerSec: 1 },          // 普通 API：IP 令牌桶
  rateUpload: { capacity: 10, refillPerSec: 1/6 },  // 上传：每 IP 约 10 次/分钟

  sweepIntervalMs: 60_000,
};
