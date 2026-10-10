// POST /.netlify/functions/update-content
//
// The single write endpoint. Every Save / Publish button in the admin posts
// {type, ...fields, baseRev} here with the X-Admin-Key header. Each type has
// one validated handler that reads the current blob, applies only the fields
// it recognises, and writes the result back. Partial updates are normal (the
// UI Editor and Content Editor both write `theme`, each with its own fields).
//
// Optimistic concurrency: every successful write bumps the `content-rev` blob
// and returns the new revision. When the request carries baseRev and it no
// longer matches, nothing is written and the reply is 409 {currentRev}, so a
// stale tab can't silently overwrite newer changes.
const { getStore } = require('@netlify/blobs');
const { checkAdmin, authFailure } = require('./lib/admin-auth');
const { INTEREST_KEYS, normalizeSections, DEFAULT_TURNSTILE_SITE_KEY } = require('./get-content');
const { writeIfUnchanged } = require('./lib/rate-limit');

const MAX_BODY = 100 * 1024;

const contentStore = () => getStore({
  name: 'site-content',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN,
  consistency: 'strong',
});

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

// ════════════════════════ VALIDATORS ════════════════════════
class ValidationError extends Error {}
const fail = (message) => { throw new ValidationError(message); };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function text(v, label, max, { multiline = false, required = false } = {}) {
  if (v === null || v === undefined) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') fail(`${label} must be text.`);
  let s = String(v).replace(CONTROL_CHARS, '');
  s = multiline ? s.replace(/\r\n?/g, '\n') : s.replace(/[\r\n\t]+/g, ' ');
  s = s.trim();
  if (required && !s) fail(`${label} can't be empty.`);
  if (s.length > max) fail(`${label} is too long (max ${max} characters).`);
  return s;
}

function hex(v, label, { allowEmpty = false } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s && allowEmpty) return '';
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) fail(`${label} must be a #rrggbb colour.`);
  return s;
}

function num(v, label, min, max, { integer = false } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) fail(`${label} must be a number.`);
  if (n < min || n > max) fail(`${label} must be between ${min} and ${max}.`);
  return integer ? Math.round(n) : n;
}

function bool(v, label) {
  if (typeof v !== 'boolean') fail(`${label} must be true or false.`);
  return v;
}

function oneOf(v, label, options) {
  if (!options.includes(v)) fail(`${label} must be one of: ${options.join(', ')}.`);
  return v;
}

// http(s) URL — or, with `relative`, a same-site path like /cover.png.
function url(v, label, { relative = false, max = 500 } = {}) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') fail(`${label} must be a URL.`);
  const s = v.trim();
  if (!s) return '';
  if (s.length > max) fail(`${label} is too long (max ${max} characters).`);
  if (/\s/.test(s)) fail(`${label} can't contain spaces.`);
  if (relative && s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\')) return s;
  let u;
  try { u = new URL(s); } catch { u = null; }
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) {
    fail(`${label} must be a full https:// URL${relative ? ' or a /path on this site' : ''}.`);
  }
  return s;
}

// Font family names end up inside CSS strings — keep them to safe characters.
function fontName(v, label) {
  const s = text(v, label, 60);
  if (s && !/^[A-Za-z0-9 \-_]+$/.test(s)) fail(`${label}: letters, numbers, spaces, - and _ only.`);
  return s;
}

// Apply only the fields present in `body`, each through its validator.
function applySpec(body, spec, current) {
  const next = { ...current };
  let touched = 0;
  for (const [field, validate] of Object.entries(spec)) {
    if (has(body, field)) { next[field] = validate(body[field]); touched++; }
  }
  return { next, touched };
}

function requireTouched(touched, type) {
  if (!touched) fail(`Nothing to save for "${type}".`);
}

