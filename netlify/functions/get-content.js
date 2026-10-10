// GET /.netlify/functions/get-content
//
// The single read endpoint. Both index.html and admin.html call it on load.
// Every content type has a DEFAULT_* object below; stored blobs are merged
// OVER the defaults, so a fresh site renders sensibly before anything is saved
// and a newly added field shows its default until edited.
//
// Caching: public responses are briefly CDN-cached. Any request carrying an
// X-Admin-Key header is never cached (cacheable = !hasAdminKey) — and only a
// VERIFIED key unlocks the admin-only fields (presets, adminTheme, and the
// admin panel's own background/hero video URLs). The CDN
// cache key also varies on that header, so a cached public copy can never be
// served to the admin, and an admin copy is never stored at all.
const { getStore } = require('@netlify/blobs');
const { checkAdmin, hasAdminKey, authFailure } = require('./lib/admin-auth');

const contentStore = () => getStore({
  name: 'site-content',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN,
  consistency: 'strong',
});

// ════════════════════════ DEFAULTS ════════════════════════
const DEFAULT_BIO = [
  '✦ Write your first bio sentence here. ✦',
  '✦ Second sentence — something about you. ✦',
  '✦ Third — a fun fact or favourite thing. ✦',
];

const INTEREST_KEYS = ['space', 'dragons', 'cats', 'music'];

// The four interest slots keep their original storage keys (space, dragons,
// cats, music) so saved content stays put; what visitors see is the name,
// kanji and text below, all editable in Admin → Content Editor → Interests.
const DEFAULT_INTERESTS = {
  space: 'Write about your first interest here.',
  dragons: 'Write about your second interest here.',
  cats: 'Write about your third interest here.',
  music: 'Write about your fourth interest here.',
};

const DEFAULT_INTEREST_META = {
  space: { name: 'First interest', kanji: '一' },
  dragons: { name: 'Second interest', kanji: '二' },
  cats: { name: 'Third interest', kanji: '三' },
  music: { name: 'Fourth interest', kanji: '四' },
};

const DEFAULT_SONG = {
  title: '',                  // set in Admin → Content Editor → Audio
  artist: '',
  audioUrl: '',
  coverUrl: '/cover.png',
  audioSource: 'song',        // 'song' = soundbar track | 'video' = background video's own audio
  fadeIn: 2,                  // seconds, 0 = off
  song2Enabled: false,
  title2: '',
  artist2: '',
  audioUrl2: '',
  coverUrl2: '',
};

const DEFAULT_YOUTUBE = { url: '' };
const DEFAULT_HANDLE = { name: '' };   // blank = the site shows the Discord display name
const DEFAULT_ABOUT = { text: 'A short paragraph about you. Editable from the admin panel.' };

const DEFAULT_THEME = {
  uiStyle: 'sakura',          // 'sakura' | 'minimal' (frosted) | 'vibey'
  effect: 'sakura',           // 'sakura' | 'snow' | 'rain' | 'none'
  viewsLocation: 'hud',       // 'hud' (bottom-right) | 'hero'
  bgColor1: '#3d0a14',
  bgColor2: '#0a0204',
  nameColor1: '#e05555',
  nameColor2: '#d4a84b',
  nameAngle: 135,
  nameGlow: 55,
  textColor: '',              // '' = built-in default
  frostedTint: '',
  uiOpacity: 1,
  uiBlur: -1,                 // -1 = auto
  heroBlur: -1,
  uiGlow: 0,
  glowColor: '',              // '' = follow siteAccent
  siteAccent: '#e7a6e0',      // accents, borders & the glass cards (UI Editor → Color & glow)
  starColor1: '#d4a84b',
  starColor2: '#c0392b',
  favGameColor1: '#f0c96a',
  favGameColor2: '#c0392b',
  favGameGradient: true,
  favGameAnimate: true,
  bgZoom: false,
  bgStars: false,
  bgStarColor: '#b98cff',
  // Schedule section (UI Editor → Schedule). '' = follow the site's theme.
  schedStyle: 'dots',         // 'dots' | 'tiles'
  schedOnColor: '',           // available days ('' = site accent)
  schedOffColor: '',          // away days
  schedTextColor: '',         // day names and dates
  schedFont: '',              // '' = site font
  schedFontUrl: '',
  typeSpeed: 55,
  deleteSpeed: 30,
  holdTime: 4500,
};

