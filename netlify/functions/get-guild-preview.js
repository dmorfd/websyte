// GET /.netlify/functions/get-guild-preview?guildId=<snowflake>
//
// Fetches the Discord server preview shown when a visitor clicks the guild-tag
// pill next to the username: name, icon, banner, online/member counts,
// description and creation date. Uses the bot token (DISCORD_BOT_TOKEN) for
// the guild preview endpoint, falling back to the public widget JSON when the
// preview isn't available. CDN-cached per guildId for ten minutes.
// The bot token is only ever spent on the OWNER's own guild — the one shown in
// their Discord guild tag (primary_guild of DISCORD_USER_ID) — so the endpoint
// can't be used to look up arbitrary servers the bot happens to be in.
const { rateLimit, tooManyRequests } = require('./lib/rate-limit');

const { DISCORD_USER_AGENT: USER_AGENT } = require('./bot-filter');
const DISCORD_EPOCH = 1420070400000n;

const json = (statusCode, body, headers) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body),
});

const CACHED = {
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=600, stale-while-revalidate=300',
  'Netlify-Vary': 'query=guildId',
};

async function discordGet(url, auth) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const headers = { 'User-Agent': USER_AGENT };
    if (auth) headers.Authorization = `Bot ${auth}`;
    const res = await fetch(url, { headers, signal: ac.signal });
    return res.ok ? await res.json() : null;
  } finally {
    clearTimeout(timer);
  }
}

// The owner's current guild-tag server, cached briefly per warm lambda.
let ownerGuild = { id: '', at: 0 };
async function ownerGuildId(token, userId) {
  if (ownerGuild.at && Date.now() - ownerGuild.at < 5 * 60 * 1000) return ownerGuild.id;
  const user = await discordGet(`https://discord.com/api/v10/users/${userId}`, token);
  if (!user) throw new Error('could not read the owner profile');
  const pg = user.primary_guild || user.clan || null;
  ownerGuild = { id: pg && pg.identity_guild_id ? String(pg.identity_guild_id) : '', at: Date.now() };
  return ownerGuild.id;
}

// "Mar 2021" from the snowflake's embedded timestamp.
function establishedFrom(id) {
  const ms = Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  return new Date(ms).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });

  const guildId = String((event.queryStringParameters || {}).guildId || '').trim();
  if (!/^\d{15,25}$/.test(guildId)) return json(400, { ok: false, error: 'Invalid guildId.' });

  const limit = await rateLimit(event, { bucket: 'guild-preview', limit: 30, windowSec: 600 });
  if (!limit.ok) return tooManyRequests(limit);

  const token = process.env.DISCORD_BOT_TOKEN;
  const userId = String(process.env.DISCORD_USER_ID || '').trim();
  try {
    // With a bot configured, only the owner's own guild is ever looked up.
    let useBot = false;
    if (token && /^\d{5,25}$/.test(userId)) {
      if (await ownerGuildId(token, userId) !== guildId) {
        return json(404, { ok: false, reason: 'not-owner-guild' }, { 'Netlify-CDN-Cache-Control': 'public, s-maxage=600', 'Netlify-Vary': 'query=guildId' });
      }
      useBot = true;
    }
    const preview = useBot ? await discordGet(`https://discord.com/api/v10/guilds/${guildId}/preview`, token) : null;
    if (preview && preview.name) {
      const icon = preview.icon || '';
      const splash = preview.discovery_splash
        ? `https://cdn.discordapp.com/discovery-splashes/${guildId}/${preview.discovery_splash}.png?size=600`
        : preview.splash ? `https://cdn.discordapp.com/splashes/${guildId}/${preview.splash}.png?size=600` : '';
      const features = Array.isArray(preview.features) ? preview.features : [];
      return json(200, {
        ok: true,
        name: preview.name,
        verified: features.includes('VERIFIED') || features.includes('PARTNERED'),
        iconUrl: icon ? `https://cdn.discordapp.com/icons/${guildId}/${icon}.${icon.startsWith('a_') ? 'gif' : 'png'}?size=128` : '',
        bannerUrl: splash,
        onlineCount: Number(preview.approximate_presence_count) || 0,
        memberCount: Number(preview.approximate_member_count) || 0,
        est: establishedFrom(guildId),
        description: typeof preview.description === 'string' ? preview.description : '',
      }, CACHED);
    }

    // Fallback: the server's public widget (only if the owner enabled it).
    const widget = await discordGet(`https://discord.com/api/guilds/${guildId}/widget.json`);
    if (widget && widget.name) {
      return json(200, {
        ok: true,
        name: widget.name,
        verified: false,
        iconUrl: '',
        bannerUrl: '',
        onlineCount: Number(widget.presence_count) || 0,
        memberCount: 0,
        est: establishedFrom(guildId),
        description: '',
      }, CACHED);
    }
    return json(404, { ok: false, reason: useBot ? 'unavailable' : 'no-token' });
  } catch (err) {
    console.error('[get-guild-preview] request failed —', err && err.message);
    return json(502, { ok: false, reason: 'discord-unreachable' });
  }
};
