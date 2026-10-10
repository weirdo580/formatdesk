import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify } from '../src/signer.js';
import { TokenBucket } from '../src/ratelimit.js';

const S = 'topsecret';

test('签名链接：有效 / 篡改 / 过期', () => {
  const t = sign('task-1', 600, S);
  assert.equal(verify(t, S).payload, 'task-1');

  const [p, e, m] = t.split('.');
  assert.equal(verify(`${p}.${Number(e) + 1000}.${m}`, S), null, '改期必须失败');
  assert.equal(verify(`other.${e}.${m}`, S), null, '换 payload 必须失败');
  assert.equal(verify(t, 'wrong-secret'), null, '换密钥必须失败');
  assert.equal(verify(sign('x', -5, S), S), null, '过期必须失败');
  assert.equal(verify('garbage', S), null);
});

test('令牌桶：容量、耗尽与按时间回填', () => {
  let now = 0;
  const b = new TokenBucket(3, 1, () => now);
  assert.equal(b.take('ip1'), true);
  assert.equal(b.take('ip1'), true);
  assert.equal(b.take('ip1'), true);
  assert.equal(b.take('ip1'), false, '第 4 次应被限流');
  assert.equal(b.take('ip2'), true, '不同 IP 独立计数');
  now = 1500; // 1.5 秒后回填 1.5 个令牌
  assert.equal(b.take('ip1'), true);
  assert.equal(b.take('ip1'), false);
});

test('令牌桶：闲置桶回收', () => {
  let now = 0;
  const b = new TokenBucket(5, 1, () => now);
  b.take('a'); b.take('b');
  now = 11 * 60 * 1000;
  b.prune();
  assert.equal(b.buckets.has('a'), false);
});
