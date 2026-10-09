// Bot / crawler detection + light User-Agent classification, plus the two
// other "is this a real visitor on our own page?" checks the public write
// endpoints share:
//   isBot()          — headless browsers, scrapers, link-preview fetchers
//   isCrossSite()    — requests fired from some OTHER website's page
//   gate pass cookie — proof the visitor solved the Turnstile entry gate
//
// Imported by increment-view, log-event, notify-visit and verify-turnstile so
// none of that traffic inflates the view counter, pollutes analytics, or pings
// Discord. parseUserAgent() supplies the device / browser / OS buckets that
// analytics and the visit ping report.
//
// This file sits in netlify/functions/, so Netlify also deploys it as an
// endpoint; the handler at the bottom just answers 404 so that endpoint is inert.

const crypto = require('crypto');

// Tokens that only appear in automated clients. Matched case-insensitively.
const BOT_PATTERN = new RegExp([
  'bot\\b', 'bot/', 'crawl', 'spider', 'slurp', 'scrap', 'archiver', 'indexer',
  'headless', 'phantomjs', 'puppeteer', 'playwright', 'selenium', 'webdriver',
  'lighthouse', 'pagespeed', 'gtmetrix', 'pingdom', 'uptime', 'statuscake', 'monitor',
  'preview', 'embedly', 'vkshare', 'validator',
  // link-preview fetchers — named exactly, so the apps' own in-app browsers
  // (Discord desktop, Pinterest, Instagram, …) still count as real visitors
  'facebookexternalhit', 'facebookcatalog', 'meta-externalagent', 'whatsapp/', 'telegrambot',
  'discordbot', 'slackbot', 'slack-imgproxy', 'skypeuri', 'linkedinbot', 'pinterestbot',
  'redditbot', 'tumblr', 'quora link preview',
  'googleother', 'google-inspectiontool', 'feedfetcher', 'mediapartners', 'adsbot',
  'yandex', 'baidu', 'sogou', 'exabot', 'seznam', 'petalbot', 'bytespider', 'semrush', 'ahrefs',
  'mj12', 'dotbot', 'dataforseo', 'gptbot', 'chatgpt-user', 'oai-searchbot', 'claudebot', 'claude-web', 'anthropic-ai',
  'perplexity', 'ccbot', 'cohere', 'diffbot', 'amazonbot', 'applebot', 'imagesift',
  'curl/', 'wget/', 'httpie', 'python', 'aiohttp', 'httpx', 'requests/', 'urllib', 'scrapy',
  'axios/', 'node-fetch', 'undici', 'got ', 'okhttp', 'java/', 'apache-httpclient', 'jakarta',
  'go-http-client', 'libwww', 'lwp::', 'ruby', 'php/', 'guzzle', 'postman', 'insomnia',
  'zgrab', 'masscan', 'nmap', 'nikto', 'sqlmap', 'nuclei', 'censys', 'shodan', 'netcraft',
].join('|'), 'i');

// Real-device names that happen to contain a bot token.
const FALSE_POSITIVES = /cubot/gi;

function userAgent(event) {
  const h = (event && event.headers) || {};
  return String(h['user-agent'] || h['User-Agent'] || '');
}

