// Scheduled (every 5 minutes, see netlify.toml) — not reachable by URL.
//
// Posts new comments on THIS site's photos in the shared gallery to this
// site's own Discord webhook (Admin → Gallery → Comment notifications). The
// gallery's server can't be told this site's webhook (the roster is not
// delegated), so this site asks it instead: one `list` through the same key
// the admin proxy uses, then only comments not seen before are posted. The
// first run just records what's already there, so nothing old floods in.
const { store, SETTINGS, SEEN, isWebhook, galleryApi, post } = require('./lib/gallery-notify');

const MAX_PER_RUN = 10;

const mine = (im, me) => {
  if (!im || !me) return false;
  const o = im.owner;
  if (typeof o === 'string') return o === me.ref || o === String(me.ownerId || '');
  const ref = (o && o.ref) || im.ownerRef || '';
  const id = String(im.ownerId || (o && o.id) || '');
  return (!!me.ref && ref === me.ref) || (!!me.ownerId && id === String(me.ownerId));
};

exports.handler = async () => {
  let s;
  try { s = store(); } catch { return { statusCode: 200 }; }
  const cfg = (await s.get(SETTINGS, { type: 'json' }).catch(() => null)) || {};
  if (!isWebhook(cfg.webhookUrl) || cfg.enabled === false) return { statusCode: 200 };
  const api = galleryApi();
  const key = String(process.env.GALLERY_KEY || '').trim();
  if (!api || !key) return { statusCode: 200 };

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
    if (!res.ok) { console.error('[gallery-comment-notify] list HTTP', res.status); return { statusCode: 200 }; }
    list = await res.json();
  } catch (err) {
    console.error('[gallery-comment-notify] list failed —', err && err.message);
    return { statusCode: 200 };
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
    return { statusCode: 200 };
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
  return { statusCode: 200 };
};
