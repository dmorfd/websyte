// POST /.netlify/functions/gallery-notify   (admin only)
//
// Admin → Gallery → Comment notifications. This site's own Discord webhook
// for comments on its own photos in the shared gallery. Stored here, on this
// site — never sent to the gallery's server. gallery-comment-notify.js (a
// scheduled function) does the posting.
//   {action:'get'}                       → {ok, set, masked, enabled}
//   {action:'save', webhookUrl, enabled} → webhookUrl '' removes it
//   {action:'test'}                      → posts a test message
// The full URL is never sent back to the browser, only a masked form.
const { checkAdmin, authFailure } = require('./lib/admin-auth');
const { store, SETTINGS, isWebhook, post } = require('./lib/gallery-notify');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});
const mask = (u) => (u ? u.replace(/\/webhooks\/(\d+)\/.*$/, (m, id) => `/webhooks/${id}/••••••`) : '');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  const auth = await checkAdmin(event);
  if (!auth.ok) return authFailure(auth);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { ok: false, error: 'Body must be a JSON object.' });

  let s;
  try { s = store(); } catch { return json(500, { ok: false, error: 'Content store not configured.' }); }
  try {
    const cur = (await s.get(SETTINGS, { type: 'json' })) || {};
    const url = typeof cur.webhookUrl === 'string' ? cur.webhookUrl : '';
    const enabled = cur.enabled !== false;

    if (body.action === 'get') return json(200, { ok: true, set: !!url, masked: mask(url), enabled });

    if (body.action === 'save') {
      const next = { webhookUrl: url, enabled };
      if (body.webhookUrl !== undefined) {
        const w = typeof body.webhookUrl === 'string' ? body.webhookUrl.trim() : '';
        if (w && !isWebhook(w)) return json(400, { ok: false, error: 'That isn\'t a Discord webhook URL (https://discord.com/api/webhooks/…).' });
        next.webhookUrl = w;
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') return json(400, { ok: false, error: 'enabled must be true or false.' });
        next.enabled = body.enabled;
      }
      await s.setJSON(SETTINGS, next);
      return json(200, { ok: true, set: !!next.webhookUrl, masked: mask(next.webhookUrl), enabled: next.enabled });
    }

    if (body.action === 'test') {
      if (!url) return json(400, { ok: false, error: 'Save a webhook first.' });
      const status = await post(url, { embeds: [{ title: 'Gallery comment notifications are on', description: 'New comments on your photos in the shared gallery will appear here.', color: 0xd7263d }] });
      if (status >= 200 && status < 300) return json(200, { ok: true });
      return json(502, { ok: false, error: status === 404 || status === 401 ? 'Discord says that webhook no longer exists — paste a new one.' : `Discord answered HTTP ${status}.` });
    }
    return json(400, { ok: false, error: 'Unknown action.' });
  } catch (err) {
    console.error('[gallery-notify] failed —', err && err.message);
    return json(500, { ok: false, error: 'Something went wrong — try again.' });
  }
};
