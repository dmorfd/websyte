// Shared by gallery-notify.js (admin settings) and gallery-comment-notify.js
// (the scheduled check): where the owner's comment webhook is stored, how
// it's validated, and how a message is posted to it.
const { getStore } = require('@netlify/blobs');
const { DISCORD_USER_AGENT } = require('../bot-filter');

const store = () => getStore({
  name: 'site-content',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN,
  consistency: 'strong',
});
const SETTINGS = 'gallery-notify';        // {webhookUrl, enabled}
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

module.exports = { store, SETTINGS, SEEN, isWebhook, galleryApi, post };
