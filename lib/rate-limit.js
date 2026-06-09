// lib/rate-limit.js — in-memory rate limiter.
//
// Single-process (PM2 fork mode), so a JS Map is enough. On restart counters
// reset, which is fine: rate limits are a UX/anti-abuse defence, not a
// security primitive. Memory footprint is bounded by sweep().
//
// Usage:
//   const limiter = createLimiter('register-ip', { windowMs: 5*60*1000, max: 3 });
//   const r = limiter.check(ip);                       // { ok: true } | { ok: false, retryAfter: 240 }
//   if (!r.ok) return sendJson(res, 429, { error: 'rate-limited', retry_after: r.retryAfter });
//
// Or convenience helper:
//   const r = checkRate('post-create', userId, { windowMs: 3600_000, max: 5 });

'use strict';

const _buckets = new Map(); // bucketName -> Map(key -> { count, resetAt })

// Periodic sweep so we don't grow unbounded if rare IPs hit once and never come back.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [, inner] of _buckets) {
    for (const [k, v] of inner) {
      if (v.resetAt <= now) inner.delete(k);
    }
  }
}, SWEEP_INTERVAL_MS).unref?.();

function bucket(name) {
  let m = _buckets.get(name);
  if (!m) { m = new Map(); _buckets.set(name, m); }
  return m;
}

// Core check. Returns { ok, retryAfter (seconds), remaining }.
function checkRate(bucketName, key, { windowMs, max }) {
  if (!key) return { ok: true, remaining: max }; // anonymous keys not rate-limited; caller decides
  const now = Date.now();
  const m = bucket(bucketName);
  const entry = m.get(key);
  if (!entry || entry.resetAt <= now) {
    m.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: max - 1 };
  }
  if (entry.count >= max) {
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000), remaining: 0 };
  }
  entry.count++;
  return { ok: true, remaining: max - entry.count };
}

// IP extraction: trust X-Forwarded-For only if it's there (we're behind nginx).
// Take the first value (left-most) — that's the original client.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || 'unknown';
}

module.exports = {
  checkRate,
  clientIp,
  // Curry helper for places that always use the same bucket+limits
  createLimiter(name, opts) {
    return { check: (key) => checkRate(name, key, opts) };
  }
};