// ════════════════════════ FIELD SPECS ════════════════════════
const THEME_SPEC = {
  uiStyle: (v) => oneOf(v, 'UI style mode', ['sakura', 'minimal', 'vibey']),
  effect: (v) => oneOf(v, 'Weather effect', ['sakura', 'snow', 'rain', 'none']),
  viewsLocation: (v) => oneOf(v, 'Views counter placement', ['hud', 'hero']),
  bgColor1: (v) => hex(v, 'Page gradient colour 1'),
  bgColor2: (v) => hex(v, 'Page gradient colour 2'),
  nameColor1: (v) => hex(v, 'Name color 1'),
  nameColor2: (v) => hex(v, 'Name color 2'),
  nameAngle: (v) => num(v, 'Gradient angle', 0, 360),
  nameGlow: (v) => num(v, 'Username glow', 0, 100),
  textColor: (v) => hex(v, 'Body text color', { allowEmpty: true }),
  frostedTint: (v) => hex(v, 'Frosted glass tint', { allowEmpty: true }),
  uiOpacity: (v) => num(v, 'UI opacity', 0.2, 1),
  uiBlur: (v) => num(v, 'UI blur', -1, 40),
  heroBlur: (v) => num(v, 'Hero card blur', -1, 40),
  uiGlow: (v) => num(v, 'UI glow', 0, 40),
  glowColor: (v) => hex(v, 'Glow colour', { allowEmpty: true }),
  siteAccent: (v) => hex(v, 'Site accent'),
  starColor1: (v) => hex(v, 'Star color 1'),
  starColor2: (v) => hex(v, 'Star color 2'),
  favGameColor1: (v) => hex(v, 'Favorite game gradient color 1'),
  favGameColor2: (v) => hex(v, 'Favorite game gradient color 2'),
  favGameGradient: (v) => bool(v, 'Favorite game gradient'),
  favGameAnimate: (v) => bool(v, 'Favorite game animation'),
  bgZoom: (v) => bool(v, 'Slow zoom'),
  bgStars: (v) => bool(v, 'Starfield overlay'),
  bgStarColor: (v) => hex(v, 'Star color'),
  schedStyle: (v) => oneOf(v, 'Schedule style', ['dots', 'tiles']),
  schedOnColor: (v) => hex(v, 'Schedule available color', { allowEmpty: true }),
  schedOffColor: (v) => hex(v, 'Schedule away color', { allowEmpty: true }),
  schedTextColor: (v) => hex(v, 'Schedule label color', { allowEmpty: true }),
  schedFont: (v) => fontName(v, 'Schedule font'),
  schedFontUrl: (v) => url(v, 'Schedule font URL'),
  typeSpeed: (v) => num(v, 'Type speed', 5, 500, { integer: true }),
  deleteSpeed: (v) => num(v, 'Delete speed', 5, 500, { integer: true }),
  holdTime: (v) => num(v, 'Hold delay', 100, 30000, { integer: true }),
};

const SONG_SPEC = {
  title: (v) => text(v, 'Song title', 100),
  artist: (v) => text(v, 'Artist', 100),
  audioUrl: (v) => url(v, 'Audio URL', { relative: true }),
  coverUrl: (v) => url(v, 'Cover URL', { relative: true }),
  audioSource: (v) => oneOf(v, 'Audio source', ['song', 'video']),
  fadeIn: (v) => num(v, 'Fade-in', 0, 10),
  song2Enabled: (v) => bool(v, 'Second song'),
  title2: (v) => text(v, 'Song 2 title', 100),
  artist2: (v) => text(v, 'Song 2 artist', 100),
  audioUrl2: (v) => url(v, 'Song 2 audio URL', { relative: true }),
  coverUrl2: (v) => url(v, 'Song 2 cover URL', { relative: true }),
};

const VIDEO_BG_SPEC = {
  url: (v) => url(v, 'Public site background', { relative: true }),
  heroUrl: (v) => url(v, 'Hero / Overview video', { relative: true }),
  adminUrl: (v) => url(v, 'Main background video', { relative: true }),
};

const FAVORITE_GAME_SPEC = {
  name: (v) => text(v, 'Favorite game', 80),
  coverUrl: (v) => url(v, 'Game cover URL', { relative: true }),
  blurb: (v) => text(v, 'Game blurb', 220),
  url: (v) => url(v, 'Game link'),
};

