// GET /.netlify/functions/get-analytics?range=24h|3d|7d|14d|all   (admin only)
//
// Backs the admin Analytics section: total views + trend, most-clicked
// socials, visitor devices (donut + browsers + OS), and top countries.
// Events are read from their blob KEYS (see log-event.js), listing one day
// prefix at a time, so no per-event reads are needed.
const { getStore } = require('@netlify/blobs');
const { checkAdmin, authFailure } = require('./lib/admin-auth');
const { EVENT_PREFIX, parseEventKey } = require('./log-event');
const { BROWSER_NAMES, OS_NAMES } = require('./bot-filter');
const { countryName, countryFlag } = require('./lib/countries');

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_DAYS = { '24h': 1, '3d': 3, '7d': 7, '14d': 14, all: null };
const SERIES_BUCKETS = 12;

const analyticsStore = () => getStore({
  name: 'site-analytics',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN,
  consistency: 'strong',
});

const json = (statusCode, body, headers) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body),
});

// Every "ev/<day>/" prefix that can hold events newer than `since`.
function dayPrefixes(since, now) {
  const out = [];
  for (let d = Date.UTC(new Date(since).getUTCFullYear(), new Date(since).getUTCMonth(), new Date(since).getUTCDate()); d <= now; d += DAY_MS) {
    out.push(`${EVENT_PREFIX}${new Date(d).toISOString().slice(0, 10)}/`);
  }
  return out;
}

async function listEvents(store, prefix) {
  const events = [];
  for await (const page of store.list({ prefix, paginate: true })) {
    for (const blob of page.blobs) {
      const ev = parseEventKey(blob.key);
      if (ev) events.push(ev);
    }
  }
  return events;
}

const pct = (n, total) => (total ? Math.round((n / total) * 1000) / 10 : 0);

function tally(items, keyOf) {
  const m = new Map();
  for (const it of items) { const k = keyOf(it); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function fmtDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' }, { Allow: 'GET' });

  const auth = await checkAdmin(event);
  if (!auth.ok) return authFailure(auth);

  const q = event.queryStringParameters || {};
  const range = Object.prototype.hasOwnProperty.call(RANGE_DAYS, q.range) ? q.range : '7d';
  const now = Date.now();
  const since = RANGE_DAYS[range] === null ? 0 : now - RANGE_DAYS[range] * DAY_MS;

  let events;
  try {
    const store = analyticsStore();
    const prefixes = since === 0 ? [EVENT_PREFIX] : dayPrefixes(since, now);
    events = (await Promise.all(prefixes.map((p) => listEvents(store, p)))).flat()
      .filter((e) => e.ts >= since && e.ts <= now + 60000);
  } catch (err) {
    console.error('[get-analytics] read failed —', err && err.message);
    return json(500, { ok: false, error: 'Analytics store unavailable — check NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN.' });
  }

  const views = events.filter((e) => e.type === 'view');
  const clicks = events.filter((e) => e.type === 'click');
  const sessions = events.filter((e) => e.type === 'session');
  const total = views.length;

  // Trend: views split into equal time slices across the range.
  const start = since || (total ? views.reduce((m, v) => Math.min(m, v.ts), now) : now - DAY_MS);
  const span = Math.max(1, now - start);
  const series = new Array(SERIES_BUCKETS).fill(0);
  for (const v of views) {
    const i = Math.min(SERIES_BUCKETS - 1, Math.max(0, Math.floor(((v.ts - start) / span) * SERIES_BUCKETS)));
    series[i]++;
  }

  const socials = tally(clicks, (c) => c.target).slice(0, 8).map(([name, n]) => ({ name, clicks: n }));

  const deviceCounts = new Map(tally(views, (v) => v.device));
  const devices = ['pc', 'mobile', 'tablet', 'other'].map((id) => ({ id, views: deviceCounts.get(id) || 0 }));

  const avgSession = sessions.length ? sessions.reduce((sum, s) => sum + s.seconds, 0) / sessions.length : 0;
  const deviceStats = [
    { lbl: 'Avg. session', val: sessions.length ? fmtDuration(avgSession) : '—' },
    { lbl: 'Sessions', val: sessions.length.toLocaleString('en-US') },
  ];

  const browsers = tally(views, (v) => v.browser).slice(0, 6)
    .map(([id, n]) => ({ id, name: BROWSER_NAMES[id] || id, pct: pct(n, total) }));
  const os = tally(views, (v) => v.os).slice(0, 6)
    .map(([id, n]) => ({ id, name: OS_NAMES[id] || id, pct: pct(n, total) }));
  const countries = tally(views, (v) => v.country).slice(0, 10)
    .map(([code, n]) => ({ code, name: countryName(code), flag: countryFlag(code), views: n, pct: pct(n, total) }));

  return json(200, {
    ok: true,
    range,
    totalViews: total,
    totalClicks: clicks.length,
    series,
    socials,
    devices,
    deviceStats,
    browsers,
    os,
    countries,
  });
};
