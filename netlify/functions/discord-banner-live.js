// GET /.netlify/functions/discord-banner-live
//
// Returns the LIVE Discord profile banner, accent colour and avatar
// decoration, so the profile card mirrors Discord automatically the way
// Lanyard does the avatar. Needs DISCORD_BOT_TOKEN + DISCORD_USER_ID; without
// them it answers {reason:'no-token'} and the public site stops polling.
// Replies are CDN-cached for two minutes so visitor traffic never reaches
// Discord's rate limits.
const USER_AGENT = 'DiscordBot (https://YOUR_DOMAIN, 1.0)';

const json = (statusCode, body, headers) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body),
});

const CACHED = (seconds) => ({
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': `public, s-maxage=${seconds}, stale-while-revalidate=60`,
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });

  const token = process.env.DISCORD_BOT_TOKEN;
  const userId = String(process.env.DISCORD_USER_ID || '').trim();
  if (!token || !userId) return json(200, { ok: false, reason: 'no-token' }, CACHED(300));
  if (!/^\d{5,25}$/.test(userId)) {
    console.error('[discord-banner-live] DISCORD_USER_ID is not a numeric Discord ID');
    return json(500, { ok: false, reason: 'bad-user-id' });
  }

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

    return json(200, { ok: true, url, accentColor, avatarDecoration }, CACHED(120));
  } catch (err) {
    console.error('[discord-banner-live] request failed —', err && err.message);
    return json(502, { ok: false, reason: 'discord-unreachable' });
  } finally {
    clearTimeout(timer);
  }
};
