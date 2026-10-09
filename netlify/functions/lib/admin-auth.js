// Admin authentication for every protected endpoint.
//
// - The admin panel sends the key in the X-Admin-Key header. It is compared
//   with the ADMIN_KEY env var in constant time: both sides are SHA-256 hashed
//   first so timingSafeEqual always sees equal-length buffers and the key's
//   length isn't leaked either.
// - Brute-force lockout, per client (IPv4 address / IPv6 /64), in Netlify
//   Blobs so it survives cold starts and spans concurrent lambdas:
//     * every guess from an unverified client must first RESERVE an attempt
//       with a conditional (ETag) write — parallel guesses can't all read
//       "0 failures" and all get compared;
//     * MAX_FAILS attempts inside FAIL_WINDOW lock the client out for LOCKOUT
//       (HTTP 429), even if the next guess is right;
//     * after a correct key the client is trusted for TRUST_MS, so the
//       owner's normal admin traffic costs one read per request, no writes;
//     * a site-wide budget (GLOBAL_MAX_FAILS per hour) stops guessing spread
//       across many addresses; already-trusted sessions are unaffected.
// - Fails CLOSED: no ADMIN_KEY configured, or no way to record the attempt,
//   never means "let it through".
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { clientKey, hashKey, writeIfUnchanged } = require('./rate-limit');

const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const TRUST_MS = 12 * 60 * 60 * 1000;
const GLOBAL_MAX_FAILS = 100;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_KEY = 'lock/all';

const guardStore = () => getStore({
  name: 'site-guard',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN,
  consistency: 'strong',
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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

const locked = (until, now) => ({
  ok: false,
  statusCode: 429,
  error: 'Too many failed attempts — try again later.',
  retryAfter: Math.max(1, Math.ceil((until - now) / 1000)),
});

async function globalFailures(store, now) {
  const g = await store.get(GLOBAL_KEY, { type: 'json' });
  return isObj(g) && g.window === Math.floor(now / GLOBAL_WINDOW_MS) ? Number(g.count) || 0 : 0;
}

async function addGlobalFailure(store, now) {
  const window = Math.floor(now / GLOBAL_WINDOW_MS);
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await store.getWithMetadata(GLOBAL_KEY, { type: 'json' });
    const count = cur && isObj(cur.data) && cur.data.window === window ? Number(cur.data.count) || 0 : 0;
    const res = await writeIfUnchanged(store, GLOBAL_KEY, cur, { window, count: count + 1 });
    if (res.modified) return;
  }
}

/**
 * Verify the request's admin key.
 * @returns {Promise<{ok: true} | {ok: false, statusCode: number, error: string, retryAfter?: number}>}
 */
async function checkAdmin(event) {
  const expected = String(process.env.ADMIN_KEY || '').trim();
  if (!expected) return { ok: false, statusCode: 500, error: 'ADMIN_KEY is not configured on the server.' };

  const given = providedKey(event);
  if (!given) return { ok: false, statusCode: 401, error: 'Unauthorized' };

  const lockKey = `lock/${hashKey(clientKey(event))}`;
  let store;
  try {
    store = guardStore();
  } catch (err) {
    console.error('[admin-auth] lockout store unavailable —', err && err.message);
    return { ok: false, statusCode: 503, error: 'Auth store unavailable — check NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN.' };
  }

  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const now = Date.now();
      const cur = await store.getWithMetadata(lockKey, { type: 'json' });
      const rec = cur && isObj(cur.data) ? cur.data : {};
      if (rec.lockedUntil > now) return locked(rec.lockedUntil, now);

      // Recently verified client: compare directly, no writes.
      if (rec.trustedUntil > now && safeEqual(given, expected)) return { ok: true };

      // Unverified (or a trusted client that just sent a wrong key): the
      // site-wide budget, then reserve this attempt BEFORE comparing.
      if (await globalFailures(store, now) >= GLOBAL_MAX_FAILS) return locked(now + GLOBAL_WINDOW_MS / 4, now);
      const fresh = !rec.first || now - rec.first > FAIL_WINDOW_MS;
      const fails = (fresh ? 0 : Number(rec.fails) || 0) + 1;
      const next = { first: fresh ? now : rec.first, fails, lockedUntil: fails >= MAX_FAILS ? now + LOCKOUT_MS : 0 };
      const res = await writeIfUnchanged(store, lockKey, cur, next);
      if (!res.modified) continue;   // a concurrent attempt got there first — re-read

      if (safeEqual(given, expected)) {
        try {
          await store.setJSON(lockKey, { trustedUntil: now + TRUST_MS });
        } catch (err) {
          console.error('[admin-auth] could not record trust —', err && err.message);
        }
        return { ok: true };
      }
      try { await addGlobalFailure(store, now); } catch (err) { console.error('[admin-auth] global counter —', err && err.message); }
      return next.lockedUntil ? locked(next.lockedUntil, now) : { ok: false, statusCode: 401, error: 'Unauthorized' };
    }
    // Could not reserve an attempt (sustained parallel guessing) — refuse.
    return locked(Date.now() + 60000, Date.now());
  } catch (err) {
    console.error('[admin-auth] lockout check failed —', err && err.message);
    return { ok: false, statusCode: 503, error: 'Auth check failed — try again shortly.' };
  }
}

// Netlify function response for a failed checkAdmin() result.
function authFailure(result) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (result.retryAfter) headers['Retry-After'] = String(result.retryAfter);
  return { statusCode: result.statusCode, headers, body: JSON.stringify({ ok: false, error: result.error }) };
}

module.exports = { checkAdmin, hasAdminKey, authFailure };