const DISCORD_BANNER_SPEC = {
  url: (v) => url(v, 'Banner URL', { relative: true }),
  autoSync: (v) => bool(v, 'Auto-sync from Discord'),
  bgMode: (v) => oneOf(v, 'Empty-banner colour', ['discord', 'custom']),
  bgColor: (v) => hex(v, 'Custom banner colour'),
  scale: (v) => num(v, 'Banner zoom', 1, 5),
  offsetX: (v) => num(v, 'Banner offset X', -10, 10),
  offsetY: (v) => num(v, 'Banner offset Y', -10, 10),
  rotation: (v) => num(v, 'Banner rotation', -360, 360),
};

const GUILD_TAG_SPEC = {
  enabled: (v) => bool(v, 'Guild tag'),
  text: (v) => text(v, 'Guild tag text', 8),
  iconUrl: (v) => url(v, 'Guild tag icon', { relative: true }),
};

const ENTER_SCREEN_SPEC = {
  enabled: (v) => bool(v, 'Intro gate'),
  style: (v) => oneOf(v, 'Style', ['classic', 'modern']),
  text: (v) => text(v, 'Enter text', 100, { required: true }),
  gradColor1: (v) => hex(v, 'Gradient color 1'),
  gradColor2: (v) => hex(v, 'Gradient color 2'),
  gradAngle: (v) => num(v, 'Gradient angle', 0, 360),
  textScale: (v) => num(v, 'Enter text size', 50, 250, { integer: true }),   // % of the default size
  font: (v) => fontName(v, 'Enter text font'),
  // A full http(s) URL to the font file (e.g. on R2) — loaded by @font-face.
  fontUrl: (v) => url(v, 'Enter text font URL'),
  loaderAccent: (v) => hex(v, 'Loader accent colour'),
  loaderFont: (v) => fontName(v, '"Welcome" font'),
  // The public loader only loads absolute http(s) URLs for these two.
  loaderFontUrl: (v) => url(v, '"Welcome" font URL'),
  sfxEnabled: (v) => bool(v, 'Ambient sound'),
  sfxVolume: (v) => num(v, 'Ambient volume', 0, 100),
  sfxAmbientUrl: (v) => url(v, 'Loop URL'),
};

const FEATURES_SPEC = {
  showDiscordPresence: (v) => bool(v, 'Discord Presence'),
  showViews: (v) => bool(v, 'Profile Views'),
  turnstileGate: (v) => bool(v, 'Cloudflare Turnstile Gate'),
  faviconUrl: (v) => url(v, 'Favicon URL', { relative: true }),
  // Font for all public-site text except the display handle.
  siteFont: (v) => fontName(v, 'Site font'),
  siteFontUrl: (v) => url(v, 'Site font URL'),
  siteFontHandle: (v) => bool(v, 'Site font on the display handle'),
  // Cloudflare Turnstile SITE key (public — it's in the page anyway).
  turnstileSiteKey: (v) => {
    const s = text(v, 'Turnstile site key', 100);
    if (s && !/^[0-9A-Za-z_-]{10,100}$/.test(s)) fail('That doesn\'t look like a Turnstile site key (it starts with 0x…).');
    return s;
  },
};

const ADMIN_THEME_SPEC = {
  accent: (v) => hex(v, 'Accent color'),
  accent2: (v) => hex(v, 'Accent color 2'),
  bg: (v) => hex(v, 'Background color', { allowEmpty: true }),
  uiBlur: (v) => num(v, 'UI blur', 0, 60, { integer: true }),
  heroFont: (v) => fontName(v, 'Hero title font'),
  heroFontUrl: (v) => url(v, 'Hero title font URL', { relative: true }),
  subFont: (v) => fontName(v, 'Hero subtitle font'),
  subFontUrl: (v) => url(v, 'Hero subtitle font URL', { relative: true }),
  greetings: (v) => greetingList(v),
  greetingSubtitle: (v) => text(v, 'Greeting subtitle', 100),
};

// Admin Home welcome messages (Settings → Home Greetings): 1–30 short lines.
function greetingList(v) {
  if (!Array.isArray(v)) fail('Welcome messages must be a list.');
  if (v.length > 30) fail('Too many welcome messages (max 30).');
  const out = v.map((g, i) => text(g, `Welcome message ${i + 1}`, 80)).filter(Boolean);
  if (!out.length) fail('Add at least one welcome message.');
  return out;
}

