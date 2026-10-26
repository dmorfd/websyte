// GET /.netlify/functions/discord-banner-live
//
// The LIVE Discord profile banner, accent colour and avatar decoration, so the
// profile card mirrors Discord the way Lanyard does the avatar. Lanyard does
// not expose banners at all — only an authenticated Discord REST call does —
// so this needs this site's own bot token:
//   DISCORD_BOT_TOKEN                        a bot token (any app's bot; no
//                                            shared server needed to look a
//                                            user up by id)
//   SITE_OWNER_DISCORD_ID (or DISCORD_USER_ID)  whose profile to read
// No token → {ok:false, reason:'no-token'} and the page stops polling.
//
// Caching is not optional: every visitor polls this, so the answer is kept in
// a blob for two minutes and Discord is asked at most once per window. On a
// 429, any other non-2xx or a network error, the last good answer is served
// (stale) rather than blanking the banner. The cache key carries the user id,
// so changing SITE_OWNER_DISCORD_ID can never serve the previous user's banner.
const { getStore } = require('@netlify/blobs');
const { DISCORD_USER_AGENT: USER_AGENT } = require('./bot-filter');

const CACHE_MS = 2 * 60 * 1000;
const cacheKey = (userId) => `banner-live:${userId}`;
const store = () => getStore({ name: 'site-content', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });

const json = (statusCode, body, headers) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body),
});
const CACHED = (seconds) => ({
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': `public, s-maxage=${seconds}, stale-while-revalidate=60`,
});

async function readCache(userId) {
  try { return await store().get(cacheKey(userId), { type: 'json' }); } catch { return null; }
}
async function writeCache(userId, body) {
  try { await store().setJSON(cacheKey(userId), { at: Date.now(), body }); }
  catch (err) { console.error('[discord-banner-live] could not cache —', err && err.message); }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });

  const token = String(process.env.DISCORD_BOT_TOKEN || '').trim();
  const userId = [process.env.SITE_OWNER_DISCORD_ID, process.env.DISCORD_USER_ID].map((v) => String(v || '').trim()).find(Boolean) || '';
  if (!token || !userId) return json(200, { ok: false, reason: 'no-token' }, CACHED(300));
  if (!/^\d{5,25}$/.test(userId)) {
    console.error('[discord-banner-live] SITE_OWNER_DISCORD_ID / DISCORD_USER_ID is not a numeric Discord ID');
    return json(500, { ok: false, reason: 'bad-user-id' });
  }

  const cached = await readCache(userId);
  if (cached && cached.body && Date.now() - cached.at < CACHE_MS) return json(200, cached.body, CACHED(120));

  const live = await fromDiscord(token, userId);
  if (live.ok) {
    await writeCache(userId, live.body);
    return json(200, live.body, CACHED(120));
  }
  // Discord said no or didn't answer: the last good banner beats a blank one.
  if (cached && cached.body) return json(200, { ...cached.body, stale: true }, CACHED(60));
  return json(502, { ok: false, reason: live.reason, status: live.status }, { 'Netlify-CDN-Cache-Control': 'public, s-maxage=60' });
};

async function fromDiscord(token, userId) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(`https://discord.com/api/v10/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bot ${token}`, 'User-Agent': USER_AGENT },
      signal: ac.signal,
    });
    if (!res.ok) {
      console.error(`[discord-banner-live] Discord API ${res.status}`);
      return { ok: false, reason: 'discord-error', status: res.status };
    }
    const u = await res.json();

    const hash = typeof u.banner === 'string' && u.banner ? u.banner : '';
    // a_ marks an animated banner; size must be a power of two for the CDN.
    const url = hash ? `https://cdn.discordapp.com/banners/${userId}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}?size=1024` : '';
    let accentColor = typeof u.accent_color === 'number' ? u.accent_color : null;
    if (accentColor === null && typeof u.banner_color === 'string' && /^#[0-9a-f]{6}$/i.test(u.banner_color)) {
      accentColor = parseInt(u.banner_color.slice(1), 16);
    }
    const asset = u.avatar_decoration_data && u.avatar_decoration_data.asset;
    const avatarDecoration = asset ? `https://cdn.discordapp.com/avatar-decoration-presets/${asset}.png?passthrough=true` : null;

    // Nitro display-name style, when Discord includes it — a fallback for the
    // profile card's name if Lanyard doesn't carry it.
    const s = u.display_name_styles;
    const displayNameStyles = s && typeof s === 'object' && Array.isArray(s.colors)
      ? { font_id: Number(s.font_id) || 0, effect_id: Number(s.effect_id) || 0, colors: s.colors.filter((c) => Number.isInteger(c)).slice(0, 8) }
      : null;

    return { ok: true, body: { ok: true, url, accentColor, avatarDecoration, displayNameStyles } };
  } catch (err) {
    console.error('[discord-banner-live] request failed —', err && err.message);
    return { ok: false, reason: 'discord-unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
