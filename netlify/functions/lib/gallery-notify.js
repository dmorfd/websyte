// Shared by gallery-notify.js (admin settings) and gallery-comment-notify.js
// (the scheduled check): where the owner's comment webhook is stored, how
// it's validated, and how a message is posted to it.
const { getStore } = require('@netlify/blobs');
const { DISCORD_USER_AGENT } = require('../bot-filter');
const { writeIfUnchanged } = require('./rate-limit');

const store = () => getStore({
  name: 'site-content',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN,
  consistency: 'strong',
});
// shared: true once the shared gallery holds the webhook too (its my-webhook
// action) — it then posts every comment on this owner's photos itself, from
// either site, and the check below stands down so nothing is posted twice.
const SETTINGS = 'gallery-notify';        // {webhookUrl, enabled, shared}
const SEEN = 'gallery-notify-seen';       // {ids:[imageId:commentId…], ready}

// Discord webhooks only: this URL is posted to server-side, so anything else
// would turn the function into a request forwarder.
const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{15,25}\/[\w-]{20,200}$/;
const isWebhook = (u) => typeof u === 'string' && WEBHOOK_RE.test(u.trim());

function galleryApi() {
  const raw = String(process.env.GALLERY_API || '').trim().replace(/\/+$/, '');
  let u;
  try { u = new URL(raw); } catch { return ''; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  return u.protocol === 'https:' || (local && u.protocol === 'http:') ? raw : '';
}

// Sets (or, with '', clears) this owner's comment webhook on the shared
// gallery, through gallery-admin with this site's gallery key.
//   → {ok:true} | {ok:false, unsupported:true} (an older gallery server) |
//     {ok:false, error}
async function setSharedWebhook(webhook) {
  const api = galleryApi();
  const key = String(process.env.GALLERY_KEY || '').trim();
  if (!api || !key) return { ok: false, unsupported: true };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(api + '/gallery-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
      body: JSON.stringify({ action: 'my-webhook', webhook }),
      signal: ac.signal,
      redirect: 'error',
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.ok !== false) return { ok: true };
    const msg = String(d.error || d.message || '');
    if (res.status === 400 && /unknown action/i.test(msg)) return { ok: false, unsupported: true };
    return { ok: false, error: msg || `The gallery answered HTTP ${res.status}.` };
  } catch (err) {
    return { ok: false, error: err && err.name === 'AbortError' ? 'The gallery took too long to answer.' : 'Could not reach the gallery.' };
  } finally {
    clearTimeout(timer);
  }
}

async function post(webhookUrl, payload) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(webhookUrl.trim() + '?wait=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': DISCORD_USER_AGENT },
      body: JSON.stringify({ allowed_mentions: { parse: [] }, ...payload }),
      signal: ac.signal,
      redirect: 'error',
    });
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

// Posts comments on THIS site's photos that haven't been posted before.
// Called by the 1-minute schedule and, right after a visitor comments on this
// site's /gallery, by gallery-comment-check. A short lock keeps the two from
// posting the same comment twice when they run at once.
const LOCK = 'gallery-notify-lock';
const MAX_PER_RUN = 10;

const mine = (im, me) => {
  if (!im || !me) return false;
  const o = im.owner;
  if (typeof o === 'string') return o === me.ref || o === String(me.ownerId || '');
  const ref = (o && o.ref) || im.ownerRef || '';
  const id = String(im.ownerId || (o && o.id) || '');
  return (!!me.ref && ref === me.ref) || (!!me.ownerId && id === String(me.ownerId));
};

async function checkComments() {
  let s;
  try { s = store(); } catch { return; }
  const cfg = (await s.get(SETTINGS, { type: 'json' }).catch(() => null)) || {};
  if (!isWebhook(cfg.webhookUrl) || cfg.enabled === false || cfg.shared === true) return;
  const api = galleryApi();
  const key = String(process.env.GALLERY_KEY || '').trim();
  if (!api || !key) return;

  let list;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(api + '/gallery-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
      body: JSON.stringify({ action: 'list' }),
      signal: ac.signal, redirect: 'error',
    });
    if (!res.ok) { console.error('[gallery-comment-notify] list HTTP', res.status); return; }
    list = await res.json();
  } catch (err) {
    console.error('[gallery-comment-notify] list failed —', err && err.message);
    return;
  } finally { clearTimeout(timer); }

  const me = list && list.me;
  const images = (list && list.gallery && Array.isArray(list.gallery.images)) ? list.gallery.images : [];
  const comments = (list && list.comments && typeof list.comments === 'object') ? list.comments : {};
  const all = [];
  for (const im of images) {
    if (!mine(im, me) || !Array.isArray(comments[im.id])) continue;
    for (const c of comments[im.id]) if (c && c.id != null) all.push({ key: im.id + ':' + c.id, im, c });
  }

  const seenRec = (await s.get(SEEN, { type: 'json' }).catch(() => null)) || {};
  const seen = new Set(Array.isArray(seenRec.ids) ? seenRec.ids : []);
  const current = new Set(all.map((x) => x.key));
  if (!seenRec.ready) {                        // first run: remember, don't post
    await s.setJSON(SEEN, { ready: true, ids: [...current] });
    return;
  }

  const fresh = all.filter((x) => !seen.has(x.key)).sort((a, b) => (Number(a.c.t) || 0) - (Number(b.c.t) || 0));
  const site = String(process.env.URL || '').replace(/\/+$/, '');
  for (const x of fresh.slice(0, MAX_PER_RUN)) {
    const status = await post(cfg.webhookUrl, {
      embeds: [{
        title: ('New comment on ' + (x.im.title || 'your photo')).slice(0, 250),
        url: site ? site + '/gallery' : undefined,
        description: String(x.c.comment || '').slice(0, 2000),
        author: { name: String(x.c.username || 'anonymous').slice(0, 100) },
        thumbnail: /^https:\/\//.test(x.im.url || '') ? { url: x.im.url } : undefined,
        timestamp: Number(x.c.t) ? new Date(Number(x.c.t)).toISOString() : undefined,
        color: 0xd7263d,
      }],
    }).catch(() => 0);
    if (status === 429 || !status) break;                // try the rest next run
    seen.add(x.key);                                     // posted, or the webhook is gone
    if (status === 404 || status === 401) { console.error('[gallery-comment-notify] webhook no longer exists'); break; }
  }
  // Only keep ids that still exist, so the record stays the size of the comments.
  await s.setJSON(SEEN, { ready: true, ids: [...seen].filter((k) => current.has(k)) });
  return;
}

async function checkCommentsOnce() {
  let s;
  try { s = store(); } catch { return 'no-store'; }
  const now = Date.now();
  const cur = await s.getWithMetadata(LOCK, { type: 'json' }).catch(() => null);
  if (cur && cur.data && cur.data.until > now) return 'busy';
  const claim = await writeIfUnchanged(s, LOCK, cur, { until: now + 25000 }).catch(() => ({ modified: false }));
  if (!claim.modified) return 'busy';
  try { await checkComments(); return 'done'; }
  finally { await s.setJSON(LOCK, { until: 0 }).catch(() => {}); }
}

module.exports = { store, SETTINGS, SEEN, isWebhook, galleryApi, post, setSharedWebhook, checkCommentsOnce };