// ════════════════════════ HANDLERS ════════════════════════
// type → { blob, build(body, current) → next value to store }
const HANDLERS = {
  about: {
    blob: 'about',
    build: (body) => ({ text: text(body.text, 'About me', 1500, { multiline: true }) }),
  },
  'admin-theme': {
    blob: 'admin-theme',
    build: (body, cur) => { const r = applySpec(body, ADMIN_THEME_SPEC, cur); requireTouched(r.touched, 'admin-theme'); return r.next; },
  },
  bio: {
    blob: 'bio',
    build: (body) => {
      if (!Array.isArray(body.lines)) fail('Bio lines must be a list.');
      const lines = body.lines.map((l, i) => text(l, `Bio line ${i + 1}`, 200)).filter(Boolean);
      if (!lines.length) fail('Add at least one bio line.');
      if (lines.length > 10) fail('At most 10 bio lines.');
      return { lines };
    },
  },
  'custom-badges': {
    blob: 'custom-badges',
    build: (body) => {
      if (!Array.isArray(body.badges)) fail('Badges must be a list.');
      if (body.badges.length > 10) fail('At most 10 badges.');
      const badges = body.badges.map((b, i) => {
        if (!isObj(b)) fail(`Badge ${i + 1} is invalid.`);
        return { name: text(b.name, `Badge ${i + 1} title`, 50), imageUrl: url(b.imageUrl, `Badge ${i + 1} image URL`, { relative: true }) };
      }).filter((b) => b.imageUrl);
      return { badges };
    },
  },
  'discord-banner': {
    blob: 'discord-banner',
    build: (body, cur) => {
      const r = applySpec(body, DISCORD_BANNER_SPEC, cur);
      requireTouched(r.touched, 'discord-banner');
      // New framing replaces the legacy object-position fields.
      if (has(body, 'offsetX') || has(body, 'offsetY')) { delete r.next.posX; delete r.next.posY; }
      return r.next;
    },
  },
  'enter-screen': {
    blob: 'enter-screen',
    build: (body, cur) => { const r = applySpec(body, ENTER_SCREEN_SPEC, cur); requireTouched(r.touched, 'enter-screen'); return r.next; },
  },
  // "Games I like": up to six cover tiles, three per row on the public site.
  games: {
    blob: 'games',
    build: (body) => {
      if (!Array.isArray(body.games)) fail('Games must be a list.');
      if (body.games.length > 6) fail('At most 6 games.');
      const games = body.games.map((gm, i) => {
        if (!isObj(gm)) fail(`Game ${i + 1} is invalid.`);
        return {
          title: text(gm.title, `Game ${i + 1} title`, 80, { required: true }),
          imageUrl: url(gm.imageUrl, `Game ${i + 1} image URL`, { relative: true }) || fail(`Game ${i + 1} needs an image URL.`),
          url: url(gm.url, `Game ${i + 1} link`),
        };
      });
      return { games };
    },
  },
  'favorite-game': {
    blob: 'favorite-game',
    build: (body, cur) => { const r = applySpec(body, FAVORITE_GAME_SPEC, cur); requireTouched(r.touched, 'favorite-game'); return r.next; },
  },
  features: {
    blob: 'features',
    build: (body, cur) => {
      const r = applySpec(body, FEATURES_SPEC, cur);
      requireTouched(r.touched, 'features');
      if (r.next.turnstileGate === true && !(r.next.turnstileSiteKey || DEFAULT_TURNSTILE_SITE_KEY)) fail('Add the Turnstile site key before turning the gate on.');
      return r.next;
    },
  },
  'guild-tag': {
    blob: 'guild-tag',
    build: (body, cur) => { const r = applySpec(body, GUILD_TAG_SPEC, cur); requireTouched(r.touched, 'guild-tag'); return r.next; },
  },
  handle: {
    blob: 'handle',
    // Blank is allowed: the public site then shows the Discord display name.
    build: (body) => ({ name: text(body.name, 'Display handle', 50) }),
  },
  // Single interest (e.g. from a Discord bot command): {name: 'cats', text}.
  interest: {
    blob: 'interests',
    build: (body, cur) => {
      const key = oneOf(body.name !== undefined ? body.name : body.key, 'Interest', INTEREST_KEYS);
      return { ...cur, [key]: text(body.text, 'Interest text', 600, { multiline: true }) };
    },
  },
  'interest-meta': {
    blob: 'interest-meta',
    build: (body, cur) => {
      if (!isObj(body.meta)) fail('Interest titles must be an object.');
      const next = { ...cur };
      let touched = 0;
      for (const k of INTEREST_KEYS) {
        if (!has(body.meta, k)) continue;
        const m = body.meta[k];
        if (!isObj(m)) fail(`Interest "${k}" is invalid.`);
        next[k] = { name: text(m.name, `Interest "${k}" name`, 40), kanji: text(m.kanji, `Interest "${k}" kanji`, 12) };
        touched++;
      }
      requireTouched(touched, 'interest-meta');
      return next;
    },
  },
  'interests-bulk': {
    blob: 'interests',
    build: (body, cur) => {
      if (!isObj(body.interests)) fail('Interests must be an object.');
      const next = { ...cur };
      let touched = 0;
      for (const k of INTEREST_KEYS) {
        if (!has(body.interests, k)) continue;
        next[k] = text(body.interests[k], `Interest "${k}"`, 600, { multiline: true });
        touched++;
      }
      requireTouched(touched, 'interests-bulk');
      return next;
    },
  },
  sections: {
    blob: 'sections',
    build: (body) => {
      if (!Array.isArray(body.sections)) fail('Sections must be a list.');
      return { sections: normalizeSections(body.sections) };
    },
  },
  socials: {
    blob: 'socials',
    build: (body) => {
      if (!Array.isArray(body.socials)) fail('Social links must be a list.');
      if (body.socials.length > 5) fail('At most 5 social links.');
      const socials = body.socials.map((s, i) => {
        if (!isObj(s)) fail(`Social link ${i + 1} is invalid.`);
        return {
          name: text(s.name, `Social link ${i + 1} name`, 60, { required: true }),
          description: text(s.description, `Social link ${i + 1} description`, 120),
          iconUrl: url(s.iconUrl, `Social link ${i + 1} icon URL`, { relative: true }),
          linkUrl: url(s.linkUrl, `Social link ${i + 1} profile URL`) || fail(`Social link ${i + 1} needs a profile URL.`),
          showIcon: s.showIcon !== false,   // the image on the card's side
        };
      });
      return { socials };
    },
  },
  // This week's availability: seven on/off days from Sunday, the Sunday they
  // start on, and an optional short note.
  schedule: {
    blob: 'schedule',
    build: (body) => {
      if (!Array.isArray(body.days) || body.days.length !== 7) fail('Schedule needs all seven days.');
      const days = body.days.map((d, i) => bool(d, `Schedule day ${i + 1}`));
      const m = typeof body.weekOf === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(body.weekOf);
      const start = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
      if (!start || start.toISOString().slice(0, 10) !== body.weekOf || start.getUTCDay() !== 0) {
        fail('Schedule week must be a Sunday date (YYYY-MM-DD).');
      }
      return { days, weekOf: body.weekOf, note: text(body.note, 'Schedule note', 140) };
    },
  },
  song: {
    blob: 'song',
    build: (body, cur) => { const r = applySpec(body, SONG_SPEC, cur); requireTouched(r.touched, 'song'); return r.next; },
  },
  theme: {
    blob: 'theme',
    build: (body, cur) => { const r = applySpec(body, THEME_SPEC, cur); requireTouched(r.touched, 'theme'); return r.next; },
  },
  'video-bg': {
    blob: 'video-bg',
    build: (body, cur) => { const r = applySpec(body, VIDEO_BG_SPEC, cur); requireTouched(r.touched, 'video-bg'); return r.next; },
  },
  youtube: {
    blob: 'youtube',
    build: (body) => {
      const u = url(body.url, 'YouTube URL');
      if (u && !/^https?:\/\/([a-z0-9-]+\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(u)) fail('YouTube URL must be a youtube.com or youtu.be link.');
      return { url: u };
    },
  },
};

// ════════════════════════ CONTENT REVISION ════════════════════════
async function readRev(store) {
  const cur = await store.getWithMetadata('content-rev', { type: 'json' });
  return { rev: Number(cur && cur.data && cur.data.rev) || 0, cur };
}

// Atomically move content-rev forward by one. With `expected`, refuse (conflict)
// unless the stored revision still equals it — the optimistic-concurrency check.
async function claimRev(store, expected) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { rev, cur } = await readRev(store);
    if (typeof expected === 'number' && expected !== rev) return { conflict: true, rev };
    const res = await writeIfUnchanged(store, 'content-rev', cur, { rev: rev + 1 });
    if (res.modified) return { conflict: false, rev: rev + 1 };
    // Another write landed in between — for a baseRev'd save that IS a conflict.
    if (typeof expected === 'number') return { conflict: true, rev: (await readRev(store)).rev };
  }
  throw new Error('Could not update the content revision (too much contention).');
}

