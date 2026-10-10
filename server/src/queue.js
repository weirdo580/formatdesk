import { EventEmitter } from 'node:events';
import { canConvert, laneOf } from './matrix.js';
import { newId } from './signer.js';

/**
 * 任务调度中心（BullMQ 风格接口，内存实现）：
 *  - 双泳道 doc/av，各自并发上限与超时，互不饿死
 *  - 状态机 CREATED -> QUEUED -> PROCESSING -> COMPLETED | FAILED，可 CANCELED
 *  - 失败自动重试 1 次（超时/引擎崩溃视为可重试）
 *  - EventEmitter 'update' 广播进度，供 SSE 消费
 * 生产替换：把 enqueue/pump 换成 BullMQ Queue + Worker，事件换成 Redis pub/sub，
 * 对外的 add/get/cancel/on('update') 接口保持不变。
 */
export const STATES = ['CREATED','QUEUED','PROCESSING','COMPLETED','FAILED','CANCELED'];
const TRANSITIONS = {
  CREATED:    ['QUEUED','CANCELED'],
  QUEUED:     ['PROCESSING','CANCELED'],
  PROCESSING: ['COMPLETED','FAILED','QUEUED','CANCELED'], // QUEUED = 重试
  COMPLETED:  [], FAILED: ['QUEUED'],                     // FAILED -> QUEUED = 手动重试
  CANCELED:   [],
};

export class Scheduler extends EventEmitter {
  /** @param {{engines:{resolve(src,dst):{name,run}}, storage, config, resolveEngine?}} deps */
  constructor({ engines, storage, config }) {
    super();
    this.engines = engines;
    this.storage = storage;
    this.config = config;
    this.tasks = new Map();
    this.lanes = Object.fromEntries(Object.entries(config.lanes).map(([k, v]) =>
      [k, { ...v, running: 0, queue: [] }]));
  }

