// Blob-backed fixed-window rate limiter for the public endpoints.
//
// Each (bucket, client) pair owns ONE blob holding {window, count}. The window
// is the start of the current fixed time slice; when it rolls over the count
// starts again from zero, so the number of stored keys never grows past the
// number of distinct clients. Because the state lives in Netlify Blobs (not in
// memory) it survives cold starts and is shared by concurrent lambdas.
// Increments use conditional writes (ETag match) so two simultaneous requests
// can't both read "4 of 5" and both get through.
//
// Store errors FAIL OPEN: a Blobs hiccup must never take the public site down,
// so the request is allowed and the error is logged.
const crypto = require('crypto');
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

// Conditional write for read-modify-write updates: create-only when the blob
// didn't exist, ETag-matched when the read returned an ETag, and a plain write
// when the backend gave no ETag (nothing to condition on).
function writeIfUnchanged(store, key, cur, value) {
  if (!cur) return store.setJSON(key, value, { onlyIfNew: true });
  if (cur.etag) return store.setJSON(key, value, { onlyIfMatch: cur.etag });
  return store.setJSON(key, value);
}

// IPs are never stored in clear — only a truncated SHA-256 of them.
function hashKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

/**
 * Count one request against a limit.
 * @param {object} event   the Netlify function event (used for the client IP)
 * @param {object} opts    { bucket, limit, windowSec, key? } — key overrides the IP
 * @returns {Promise<{ok: boolean, remaining: number|null, retryAfter?: number}>}
 */
async function rateLimit(event, { bucket, limit, windowSec, key }) {
  const id = hashKey(key || clientIp(event));
  const blobKey = `rl/${bucket}/${id}`;
  const windowMs = windowSec * 1000;
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));

  try {
    const store = guardStore();
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
    // Sustained contention on one key: let it through rather than stall.
    return { ok: true, remaining: 0 };
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

module.exports = { rateLimit, tooManyRequests, clientIp, hashKey, writeIfUnchanged };