function parseBody(event) {
  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (raw.length > MAX_BODY) return { tooLarge: true };
  try {
    const v = JSON.parse(raw || '{}');
    return isObj(v) ? { body: v } : {};
  } catch {
    return {};
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' }, { Allow: 'POST' });

  const auth = await checkAdmin(event);
  if (!auth.ok) return authFailure(auth);

  const parsed = parseBody(event);
  if (parsed.tooLarge) return json(413, { ok: false, error: 'Request too large.' });
  const body = parsed.body;
  if (!body) return json(400, { ok: false, error: 'Body must be a JSON object.' });

  const handler = typeof body.type === 'string' && Object.prototype.hasOwnProperty.call(HANDLERS, body.type)
    ? HANDLERS[body.type] : null;
  if (!handler) return json(400, { ok: false, error: `Unknown content type: ${String(body.type)}` });
  if (body.baseRev !== undefined && body.baseRev !== null && typeof body.baseRev !== 'number') {
    return json(400, { ok: false, error: 'baseRev must be a number.' });
  }

  let store;
  try {
    store = contentStore();
  } catch (err) {
    console.error('[update-content] blobs not configured —', err && err.message);
    return json(500, { ok: false, error: 'Content store not configured — set NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN.' });
  }

  try {
    const stored = await store.get(handler.blob, { type: 'json' });
    const current = isObj(stored) ? stored : {};

    let next;
    try {
      next = handler.build(body, current);
    } catch (err) {
      if (err instanceof ValidationError) return json(400, { ok: false, error: err.message });
      throw err;
    }

    const expected = typeof body.baseRev === 'number' ? body.baseRev : undefined;

    // No-op save (e.g. the login probe re-saving the same handle): don't write
    // or bump the revision — but still report a stale baseRev as a conflict.
    if (JSON.stringify(next) === JSON.stringify(current)) {
      const { rev } = await readRev(store);
      if (expected !== undefined && expected !== rev) return json(409, { ok: false, error: 'Content changed in another session.', currentRev: rev });
      return json(200, { ok: true, contentRev: rev, unchanged: true });
    }

    const claim = await claimRev(store, expected);
    if (claim.conflict) return json(409, { ok: false, error: 'Content changed in another session.', currentRev: claim.rev });

    await store.setJSON(handler.blob, next);
    return json(200, { ok: true, contentRev: claim.rev });
  } catch (err) {
    console.error(`[update-content] ${body.type} failed —`, err && err.message);
    return json(500, { ok: false, error: 'Saving failed — try again.' });
  }
};

// Shared with presets.js so preset snapshots go through the exact same validation.
exports.SPECS = { theme: THEME_SPEC, 'video-bg': VIDEO_BG_SPEC, song: SONG_SPEC, 'enter-screen': ENTER_SCREEN_SPEC };
exports.applySpec = applySpec;
exports.ValidationError = ValidationError;
exports.claimRev = claimRev;
exports.text = text;