/** True for automated clients (or requests with no believable User-Agent). */
function isBot(event) {
  const ua = userAgent(event);
  if (ua.length < 12) return true;                 // missing / stub UA
  if (!/mozilla\/|opera\//i.test(ua)) return true; // every real browser sends one of these
  return BOT_PATTERN.test(ua.replace(FALSE_POSITIVES, ''));
}

const BROWSER_NAMES = {
  edge: 'Edge', opera: 'Opera', samsung: 'Samsung Internet', firefox: 'Firefox',
  chrome: 'Chrome', safari: 'Safari', other: 'Other',
};
const OS_NAMES = {
  windows: 'Windows', ios: 'iOS', macos: 'macOS', android: 'Android',
  chromeos: 'ChromeOS', linux: 'Linux', other: 'Other',
};
const DEVICE_NAMES = { pc: 'Desktop', mobile: 'Mobile', tablet: 'Tablet', other: 'Other' };

/**
 * Bucket a User-Agent string.
 * @returns {{device: 'pc'|'mobile'|'tablet'|'other', browser: string, os: string}}
 */
function parseUserAgent(ua) {
  const s = String(ua || '');

  let os = 'other';
  if (/windows nt|windows phone/i.test(s)) os = 'windows';
  else if (/iphone|ipad|ipod/i.test(s)) os = 'ios';
  else if (/android/i.test(s)) os = 'android';
  else if (/cros/i.test(s)) os = 'chromeos';
  else if (/mac os x|macintosh/i.test(s)) os = 'macos';
  else if (/linux|x11/i.test(s)) os = 'linux';

  let browser = 'other';
  if (/edg(e|a|ios)?\//i.test(s)) browser = 'edge';
  else if (/opr\/|opera/i.test(s)) browser = 'opera';
  else if (/samsungbrowser/i.test(s)) browser = 'samsung';
  else if (/firefox|fxios/i.test(s)) browser = 'firefox';
  else if (/chrome\/|crios|chromium/i.test(s)) browser = 'chrome';
  else if (/safari\//i.test(s) && /version\//i.test(s)) browser = 'safari';

  let device = 'other';
  if (/ipad|tablet|playbook|silk|kindle|nexus (7|9|10)|sm-t\d/i.test(s) || (os === 'android' && !/mobile/i.test(s))) device = 'tablet';
  else if (/mobi|iphone|ipod|windows phone|blackberry|opera mini|iemobile/i.test(s)) device = 'mobile';
  else if (os === 'windows' || os === 'macos' || os === 'linux' || os === 'chromeos') device = 'pc';

  return { device, browser, os };
}

// True when a browser tells us the request came from another site's page.
// Our own fetch()/sendBeacon calls are same-origin; a third-party page that
// fires no-cors POSTs at these endpoints is not. Requests without either
// header (non-browser clients) fall through to the bot filter instead.
function isCrossSite(event) {
  const h = (event && event.headers) || {};
  const site = String(h['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin') return true;
  const origin = h.origin;
  if (origin === undefined || origin === '') return false;
  try {
    return new URL(origin).host !== String(h.host || '');
  } catch {
    return true;   // "null" or garbage Origin
  }
}

// ── Turnstile gate pass ──
// verify-turnstile issues it after Cloudflare confirms a token; the public
// write endpoints require it while the gate is switched on. Value is
// "<expiry>.<HMAC>", keyed off TURNSTILE_SECRET_KEY, HttpOnly + SameSite=Strict.
const GATE_COOKIE = 'tsgate';
const GATE_TTL_SEC = 6 * 60 * 60;

function gateKey() {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  return secret ? crypto.createHmac('sha256', secret).update('entry-gate-pass').digest() : null;
}

function gateSignature(key, exp) {
  return crypto.createHmac('sha256', key).update(String(exp)).digest('base64url');
}

/** Set-Cookie value for a fresh pass, or null when Turnstile isn't configured. */
function issueGatePass() {
  const key = gateKey();
  if (!key) return null;
  const exp = Math.floor(Date.now() / 1000) + GATE_TTL_SEC;
  return `${GATE_COOKIE}=${exp}.${gateSignature(key, exp)}; Max-Age=${GATE_TTL_SEC}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

/** True when the request carries a valid, unexpired gate pass. */
function hasGatePass(event) {
  const key = gateKey();
  if (!key) return false;
  const h = (event && event.headers) || {};
  const m = new RegExp(`(?:^|;\\s*)${GATE_COOKIE}=(\\d+)\\.([A-Za-z0-9_-]+)`).exec(String(h.cookie || ''));
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > Date.now() / 1000)) return false;
  const want = Buffer.from(gateSignature(key, exp));
  const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** True when the admin has the entry gate on and this request has no valid pass. */
async function blockedByGate(event, contentStore) {
  if (hasGatePass(event)) return false;
  const features = await contentStore.get('features', { type: 'json' });
  return !!(features && features.turnstileGate === true);
}

exports.isBot = isBot;
exports.isCrossSite = isCrossSite;
exports.blockedByGate = blockedByGate;
exports.issueGatePass = issueGatePass;
exports.hasGatePass = hasGatePass;
exports.userAgent = userAgent;
exports.parseUserAgent = parseUserAgent;
exports.BROWSER_NAMES = BROWSER_NAMES;
exports.OS_NAMES = OS_NAMES;
exports.DEVICE_NAMES = DEVICE_NAMES;

// Not a public endpoint — answer 404 if someone requests it directly.
exports.handler = async () => ({
  statusCode: 404,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ ok: false, error: 'Not found' }),
});
