// POST /.netlify/functions/verify-turnstile   {token}
//
// Server-side check of the Cloudflare Turnstile token for the public site's
// entry gate (Settings → Danger Zone → Cloudflare Turnstile Gate). The widget
// passing in the browser proves nothing on its own — only Cloudflare's
// siteverify answer, checked here with TURNSTILE_SECRET_KEY, does.
const { rateLimit, tooManyRequests, clientIp } = require('./lib/rate-limit');

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = null; }
  const token = body && typeof body.token === 'string' ? body.token.trim() : '';
  if (!token || token.length > 2048) return json(400, { ok: false, error: 'Missing or invalid token.' });

  const limit = await rateLimit(event, { bucket: 'verify-turnstile', limit: 20, windowSec: 600 });
  if (!limit.ok) return tooManyRequests(limit);

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.error('[verify-turnstile] TURNSTILE_SECRET_KEY is not set');
    return json(500, { ok: false, error: 'Turnstile is not configured on the server.' });
  }

  const form = new URLSearchParams({ secret, response: token });
  const ip = clientIp(event);
  if (ip && ip !== 'unknown') form.set('remoteip', ip);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form, signal: ac.signal });
    const data = await res.json().catch(() => ({}));
    const ok = data.success === true;
    if (!ok) console.warn('[verify-turnstile] rejected —', data['error-codes']);
    return json(200, { ok, errors: Array.isArray(data['error-codes']) ? data['error-codes'] : [] });
  } catch (err) {
    console.error('[verify-turnstile] siteverify unreachable —', err && err.message);
    return json(502, { ok: false, error: 'Verification service unreachable — try again.' });
  } finally {
    clearTimeout(timer);
  }
};
