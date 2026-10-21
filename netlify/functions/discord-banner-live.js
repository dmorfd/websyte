// GET /.netlify/functions/discord-banner-live
//
// Returns the LIVE Discord profile banner, accent colour and avatar
// decoration, so the profile card mirrors Discord automatically the way
// Lanyard does the avatar. Needs SITE_OWNER_DISCORD_ID (or DISCORD_USER_ID)
// plus either DISCORD_BOT_TOKEN, or GALLERY_API — without a bot token it asks
// the shared gallery's server (arandomperson.dev), which answers for the
// Discord IDs on its gallery roster. With neither it answers
// {reason:'no-token'} and the public site stops polling.
// Replies are CDN-cached for two minutes so visitor traffic never reaches
// Discord's rate limits.
const { getStore } = require('@netlify/blobs');
const { DISCORD_USER_AGENT: USER_AGENT } = require('./bot-filter');

// The last good answer, kept so a passing Discord hiccup (timeout, 429, 5xx)
// still serves the banner instead of an error and an empty banner.
const LAST_KEY = 'banner-live-last';
const lastStore = () => getStore({ name: 'site-content', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN });
async function remember(body, userId) {
  try {
    const s = lastStore();
    const cur = await s.get(LAST_KEY, { type: 'json' });
    if (!cur || cur.userId !== userId || JSON.stringify(cur.body) !== JSON.stringify(body)) await s.setJSON(LAST_KEY, { userId, body, at: Date.now() });
  } catch (err) { console.error('[discord-banner-live] could not store last banner —', err && err.message); }
}
async function lastGood(failure, userId) {
  try {
    const rec = await lastStore().get(LAST_KEY, { type: 'json' });
    if (rec && rec.userId === userId && rec.body && rec.body.ok === true) return json(200, { ...rec.body, stale: true }, CACHED(60));
  } catch {}
  return failure;
}
// Success → remember it; failure (5xx) → the last good one if there is one.
async function settle(res, userId) {
  if (res.statusCode === 200) {
    const b = JSON.parse(res.body);
    if (b.ok === true) await remember(b, userId);
    return res;
  }
  return res.statusCode >= 502 ? lastGood(res, userId) : res;
}

const json = (statusCode, body, headers) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body),
});

const CACHED = (seconds) => ({
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': `public, s-maxage=${seconds}, stale-while-revalidate=60`,
});

const ERROR_CACHE = { 'Netlify-CDN-Cache-Control': 'public, s-maxage=60' };

// The shared gallery's API base (https only), or ''.
function galleryApi() {
  const raw = String(process.env.GALLERY_API || '').trim().replace(/\/+$/, '');
  try { return new URL(raw).protocol === 'https:' ? raw : ''; } catch { return ''; }
}

