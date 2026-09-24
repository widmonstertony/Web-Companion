import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newOpaqueToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function issueSignedValue(payload, secret, ttlSeconds) {
  const body = base64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function readSignedValue(value, secret) {
  if (typeof value !== 'string') return null;
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!secureEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch { /* ignore malformed cookie */ }
  }
  return cookies;
}

export function csrfForSession(session, secret) {
  return createHmac('sha256', secret).update(`csrf:${session.nonce}:${session.login}`).digest('base64url');
}