  #setState(t, next) {
    if (!TRANSITIONS[t.status]?.includes(next))
      throw new Error(`非法状态迁移 ${t.status} -> ${next}`);
    t.status = next;
    this.emit('update', t);
  }

  async add({ fileId, dstExt, opts = {}, priority = 0 }) {
    const meta = await this.storage.readMeta(fileId);
    if (!meta) throw Object.assign(new Error('文件不存在或已过期'), { status: 404 });
    const srcExt = meta.ext;
    if (!canConvert(srcExt, dstExt))
      throw Object.assign(new Error(`不支持 ${srcExt} -> ${dstExt}`), { status: 400 });

    const task = {
      id: newId(), fileId, fileName: meta.name, srcExt, dstExt, opts, priority,
      status: 'CREATED', progress: 0, stage: '等待开始', engine: null,
      error: null, retries: 0, createdAt: Date.now(),
      resultPath: null, resultSize: 0,
      resultName: meta.name.replace(/\.[^.]+$/, '') + '.' + dstExt,
    };
    this.tasks.set(task.id, task);
    this.#enqueue(task);
    return task;
  }

  #enqueue(task) {
    const lane = this.lanes[laneOf(task.srcExt)];
    task.stage = '排队中';
    this.#setState(task, 'QUEUED');
    lane.queue.push(task);
    // 优先级：数字小者先；同优先级按入队时间
    lane.queue.sort((a, b) => (a.priority - b.priority) || (a.createdAt - b.createdAt));
    this.#pump(lane);
  }

  #pump(lane) {
    while (lane.running < lane.concurrency && lane.queue.length) {
      const task = lane.queue.shift();
      lane.running++;
      this.#run(task, lane)
        .catch(err => this.#fail(task, err))
        .finally(() => { lane.running--; this.#pump(lane); });
    }
  }

  async #run(task, lane) {
    if (task.status === 'CANCELED') return;
    const engine = this.engines.resolve(task.srcExt, task.dstExt);
    task.engine = engine.name;
    if (engine.name === 'mock')
      task.resultName = task.resultName.replace(/\.[^.]+$/, '') + '-DEMO演示文件.' + task.dstExt;
    task.stage = '转换中';
    this.#setState(task, 'PROCESSING');

    const started = Date.now();
    const report = pct => {
      task.progress = Math.max(task.progress, Math.min(100, pct));
      this.emit('update', task);
    };
    const cancelCheck = () => {
      if (task.status === 'CANCELED') throw Object.assign(new Error('已取消'), { canceled: true });
    };
    const { inputPath } = await this.storage.readUpload(task.fileId)
      .then(r => ({ inputPath: r?.meta.path })).catch(() => ({}));
    if (!inputPath) throw Object.assign(new Error('源文件已被删除'), { fatal: true });

    const data = await withTimeout(
      engine.run(task, { report, cancelCheck, storage: this.storage, inputPath }),
      lane.timeoutMs
    );
    cancelCheck();
    if (task.status === 'CANCELED') return;

    const saved = await this.storage.saveResult(task.id, task.dstExt, data);
    task.resultPath = saved.path;
    task.resultSize = saved.size;
    task.progress = 100;
    task.stage = '完成';
    task.finishedAt = Date.now();
    this.#setState(task, 'COMPLETED');
  }

  #fail(task, err) {
    if (task.status === 'CANCELED' || err?.canceled) return;
    task.error = err?.message || String(err);
    const lane = this.lanes[laneOf(task.srcExt)];
    if (!err?.fatal && task.retries < lane.maxRetries) {
      task.retries++;
      task.progress = 0;
      task.stage = `重试中 (${task.retries})`;
      this.#setState(task, 'QUEUED');
      lane.queue.unshift(task);
      this.emit('update', task);
      this.#pump(lane);
      return;
    }
    task.stage = '失败';
    this.#setState(task, 'FAILED');
  }

  get(id) { return this.tasks.get(id) || null; }

  cancel(id) {
    const t = this.tasks.get(id);
    if (!t || ['COMPLETED','FAILED','CANCELED'].includes(t.status)) return t;
    const lane = this.lanes[laneOf(t.srcExt)];
    const qi = lane.queue.indexOf(t);
    if (qi > -1) lane.queue.splice(qi, 1);
    this.#setState(t, 'CANCELED'); // PROCESSING 中的由 cancelCheck 感知退出
    return t;
  }

  /** 失败任务重新入队 */
  retry(id) {
    const t = this.tasks.get(id);
    if (!t || t.status !== 'FAILED') throw Object.assign(new Error('仅失败任务可重试'), { status: 400 });
    t.error = null; t.progress = 0;
    this.#enqueue(t);
    return t;
  }

  async remove(id) {
    const t = this.tasks.get(id);
    if (!t) return false;
    this.cancel(id);
    const rp = t.resultPath;
    if (rp) await import('node:fs/promises').then(m => m.rm(rp, { force: true }));
    await this.storage.remove(t.fileId);
    this.tasks.delete(id);
    return true;
  }

  list() { return [...this.tasks.values()]; }

  /** 过期任务：结果文件与元数据由 TTL 清理（gateway 定时调用） */
  sweepExpired(ttlMs) {
    const now = Date.now();
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.resultPath && now - (t.finishedAt || t.createdAt) > ttlMs) {
        const rp = t.resultPath;        // 先捕获：置空与微任务里的 rm 存在先后竞争
        t.resultPath = null;
        import('node:fs/promises').then(m => m.rm(rp, { force: true }))
          .catch(e => console.error('[sweep] 产物删除失败:', rp, e.message));
        n++;
      }
    }
    return n;
  }

  /** 对外 JSON 视图 */
  static publicView(t) {
    return {
      taskId: t.id, status: t.status, progress: Math.round(t.progress),
      stage: t.stage, engine: t.engine, src: t.srcExt, dst: t.dstExt,
      fileName: t.fileName, error: t.error, retries: t.retries,
      resultName: t.status === 'COMPLETED' ? t.resultName : undefined,
      resultSize: t.status === 'COMPLETED' ? t.resultSize : undefined,
      finishedAt: t.finishedAt, createdAt: t.createdAt,
    };
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`转换超时（>${Math.round(ms/1000)}s）`), { timeout: true })), ms);
    }),
  ]);
}
