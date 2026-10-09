// POST /.netlify/functions/notify-visit
//
// Pings a Discord channel (DISCORD_WEBHOOK_URL) when a real visitor enters the
// site. Device-level only — country, device, browser and OS; never the IP.
// The public site skips it for the owner's own devices (/?owner). Here,
// requests from other sites, bots and (while the entry gate is on) visitors
// without a Turnstile pass are dropped, and each client pings at most once per
// 30 minutes (plus a global cap) so the channel can't be flooded.
const { getStore } = require('@netlify/blobs');
const { isBot, isCrossSite, blockedByGate, userAgent, parseUserAgent, BROWSER_NAMES, OS_NAMES, DEVICE_NAMES } = require('./bot-filter');
const { rateLimit } = require('./lib/rate-limit');
const { countryName, countryFlag } = require('./lib/countries');
const { countryOf } = require('./log-event');

const USER_AGENT = 'DiscordBot (https://YOUR_DOMAIN, 1.0)';

const contentStore = () => getStore({
  name: 'site-content',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN,
  consistency: 'strong',
});

const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  if (isCrossSite(event)) return json(403, { ok: false, error: 'Forbidden' });
  if (isBot(event)) return json(200, { ok: true, sent: false, reason: 'bot' });
  try {
    if (await blockedByGate(event, contentStore())) return json(200, { ok: true, sent: false, reason: 'gate' });
  } catch (err) {
    console.error('[notify-visit] gate check failed —', err && err.message);
    return json(200, { ok: true, sent: false, reason: 'unavailable' });
  }

  const webhook = String(process.env.DISCORD_WEBHOOK_URL || '').trim();
  if (!webhook) return json(200, { ok: true, sent: false, reason: 'no-webhook' });
  if (!WEBHOOK_RE.test(webhook)) {
    console.error('[notify-visit] DISCORD_WEBHOOK_URL is not a Discord webhook URL');
    return json(500, { ok: false, error: 'Webhook misconfigured.' });
  }

  const perIp = await rateLimit(event, { bucket: 'notify-visit', limit: 1, windowSec: 1800 });
  if (!perIp.ok) return json(200, { ok: true, sent: false, reason: 'rate-limited' });
  const global = await rateLimit(event, { bucket: 'notify-visit-all', key: 'all', limit: 60, windowSec: 3600 });
  if (!global.ok) return json(200, { ok: true, sent: false, reason: 'rate-limited' });

  const ua = parseUserAgent(userAgent(event));
  const cc = countryOf(event);
  const payload = {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: 'New visitor',
      color: 0xe7a6e0,
      fields: [
        { name: 'Country', value: `${countryFlag(cc)} ${countryName(cc)}`, inline: true },
        { name: 'Device', value: DEVICE_NAMES[ua.device] || 'Other', inline: true },
        { name: 'Browser', value: `${BROWSER_NAMES[ua.browser] || 'Other'} · ${OS_NAMES[ua.os] || 'Other'}`, inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    if (!res.ok) {
      console.error(`[notify-visit] webhook replied ${res.status}`);
      return json(502, { ok: false, error: 'Webhook rejected the ping.' });
    }
    return json(200, { ok: true, sent: true });
  } catch (err) {
    console.error('[notify-visit] webhook unreachable —', err && err.message);
    return json(502, { ok: false, error: 'Webhook unreachable.' });
  } finally {
    clearTimeout(timer);
  }
};
