import http from 'node:http';
import { CONFIG } from './src/config.js';
import { Storage } from './src/storage.js';
import { EngineRegistry } from './src/engines.js';
import { Scheduler } from './src/queue.js';
import { createHandler } from './src/gateway.js';

const storage = new Storage(CONFIG.dataDir);
const engines = new EngineRegistry({ config: CONFIG });
const scheduler = new Scheduler({ engines, storage, config: CONFIG });
const handler = createHandler({ storage, scheduler, config: CONFIG });

const server = http.createServer((req, res) => {
  handler(req, res).catch(err => {
    console.error('[server]', err);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"internal"}'); }
    else res.destroy();
  });
});

// TTL 清理循环：过期源文件 / 产物 / 任务元数据
const sweepTimer = setInterval(async () => {
  try {
    const files = await storage.sweep(CONFIG.ttlMs);
    const results = scheduler.sweepExpired(CONFIG.ttlMs);
    const staleSessions = storage.sweepSessions(CONFIG.ttlMs);
    if (files || results || staleSessions) console.log(`[sweep] 清理文件 ${files} 个、产物 ${results} 个、废弃分片会话 ${staleSessions} 个`);
  } catch (e) { console.error('[sweep]', e); }
}, CONFIG.sweepIntervalMs);

server.listen(CONFIG.port, CONFIG.host, () => {
  const av = engines.available;
  console.log(`格式转换台后端已启动: http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`引擎探测: ffmpeg=${av.ffmpeg} libreoffice=${av.libreoffice} pandoc=${av.pandoc}` +
    (av.ffmpeg && av.libreoffice ? '' : '  → 缺失引擎将降级为 mock（演示产物）'));
  console.log(`泳道配置: ${Object.entries(CONFIG.lanes).map(([k, v]) => `${k}(并发${v.concurrency}/超时${v.timeoutMs / 1000}s)`).join(' ')}`);
});

const shutdown = () => { clearInterval(sweepTimer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
