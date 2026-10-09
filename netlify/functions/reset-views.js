// POST /.netlify/functions/reset-views   (admin only)
//
// Backs "Reset View Counter & Analytics" in the Settings drawer's Danger Zone.
//   {resetCounter: true}   → public view count back to 0; viewsResetCount++ so
//                            every visitor's local 3-hour dedupe is cleared and
//                            their next visit counts again
//   {resetAnalytics: true} → delete every stored analytics event
// Both default to true when omitted.
const { getStore } = require('@netlify/blobs');
const { checkAdmin, authFailure } = require('./lib/admin-auth');
const { writeIfUnchanged } = require('./lib/rate-limit');

const storeOf = (name) => getStore({
  name,
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN,
  consistency: 'strong',
});

const json = (statusCode, body, headers) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body),
});

async function resetCounter(store) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await store.getWithMetadata('views', { type: 'json' });
    const resetCount = (Number(cur && cur.data && cur.data.resetCount) || 0) + 1;
    const next = { count: 0, resetCount };
    const res = await writeIfUnchanged(store, 'views', cur, next);
    if (res.modified) return resetCount;
  }
  throw new Error('Could not reset the view counter (too much contention).');
}

// The site-analytics store holds nothing but event blobs (log-event writes
// only ev/ keys), so one server-side bulk delete clears them all — no matter
// how many there are — instead of one API request per event.
async function clearEvents(store) {
  const { deletedBlobs } = await store.deleteAll();
  return deletedBlobs;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' }, { Allow: 'POST' });

  const auth = await checkAdmin(event);
  if (!auth.ok) return authFailure(auth);

  let body = {};
  try { body = JSON.parse(event.body || '{}') || {}; } catch { return json(400, { ok: false, error: 'Body must be JSON.' }); }
  const doCounter = body.resetCounter !== false;
  const doAnalytics = body.resetAnalytics !== false;

  try {
    const out = { ok: true };
    if (doCounter) {
      out.viewsResetCount = await resetCounter(storeOf('site-content'));
      out.count = 0;
    }
    if (doAnalytics) out.deletedEvents = await clearEvents(storeOf('site-analytics'));
    return json(200, out);
  } catch (err) {
    console.error('[reset-views] failed —', err && err.message);
    return json(500, { ok: false, error: 'Reset failed — try again.' });
  }
};
