// POST /.netlify/functions/gallery-proxy   (admin only)
//
// Forwards the admin panel's Gallery calls to the shared gallery's
// gallery-admin endpoint on arandomperson.dev (GALLERY_API), with this site's
// gallery key (GALLERY_KEY) attached. The key is the reason this exists: it
// must never reach a browser, so it is read from the environment here and
// nowhere else, and only ever sent to GALLERY_API.
//
// - Gated by the same ADMIN_KEY check as every other admin endpoint. Without
//   it, anyone who can reach this URL could edit the gallery.
// - No CORS headers, by design — do not add any. It is the panel's own
//   same-origin endpoint and it holds a credential.
// - The body is passed through as-is ({action, ...} — see docs in SETUP.md);
//   the gallery's server decides what this key may do.
const { checkAdmin, authFailure } = require('./lib/admin-auth');

const MAX_BODY = 1024 * 1024;
const TIMEOUT_MS = 10000;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

// GALLERY_API as a URL, or null. The key travels with every call, so plain
// http is refused except for a local test server.
function galleryApi() {
  const raw = String(process.env.GALLERY_API || '').trim().replace(/\/+$/, '');
  let u;
  try { u = new URL(raw); } catch { return null; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
  return raw;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const auth = await checkAdmin(event);
  if (!auth.ok) return authFailure(auth);

  const api = galleryApi();
  const key = String(process.env.GALLERY_KEY || '').trim();
  if (!api || !key) {
    return json(500, { ok: false, error: 'Gallery not configured — set GALLERY_API (https://…) and GALLERY_KEY on Netlify, then redeploy.', reason: 'not-configured' });
  }

  let body = event.body || '{}';
  if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
  if (Buffer.byteLength(body) > MAX_BODY) return json(413, { ok: false, error: 'Request too large.' });
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.action !== 'string') {
    return json(400, { ok: false, error: 'Body must be a JSON object with an "action".' });
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    // Fresh headers: nothing from the browser's request (its ADMIN_KEY
    // included) is passed on — only the gallery key.
    const res = await fetch(api + '/gallery-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
      body,
      signal: ac.signal,
      redirect: 'error',
    });
    const text = await res.text();
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    const retry = res.headers.get('retry-after');
    if (retry) headers['Retry-After'] = retry;
    let out = text || '{}';
    try { JSON.parse(out); } catch { out = JSON.stringify({ ok: false, error: `The gallery answered HTTP ${res.status} without JSON.` }); }
    return { statusCode: res.status, headers, body: out };
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    console.error('[gallery-proxy] request failed —', err && err.message);
    return json(timedOut ? 504 : 502, { ok: false, error: timedOut ? 'The gallery took too long to answer.' : 'Could not reach the gallery.' });
  } finally {
    clearTimeout(timer);
  }
};
