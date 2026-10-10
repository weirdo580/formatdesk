import crypto from 'node:crypto';

/** HMAC 签名链接：payload.exp.mac（base64url），防枚举、限时下载 */
export function sign(payload, ttlSec, secret) {
  const exp = Date.now() + ttlSec * 1000;
  const body = `${payload}.${exp}`;
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [payload, expStr, mac] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  const want = crypto.createHmac('sha256', secret).update(`${payload}.${expStr}`).digest();
  let got;
  try { got = Buffer.from(mac, 'base64url'); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  return { payload, exp };
}

export const newId = () => crypto.randomUUID();
