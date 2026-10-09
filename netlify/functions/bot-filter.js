// Bot / crawler detection + light User-Agent classification.
//
// Imported by increment-view, log-event and notify-visit so headless
// browsers, scrapers and link-preview fetchers don't inflate the view counter,
// pollute analytics, or ping Discord. parseUserAgent() supplies the
// device / browser / OS buckets that analytics and the visit ping report.
//
// This file sits in netlify/functions/, so Netlify also deploys it as an
// endpoint; the handler at the bottom just answers 404 so that endpoint is inert.

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

exports.isBot = isBot;
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