const DEFAULT_CUSTOM_BADGES = [];
const DEFAULT_VIDEO_BG = { url: '', heroUrl: '', adminUrl: '' };

const DEFAULT_DISCORD_BANNER = {
  url: '',
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  autoSync: true,             // mirror the live Discord banner (discord-banner-live)
  bgMode: 'discord',          // empty-banner gradient: 'discord' accent | 'custom'
  bgColor: '#5865F2',
};

const DEFAULT_FAVORITE_GAME = { name: '', coverUrl: '', blurb: '', url: '' };

// This week's availability (Admin → Schedule): days[0] is Sunday, weekOf is
// that Sunday's date. The section stays hidden until a week is published.
const DEFAULT_SCHEDULE = { days: [false, false, false, false, false, false, false], weekOf: '', note: '' };

const SECTION_IDS = ['discord', 'schedule', 'about', 'interests', 'favgame', 'games', 'watch', 'socials'];
const DEFAULT_SECTIONS = SECTION_IDS.map((id) => ({ id, enabled: true }));

// Cloudflare Turnstile SITE key (public). Also hard-coded in index.html; a key
// saved in Admin → Settings → Danger Zone overrides both.
const DEFAULT_TURNSTILE_SITE_KEY = '0x4AAAAAAFSspg-J6OhDu1IA';
const DEFAULT_FEATURES = { showDiscordPresence: true, showViews: true, turnstileGate: false, faviconUrl: '', siteFont: '', siteFontUrl: '', siteFontHandle: true, turnstileSiteKey: DEFAULT_TURNSTILE_SITE_KEY };
const DEFAULT_SOCIALS = [];

const DEFAULT_ENTER_SCREEN = {
  enabled: true,
  style: 'classic',           // 'classic' gradient click-to-enter | 'modern' cinematic loader
  text: 'click to enter',
  gradColor1: '#3c0a1e',
  gradColor2: '#000000',
  gradAngle: 135,
  textScale: 100,             // classic enter text size, % of the default
  font: '',                   // classic enter text font: a Google Fonts family name…
  fontUrl: '',                // …or a self-hosted file (e.g. on R2)
  loaderAccent: '#a97bff',
  loaderFont: '',
  loaderFontUrl: '',
  sfxEnabled: false,
  sfxVolume: 60,
  sfxAmbientUrl: '',
};

const DEFAULT_GUILD_TAG = { enabled: false, text: '', iconUrl: '' };

const DEFAULT_ADMIN_THEME = {
  accent: '#e64a52',
  accent2: '#f3c969',
  bg: '',
  uiBlur: 24,
  heroFont: 'Instrument Serif',
  heroFontUrl: '',
  subFont: 'Geist',
  subFontUrl: '',
  greetings: ['first message'],      // admin Home: one picked at random per visit
  greetingSubtitle: '☆ subtitle ☆',
};

// ════════════════════════ HELPERS ════════════════════════
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const obj = (v) => (isObj(v) ? v : {});

// Known ids only, de-duplicated, in saved order. A section missing from the
// saved list (one added after the order was saved) goes in enabled, right
// after the section it follows by default, so it never vanishes.
function normalizeSections(list) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    if (!isObj(s) || !SECTION_IDS.includes(s.id) || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ id: s.id, enabled: s.enabled !== false });
  }
  SECTION_IDS.forEach((id, i) => {
    if (seen.has(id)) return;
    const prev = i > 0 ? out.findIndex((s) => s.id === SECTION_IDS[i - 1]) : -1;
    out.splice(prev + 1, 0, { id, enabled: true });
    seen.add(id);
  });
  return out;
}

