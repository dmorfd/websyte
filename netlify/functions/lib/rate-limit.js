// Blob-backed fixed-window rate limiter for the public endpoints.
//
// Each (bucket, client) pair owns ONE blob holding {window, count}. The window
// is the start of the current fixed time slice; when it rolls over the count
// starts again from zero, so the number of stored keys never grows past the
// number of distinct clients. Because the state lives in Netlify Blobs (not in
// memory) it survives cold starts and is shared by concurrent lambdas.
// Increments use conditional writes (ETag match) so two simultaneous requests
// can't both read "4 of 5" and both get through; a request that keeps losing
// that race is refused rather than waved through.
//
// Clients are keyed by IPv4 address, or by IPv6 /64 — one subscriber line or
// server usually owns a whole /64, so per-address limits would be trivial to
// dodge by rotating addresses.
//
// Store ERRORS fail open: a Blobs outage must never take the public site down,
// so the request is allowed and the error is logged.
const crypto = require('crypto');
const net = require('net');
const { getStore } = require('@netlify/blobs');

const guardStore = () => getStore({
  name: 'site-guard',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN,
  consistency: 'strong',
});

// Best-effort client IP. Netlify sets x-nf-client-connection-ip; the others
// are fallbacks for local dev / proxies.
function clientIp(event) {
  const h = (event && event.headers) || {};
  const fwd = String(h['x-forwarded-for'] || '').split(',')[0];
  const raw = h['x-nf-client-connection-ip'] || h['client-ip'] || fwd || '';
  return String(raw).trim() || 'unknown';
}

// Full 8-hextet form of an IPv6 address (handles "::" and an IPv4 tail).
function expandIPv6(ip) {
  let addr = ip.split('%')[0];
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const p = v4.slice(1).map(Number);
    addr = addr.slice(0, -v4[0].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : (tail ? tail.split(':') : []);
  const fill = tail === undefined ? 0 : Math.max(0, 8 - h.length - t.length);
  return [...h, ...new Array(fill).fill('0'), ...t].map((x) => x.padStart(4, '0').toLowerCase()).join(':');
}

// The identity limits are keyed on: IPv4 address, or IPv6 /64 prefix.
function clientKey(event) {
  const ip = clientIp(event);
  if (net.isIPv6(ip)) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (mapped) return mapped[1];
    return expandIPv6(ip).split(':').slice(0, 4).join(':') + '::/64';
  }
  return ip;
}

// Conditional write for read-modify-write updates: create-only when the blob
// didn't exist, ETag-matched when the read returned an ETag, and a plain write
// when the backend gave no ETag (nothing to condition on).
function writeIfUnchanged(store, key, cur, value) {
  if (!cur) return store.setJSON(key, value, { onlyIfNew: true });
  if (cur.etag) return store.setJSON(key, value, { onlyIfMatch: cur.etag });
  return store.setJSON(key, value);
}

// Client identities are never stored in clear — only a truncated SHA-256.
function hashKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

/**
 * Count one request against a limit.
 * @param {object} event   the Netlify function event (used for the client identity)
 * @param {object} opts    { bucket, limit, windowSec, key? } — key overrides the client identity
 * @returns {Promise<{ok: boolean, remaining: number|null, retryAfter?: number}>}
 */
async function rateLimit(event, { bucket, limit, windowSec, key }) {
  const id = hashKey(key || clientKey(event));
  const blobKey = `rl/${bucket}/${id}`;
  const windowMs = windowSec * 1000;
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));

  let store;
  try {
    store = guardStore();
  } catch (err) {
    console.error(`[rate-limit] ${bucket}: store unavailable, failing open —`, err && err.message);
    return { ok: true, remaining: null };
  }
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await store.getWithMetadata(blobKey, { type: 'json' });
      const data = cur && cur.data && typeof cur.data === 'object' ? cur.data : null;
      const count = data && data.window === windowStart ? (Number(data.count) || 0) : 0;
      if (count >= limit) return { ok: false, remaining: 0, retryAfter };
      const next = { window: windowStart, count: count + 1 };
      const res = await writeIfUnchanged(store, blobKey, cur, next);
      if (res.modified) return { ok: true, remaining: limit - next.count };
      // Lost a race with a concurrent request — re-read and try again.
    }
    // Still losing after 4 rounds = a burst on one key. Refuse: a burst is
    // exactly what the limit exists to stop.
    return { ok: false, remaining: 0, retryAfter: 1 };
  } catch (err) {
    console.error(`[rate-limit] ${bucket}: store error, failing open —`, err && err.message);
    return { ok: true, remaining: null };
  }
}

// Standard 429 response for a failed rateLimit() result.
function tooManyRequests(result) {
  return {
    statusCode: 429,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': String((result && result.retryAfter) || 60),
    },
    body: JSON.stringify({ ok: false, error: 'Too many requests — try again later.' }),
  };
}

module.exports = { rateLimit, tooManyRequests, clientIp, clientKey, hashKey, writeIfUnchanged };
