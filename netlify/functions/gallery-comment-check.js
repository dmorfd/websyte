// POST /.netlify/functions/gallery-comment-check   (public, same-site only)
//
// gallery.html calls this right after a visitor's comment is accepted, so a
// comment on one of this site's photos reaches the owner's Discord at once
// instead of on the next scheduled check. It carries no data — it only says
// "check now" — and the check itself only ever posts comments the gallery's
// server really has. Refused from other sites, and rate-limited per visitor
// and site-wide so it can't be used to hammer the gallery's server.
const { isCrossSite } = require('./bot-filter');
const { rateLimit } = require('./lib/rate-limit');
const { checkCommentsOnce } = require('./lib/gallery-notify');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  if (isCrossSite(event)) return json(403, { ok: false, error: 'Forbidden' });
  // Matches the gallery's own comment limit (6 per 6 hours per visitor).
  const perIp = await rateLimit(event, { bucket: 'gallery-check', limit: 6, windowSec: 6 * 3600 });
  if (!perIp.ok) return json(200, { ok: true, checked: false });
  const all = await rateLimit(event, { bucket: 'gallery-check-all', key: 'all', limit: 60, windowSec: 3600 });
  if (!all.ok) return json(200, { ok: true, checked: false });
  const r = await checkCommentsOnce();
  return json(200, { ok: true, checked: r === 'done' });
};