function normalizeSchedule(v) {
  const s = obj(v);
  return {
    days: Array.isArray(s.days) && s.days.length === 7 ? s.days.map((d) => d === true) : DEFAULT_SCHEDULE.days,
    weekOf: typeof s.weekOf === 'string' ? s.weekOf : '',
    note: typeof s.note === 'string' ? s.note : '',
  };
}

const discordUserId = () => {
  const id = String(process.env.DISCORD_USER_ID || '').trim();
  return /^\d{15,25}$/.test(id) ? id : '';
};

const json = (statusCode, body, headers) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
  },
  body: JSON.stringify(body),
});

// Blobs read on every request, and the extra ones only an admin gets.
const PUBLIC_BLOBS = [
  'bio', 'interests', 'interest-meta', 'song', 'youtube', 'handle', 'about', 'theme',
  'custom-badges', 'video-bg', 'discord-banner', 'favorite-game', 'sections', 'features',
  'socials', 'games', 'schedule', 'enter-screen', 'guild-tag', 'views', 'content-rev',
];
const ADMIN_BLOBS = ['presets', 'admin-theme'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' }, { Allow: 'GET' });

  // Any admin-key header makes the response uncacheable; only a verified key
  // adds the admin-only fields. A wrong key is an error, not a public reply.
  const adminHeader = hasAdminKey(event);
  let isAdmin = false;
  if (adminHeader) {
    const auth = await checkAdmin(event);
    if (!auth.ok) return authFailure(auth);
    isAdmin = true;
  }
  const cacheable = !adminHeader;

  let store;
  try {
    store = contentStore();
  } catch (err) {
    console.error('[get-content] blobs not configured —', err && err.message);
    return json(500, { ok: false, error: 'Content store not configured — set NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN.', discordUserId: discordUserId() });
  }

  const keys = isAdmin ? PUBLIC_BLOBS.concat(ADMIN_BLOBS) : PUBLIC_BLOBS;
  let failures = 0;
  const values = await Promise.all(keys.map((k) => store.get(k, { type: 'json' }).catch((err) => {
    failures++;
    console.error(`[get-content] read "${k}" failed —`, err && err.message);
    return null;
  })));
  if (failures === keys.length) return json(503, { ok: false, error: 'Content store unavailable — try again shortly.', discordUserId: discordUserId() });
  // The admin edits whole sections; loading defaults in place of an unreadable
  // blob would let the next Save overwrite real content — so fail loudly.
  if (failures && isAdmin) return json(503, { ok: false, error: 'Some content could not be loaded — try again shortly.' });
  const b = {};
  keys.forEach((k, i) => { b[k] = values[i]; });

  const storedMeta = obj(b['interest-meta']);
  const interestMeta = {};
  for (const k of INTEREST_KEYS) interestMeta[k] = { ...DEFAULT_INTEREST_META[k], ...obj(storedMeta[k]) };

  const bioStored = obj(b.bio).lines;
  const views = obj(b.views);
  const count = Number.isFinite(views.count) ? views.count : 0;

  const data = {
    contentRev: Number(obj(b['content-rev']).rev) || 0,
    bioLines: Array.isArray(bioStored) && bioStored.length ? bioStored : DEFAULT_BIO,
    interests: { ...DEFAULT_INTERESTS, ...obj(b.interests) },
    interestMeta,
    song: { ...DEFAULT_SONG, ...obj(b.song) },
    youtube: { ...DEFAULT_YOUTUBE, ...obj(b.youtube) },
    handle: { ...DEFAULT_HANDLE, ...obj(b.handle) },
    about: { ...DEFAULT_ABOUT, ...obj(b.about) },
    theme: { ...DEFAULT_THEME, ...obj(b.theme) },
    customBadges: Array.isArray(obj(b['custom-badges']).badges) ? obj(b['custom-badges']).badges : DEFAULT_CUSTOM_BADGES,
    videoBg: { url: typeof obj(b['video-bg']).url === 'string' ? obj(b['video-bg']).url : DEFAULT_VIDEO_BG.url },
    discordBanner: { ...DEFAULT_DISCORD_BANNER, ...obj(b['discord-banner']) },
    favoriteGame: { ...DEFAULT_FAVORITE_GAME, ...obj(b['favorite-game']) },
    sections: normalizeSections(obj(b.sections).sections || DEFAULT_SECTIONS),
    features: { ...DEFAULT_FEATURES, ...obj(b.features), turnstileSiteKey: obj(b.features).turnstileSiteKey || DEFAULT_TURNSTILE_SITE_KEY },
    socials: Array.isArray(obj(b.socials).socials) ? obj(b.socials).socials : DEFAULT_SOCIALS,
    // "Games I like" grid: up to six {title, imageUrl, url} (Content Editor → G).
    games: Array.isArray(obj(b.games).games) ? obj(b.games).games : [],
    schedule: normalizeSchedule(b.schedule),
    enterScreen: { ...DEFAULT_ENTER_SCREEN, ...obj(b['enter-screen']) },
    guildTag: { ...DEFAULT_GUILD_TAG, ...obj(b['guild-tag']) },
    // Whose Discord profile both pages show (via Lanyard). Not a secret — it's
    // in every Lanyard request anyway — and keeping it in the env var means
    // neither HTML file hard-codes it.
    discordUserId: discordUserId(),
    count,
    views: count,
    viewsResetCount: Number(views.resetCount) || 0,
  };

  if (isAdmin) {
    data.videoBg = { ...DEFAULT_VIDEO_BG, ...obj(b['video-bg']) };   // + the admin-panel-only video URLs
    data.presets = Array.isArray(obj(b.presets).presets) ? obj(b.presets).presets : [];
    data.adminTheme = { ...DEFAULT_ADMIN_THEME, ...obj(b['admin-theme']) };
  }

  // A response built with any fallback (some blob unreadable) is never cached.
  const headers = cacheable && !failures
    ? {
        // Browsers always revalidate; Netlify's CDN serves it for a few seconds.
        // `durable` shares one cached copy across every edge node, so however
        // many visitors arrive, the blobs are read at most every ~5 s.
        // Netlify-Vary keys the CDN cache on the admin-key header.
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=5, stale-while-revalidate=10',
        'Netlify-Vary': 'header=x-admin-key',
      }
    : {
        'Cache-Control': 'private, no-store',
        'Netlify-CDN-Cache-Control': 'no-store',
      };
  return json(200, data, headers);
};

exports.DEFAULTS = {
  DEFAULT_BIO, DEFAULT_INTERESTS, DEFAULT_INTEREST_META, DEFAULT_SONG, DEFAULT_YOUTUBE,
  DEFAULT_HANDLE, DEFAULT_ABOUT, DEFAULT_THEME, DEFAULT_CUSTOM_BADGES, DEFAULT_VIDEO_BG,
  DEFAULT_DISCORD_BANNER, DEFAULT_FAVORITE_GAME, DEFAULT_SECTIONS, DEFAULT_FEATURES,
  DEFAULT_SOCIALS, DEFAULT_ENTER_SCREEN, DEFAULT_GUILD_TAG, DEFAULT_ADMIN_THEME, DEFAULT_SCHEDULE,
};
exports.SECTION_IDS = SECTION_IDS;
exports.DEFAULT_TURNSTILE_SITE_KEY = DEFAULT_TURNSTILE_SITE_KEY;
exports.INTEREST_KEYS = INTEREST_KEYS;
exports.normalizeSections = normalizeSections;