// No bot token here: the gallery's server makes the Discord call instead, for
// IDs on its roster ({ok:false, reason:'not-rostered'} otherwise). Only the
// fields this site uses are passed on.
async function viaGallery(userId) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(`${galleryApi()}/discord-banner-live?user=${userId}`, { signal: ac.signal, redirect: 'error' });
    const d = await res.json().catch(() => null);
    const isObj = !!d && typeof d === 'object';
    // Not on the roster (or nothing to give): answer like "no token", which
    // tells the page to keep Lanyard's avatar decoration and stop polling.
    if (isObj && d.ok !== true && res.status !== 429 && res.status < 500) {
      return json(200, { ok: false, reason: 'no-token', detail: typeof d.reason === 'string' ? d.reason.slice(0, 40) : 'unavailable' }, CACHED(300));
    }
    // Throttled or failing: briefly cached, so visitors don't each retry it.
    if (!res.ok || !isObj) return json(502, { ok: false, reason: 'gallery-error', status: res.status }, ERROR_CACHE);
    // Only what the bot-token path would produce: a Discord CDN banner for
    // this site's own user, and a decoration preset.
    const cdn = (v, prefix) => {
      if (typeof v !== 'string') return '';
      try {
        const u = new URL(v);
        return u.protocol === 'https:' && u.hostname === 'cdn.discordapp.com' && !u.username && !u.password && u.pathname.startsWith(prefix) ? u.href : '';
      } catch { return ''; }
    };
    const dns = d.displayNameStyles;
    return json(200, {
      ok: true,
      url: cdn(d.url, `/banners/${userId}/`),
      accentColor: Number.isInteger(d.accentColor) ? d.accentColor : null,
      avatarDecoration: cdn(d.avatarDecoration, '/avatar-decoration-presets/') || null,
      displayNameStyles: dns && typeof dns === 'object' && Array.isArray(dns.colors)
        ? { font_id: Number(dns.font_id) || 0, effect_id: Number(dns.effect_id) || 0, colors: dns.colors.filter((c) => Number.isInteger(c)).slice(0, 8) }
        : null,
    }, CACHED(120));
  } catch (err) {
    console.error('[discord-banner-live] gallery request failed —', err && err.message);
    return json(502, { ok: false, reason: 'gallery-unreachable' }, ERROR_CACHE);
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });

  const token = process.env.DISCORD_BOT_TOKEN;
  const userId = [process.env.SITE_OWNER_DISCORD_ID, process.env.DISCORD_USER_ID].map((v) => String(v || '').trim()).find(Boolean) || '';
  if (!userId || (!token && !galleryApi())) return json(200, { ok: false, reason: 'no-token' }, CACHED(300));
  if (!/^\d{5,25}$/.test(userId)) {
    console.error('[discord-banner-live] SITE_OWNER_DISCORD_ID / DISCORD_USER_ID is not a numeric Discord ID');
    return json(500, { ok: false, reason: 'bad-user-id' });
  }
  if (!token) return settle(await viaGallery(userId), userId);
  return settle(await viaBot(token, userId), userId);
};

async function viaBot(token, userId) {

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(`https://discord.com/api/v10/users/${userId}`, {
      headers: { Authorization: `Bot ${token}`, 'User-Agent': USER_AGENT },
      signal: ac.signal,
    });
    if (!res.ok) {
      console.error(`[discord-banner-live] Discord API ${res.status}`);
      return json(502, { ok: false, reason: 'discord-error', status: res.status });
    }
    const u = await res.json();

    const banner = typeof u.banner === 'string' && u.banner ? u.banner : '';
    const url = banner
      ? `https://cdn.discordapp.com/banners/${userId}/${banner}.${banner.startsWith('a_') ? 'gif' : 'png'}?size=600`
      : '';
    let accentColor = typeof u.accent_color === 'number' ? u.accent_color : null;
    if (accentColor === null && typeof u.banner_color === 'string' && /^#[0-9a-f]{6}$/i.test(u.banner_color)) {
      accentColor = parseInt(u.banner_color.slice(1), 16);
    }
    const asset = u.avatar_decoration_data && u.avatar_decoration_data.asset;
    const avatarDecoration = asset
      ? `https://cdn.discordapp.com/avatar-decoration-presets/${asset}.png?passthrough=true`
      : null;

    // Nitro display name style (font, effect, colours), when Discord includes
    // it — a fallback for the profile-card name if Lanyard doesn't carry it.
    const s = u.display_name_styles;
    const displayNameStyles = s && typeof s === 'object' && Array.isArray(s.colors)
      ? { font_id: Number(s.font_id) || 0, effect_id: Number(s.effect_id) || 0, colors: s.colors.filter((c) => Number.isInteger(c)).slice(0, 8) }
      : null;

    return json(200, { ok: true, url, accentColor, avatarDecoration, displayNameStyles }, CACHED(120));
  } catch (err) {
    console.error('[discord-banner-live] request failed —', err && err.message);
    return json(502, { ok: false, reason: 'discord-unreachable' });
  } finally {
    clearTimeout(timer);
  }
}
