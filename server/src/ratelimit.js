/** IP 令牌桶限流：防滥用为网盘/图床。生产可换 Redis 实现同一接口。 */
export class TokenBucket {
  constructor(capacity, refillPerSec, now = () => Date.now()) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.buckets = new Map(); // key -> {tokens, ts}
  }
  take(key, cost = 1) {
    const now = this.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, ts: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.ts) / 1000 * this.refillPerSec);
    b.ts = now;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }
  retryAfterSec(key) { return Math.ceil((1 - (this.buckets.get(key)?.tokens ?? 0)) / this.refillPerSec); }
  /** 定期清理冷桶，防内存膨胀 */
  prune(idleMs = 10 * 60 * 1000) {
    const now = this.now();
    for (const [k, b] of this.buckets) if (now - b.ts > idleMs) this.buckets.delete(k);
  }
}
