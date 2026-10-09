// POST /.netlify/functions/increment-view
//
// Bumps the global view counter. The public site calls it once per browser
// (3-hour cooldown kept in localStorage) and only AFTER the enter screen is
// clicked, so link-preview fetchers never reach it. Server-side, requests from
// other sites are refused, bots are filtered by User-Agent, visitors without a
// Turnstile pass don't count while the entry gate is on, and each client is
// rate-limited; in those cases the reply still carries the current count so
// the badge can render.
// The increment is a conditional write (ETag match) so concurrent visits
// can't overwrite each other's +1.
const { getStore } = require('@netlify/blobs');
const { isBot, isCrossSite, blockedByGate } = require('./bot-filter');
const { rateLimit, writeIfUnchanged } = require('./lib/rate-limit');

const contentStore = () => getStore({
  name: 'site-content',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN,
  consistency: 'strong',
});

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

async function currentCount(store) {
  const v = await store.get('views', { type: 'json' });
  return Number(v && v.count) || 0;
}

async function increment(store) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await store.getWithMetadata('views', { type: 'json' });
    const data = cur && cur.data && typeof cur.data === 'object' ? cur.data : {};
    const next = { ...data, count: (Number(data.count) || 0) + 1 };
    const res = await writeIfUnchanged(store, 'views', cur, next);
    if (res.modified) return next.count;
  }
  throw new Error('Could not increment the view counter (too much contention).');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  if (isCrossSite(event)) return json(403, { ok: false, error: 'Forbidden' });

  try {
    const store = contentStore();
    if (isBot(event) || await blockedByGate(event, store)) {
      return json(200, { ok: true, count: await currentCount(store), counted: false });
    }

    const limit = await rateLimit(event, { bucket: 'increment-view', limit: 6, windowSec: 3600 });
    if (!limit.ok) return json(200, { ok: true, count: await currentCount(store), counted: false });

    return json(200, { ok: true, count: await increment(store), counted: true });
  } catch (err) {
    console.error('[increment-view] failed —', err && err.message);
    return json(500, { ok: false, error: 'Could not update the view count.' });
  }
};
