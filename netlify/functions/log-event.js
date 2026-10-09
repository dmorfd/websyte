// POST /.netlify/functions/log-event
//
// Receives the public site's analytics events:
//   {type:'view'}                    — once per counted visit (after the enter click)
//   {type:'click', target:'Discord'} — a social-link click
//   {type:'session', seconds:93}     — time on page, sent on leave (sendBeacon)
//
// Each event is stored as ONE empty blob whose KEY carries the data:
//   ev/<YYYY-MM-DD>/<ms>~<type>~<country>~<device>~<browser>~<os>~<extra>~<rand>
// so get-analytics can aggregate with list() alone (no per-event reads), and
// concurrent writes never contend. No IP or identifier is stored.
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { isBot, userAgent, parseUserAgent } = require('./bot-filter');
const { rateLimit, tooManyRequests } = require('./lib/rate-limit');
const { normalizeCountry } = require('./lib/countries');

const EVENT_PREFIX = 'ev/';
const TYPES = ['view', 'click', 'session'];

const analyticsStore = () => getStore({
  name: 'site-analytics',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN,
  consistency: 'strong',
});

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

// Visitor country from Netlify's geo headers ('XX' when unknown).
function countryOf(event) {
  const h = (event && event.headers) || {};
  if (h['x-nf-geo']) {
    try {
      const geo = JSON.parse(Buffer.from(h['x-nf-geo'], 'base64').toString('utf8'));
      if (geo && geo.country && geo.country.code) return normalizeCountry(geo.country.code);
    } catch { /* fall through */ }
  }
  return normalizeCountry(h['x-country']);
}

const b64url = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
const unb64url = (s) => { try { return Buffer.from(String(s), 'base64url').toString('utf8'); } catch { return ''; } };

function eventKey(ts, type, country, ua, extra) {
  const day = new Date(ts).toISOString().slice(0, 10);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${EVENT_PREFIX}${day}/${ts}~${type}~${country}~${ua.device}~${ua.browser}~${ua.os}~${extra}~${rand}`;
}

// Inverse of eventKey — null for anything that doesn't parse.
function parseEventKey(key) {
  const m = /^ev\/\d{4}-\d{2}-\d{2}\/(\d+)~(view|click|session)~([A-Z]{2})~(\w+)~(\w+)~(\w+)~([^~]*)~[0-9a-f]+$/.exec(String(key));
  if (!m) return null;
  const type = m[2];
  const ev = { ts: Number(m[1]), type, country: m[3], device: m[4], browser: m[5], os: m[6] };
  if (type === 'click') ev.target = unb64url(m[7]);
  if (type === 'session') ev.seconds = Number(m[7]) || 0;
  return ev;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (raw.length > 2048) return json(413, { ok: false, error: 'Request too large.' });
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { body = null; }
  if (!body || typeof body !== 'object' || !TYPES.includes(body.type)) return json(400, { ok: false, error: 'Unknown event.' });

  // Bots are acknowledged but not recorded.
  if (isBot(event)) return json(200, { ok: true, recorded: false });

  let extra = '-';
  if (body.type === 'click') {
    const target = typeof body.target === 'string' ? body.target.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 60) : '';
    if (!target) return json(400, { ok: false, error: 'Click target required.' });
    extra = b64url(target);
  } else if (body.type === 'session') {
    const seconds = Math.round(Number(body.seconds));
    if (!Number.isFinite(seconds) || seconds < 2) return json(400, { ok: false, error: 'Invalid session length.' });
    extra = String(Math.min(seconds, 3600));
  }

  const limit = await rateLimit(event, { bucket: 'log-event', limit: 60, windowSec: 600 });
  if (!limit.ok) return tooManyRequests(limit);

  try {
    const ts = Date.now();
    const key = eventKey(ts, body.type, countryOf(event), parseUserAgent(userAgent(event)), extra);
    await analyticsStore().set(key, '1');
    return json(200, { ok: true, recorded: true });
  } catch (err) {
    console.error('[log-event] write failed —', err && err.message);
    return json(500, { ok: false, error: 'Could not record event.' });
  }
};

exports.EVENT_PREFIX = EVENT_PREFIX;
exports.parseEventKey = parseEventKey;
exports.countryOf = countryOf;
