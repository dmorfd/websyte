// Admin authentication for every protected endpoint.
//
// - The admin panel sends the key in the X-Admin-Key header. It is compared
//   with the ADMIN_KEY env var in constant time: both sides are SHA-256 hashed
//   first so timingSafeEqual always sees equal-length buffers and the key's
//   length isn't leaked either.
// - Failed attempts are counted per client IP in Netlify Blobs. MAX_FAILS
//   misses inside FAIL_WINDOW lock that IP out for LOCKOUT (HTTP 429), even if
//   the next guess is right. Living in Blobs means the lockout survives cold
//   starts and is shared across concurrent lambdas.
// - A missing ADMIN_KEY fails CLOSED (500) — no key configured never means
//   "no key needed".
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { clientIp, hashKey } = require('./rate-limit');

const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

const guardStore = () => getStore({
  name: 'site-guard',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN,
  consistency: 'strong',
});

// Case-insensitive header lookup (Netlify lowercases, local tools may not).
function header(event, name) {
  const h = (event && event.headers) || {};
  const want = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return h[k];
  return undefined;
}

function providedKey(event) {
  const v = header(event, 'x-admin-key');
  return typeof v === 'string' ? v.trim() : '';
}

// True when the request carries a (non-empty) admin key header at all — used
// by get-content to decide cacheability before verifying it.
function hasAdminKey(event) {
  return providedKey(event).length > 0;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Verify the request's admin key.
 * @returns {Promise<{ok: true} | {ok: false, statusCode: number, error: string, retryAfter?: number}>}
 */
async function checkAdmin(event) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) return { ok: false, statusCode: 500, error: 'ADMIN_KEY is not configured on the server.' };

  const given = providedKey(event);
  if (!given) return { ok: false, statusCode: 401, error: 'Unauthorized' };

  const lockKey = `lock/${hashKey(clientIp(event))}`;
  const now = Date.now();
  let store = null;
  let rec = null;
  try {
    store = guardStore();
    rec = await store.get(lockKey, { type: 'json' });
  } catch (err) {
    // Brute-force tracking unavailable — the constant-time check still applies.
    console.error('[admin-auth] lockout store unavailable —', err && err.message);
  }

  if (rec && rec.lockedUntil && rec.lockedUntil > now) {
    return {
      ok: false,
      statusCode: 429,
      error: 'Too many failed attempts — try again later.',
      retryAfter: Math.ceil((rec.lockedUntil - now) / 1000),
    };
  }

  if (safeEqual(given, expected)) {
    if (rec && store) {
      try { await store.delete(lockKey); } catch (err) { console.error('[admin-auth] clear lockout failed —', err && err.message); }
    }
    return { ok: true };
  }

  if (store) {
    const fresh = !rec || !rec.first || now - rec.first > FAIL_WINDOW_MS;
    const fails = fresh ? 1 : (Number(rec.fails) || 0) + 1;
    const next = { first: fresh ? now : rec.first, fails, lockedUntil: fails >= MAX_FAILS ? now + LOCKOUT_MS : 0 };
    try { await store.setJSON(lockKey, next); } catch (err) { console.error('[admin-auth] record failure failed —', err && err.message); }
    if (next.lockedUntil) {
      return { ok: false, statusCode: 429, error: 'Too many failed attempts — try again later.', retryAfter: Math.ceil(LOCKOUT_MS / 1000) };
    }
  }
  return { ok: false, statusCode: 401, error: 'Unauthorized' };
}

// Netlify function response for a failed checkAdmin() result.
function authFailure(result) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (result.retryAfter) headers['Retry-After'] = String(result.retryAfter);
  return { statusCode: result.statusCode, headers, body: JSON.stringify({ ok: false, error: result.error }) };
}

module.exports = { checkAdmin, hasAdminKey, authFailure };
