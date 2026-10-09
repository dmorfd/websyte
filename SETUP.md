# Setup checklist for the trimmed copy

This copy keeps: the enter/loading screen (classic gradient and the cinematic
loader), hero card with live Discord status and typewriter bio, audio player,
Discord presence and interests, About, Favorite Game, Watch (YouTube), Socials.
Admin keeps: Home, Analytics, Content Editor, UI Editor, Presets, Discord
Badges and Enter Screen (sidebar and topbar numbered 01–07).

Removed: Current Job, Showcase, Leave a Message (with the guestbook wall and
the admin messages bell), Dream Journal, Solar System (with the passcode gate),
Maintenance, and the hamburger menu. Its one remaining link is now in the
footer.

> **Status:** `index.html` and `admin.html` are done and tested. The backend
> files (`netlify.toml`, `package.json`, `.gitignore`, `netlify/functions/**`)
> are still to come, so section 4 lists the edits waiting on them.

> This file sits in the site root. If Netlify publishes the root folder, it
> will be publicly reachable at `/SETUP.md`. It contains no secrets, but you can
> delete it once setup is finished.

---

## 1. Environment variables (Netlify → Site configuration → Environment variables)

| Variable | Used by |
|---|---|
| `ADMIN_KEY` | `lib/admin-auth.js`, `get-content.js` |
| `DISCORD_BOT_TOKEN` | `discord-banner-live.js`, `get-guild-preview.js` |
| `DISCORD_USER_ID` | `discord-banner-live.js` (live banner sync) |
| `DISCORD_WEBHOOK_URL` | `notify-visit.js` (visit pings) |
| `TURNSTILE_SECRET_KEY` | `verify-turnstile.js` |
| `NETLIFY_SITE_ID` | every function that touches Blobs |
| `NETLIFY_BLOBS_TOKEN` | every function that touches Blobs |

**Do not set:** `MAINTENANCE_KEY`, `SOLAR_SYSTEM_PASSCODE`, `SOLAR_WEBHOOK_URL`,
`DREAMS_CHANNEL_ID`.

`notify-visit.js` currently reads
`process.env.SOLAR_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL`. This gets
simplified to `DISCORD_WEBHOOK_URL` alone (section 4).

---

## 2. Personal values to replace (placeholders, not invented values)

### index.html
| Line | Placeholder | Put here |
|---|---|---|
| 6 | `YOUR_NAME` | page title (also overwritten at runtime by the admin's display handle) |
| 14 | `https://pub-YOUR_R2_BUCKET_ID.r2.dev` | friend's R2 public URL (preconnect) |
| 1591 | `YOUR_DISCORD_USER_ID`, `YOUR_AVATAR_HASH` | first-paint avatar (your ID **and** your avatar hash are gone). Lanyard replaces it within seconds, so a 404 here is harmless |
| 1593 | `YOUR_INITIALS` | avatar fallback monogram |
| 1597 | `YOUR_NAME` | hero name before content loads |
| 1627–1628 | `YOUR_SONG_TITLE` | default song title before content loads |
| 1725 | `YOUR_DISCORD_USER_ID` | "Add on Discord →" link |
| 1826 | `YOUR_LOCATION` | bottom-right HUD location |
| 1861 | `YOUR_DOMAIN` | footer site link (replaces the old hamburger menu's only entry) |
| 1862 | `YOUR_DISCORD_USER_ID`, `@YOUR_DISCORD_USERNAME` | footer "site made by" credit. Delete the line if you'd rather not credit anyone |
| 1870 | `https://pub-YOUR_R2_BUCKET_ID.r2.dev/YOUR_SONG.mp3` | default song URL |
| 3920 | `YOUR_TURNSTILE_SITE_KEY` | Turnstile **site** key (step 5) |
| 4373 | `YOUR_DISCORD_USER_ID` | Lanyard presence user ID |
| 4785 | `YOUR_SPOTIFY_USER_ID` | Spotify profile fallback link (used when a track has no id) |

### admin.html
| Line | Placeholder | Put here |
|---|---|---|
| 6 | `YOUR_DOMAIN` | tab title |
| 740 | `YOUR_NAME` | fallback handle used by the login key-check save |
| 780, 812 | `YOUR_INITIALS` | login and sidebar monogram (shown only if the avatar and favicon both fail) |
| 784 | `YOUR_DOMAIN` | login subtitle |
| 829 | `YOUR_DOMAIN` | sidebar footer |
| 840 | `YOUR_DISCORD_USER_ID` | admin avatar via Lanyard |
| 1093, 1094 | `YOUR_NAME` | home greetings |
| 1104 | `YOUR_NICKNAME` | home greeting |
| 1510 | `YOUR_NAME` | display-handle input hint |
| 1953 | `YOUR_NAME` | UI Editor name-gradient preview text |
| 3183 | `YOUR_DOMAIN` | Settings help text |

All five Discord-ID spots are placeholders: index.html 1591 / 1725 / 1862 /
4373 and admin.html 840.

**Your call:** the other home greetings (admin.html lines 1092–1111:
"Pharloom…", "The Radiance…", "anime girls…", "Lucid Dreaming~…") and
`INTRO_SUBTITLE` (line 1112) are your personal flavour text. I left them
unchanged.

### Asset files
- `favicon.png`: your branding. Replace it with the friend's.
- `cover.png`: **keep the filename, replace the artwork.** It's the default song
  cover (`coverUrl: '/cover.png'` in `get-content.js`) and the soundbar's `<img>`
  in `index.html`.
- `discord-icon.png`, `spotify-icon.png`, `steam-icon.png`: keep. You paste them
  as icon URLs for social links in the Content Editor (e.g. `/discord-icon.png`).
- `loader-sfx.mp3`: keep. Enter Screen → Cinematic → Ambient sound → Loop URL
  `/loader-sfx.mp3`.

### Still to swap in the backend files (section 4)
- `"arandomperson.dev"` / your name in the User-Agent strings of the functions
- `package.json` `"name"` (currently `"arandomperson-website"`)

---

## 3. Site accent (now editable from the admin)

The main site's transparent glass look comes from one accent colour. It drives
`--glass`, `--glass-border` and the accent variables via `applySharedAccent`.
It used to be the Dream Journal's colour. It's now `theme.siteAccent`, edited in
**Admin → UI Editor → Color & glow → Site accent** (default `#e7a6e0`, the same
as the old `DEFAULT_DREAM.color`). "Glow colour (blank = accent)" falls back to
it, exactly as before. It's saved with the rest of the theme, so presets
snapshot it too.

Verified in Chromium, desktop and mobile: with `#e7a6e0`, or with the field
missing, every kept card has the same computed background, border, radius,
shadow, blur and transitions as your original site. A different colour (tested
with `#55aaff`) recolours it.

---

## 4. Backend changes still to make (waiting on the files)

| File | Change |
|---|---|
| `get-content.js` | Add `siteAccent: '#e7a6e0'` to `DEFAULT_THEME` (next to `glowColor`). Drop `job`, `showcase`, `message` from `DEFAULT_SECTIONS`. Delete the showcase, current-job, dream and dream-settings, maintenance and solar `DEFAULT_*` objects. Remove their blob reads from the big `Promise.all` (`showcase`, `current-job`, `messages`, `messages-seen`, `dreams`, `dreams-deleted`, `dream-settings`, `maintenance`, `solar-system`, plus the vestigial `loader`). Remove their response keys. **Caching:** set `cacheable = !hasAdminKey`. Delete `includeSolar`, `hasValidToken`, the `solarSystem` spread and `solarGateAudio` (lines ~358–367, 446–447, 465–466). |
| `update-content.js` | Validate `siteAccent` as hex in the `theme` handler, like the other colour fields. Delete the `current-job`, `showcase`, `dream` and `solar-system` handlers (and any `maintenance` handler). Drop `job`/`showcase`/`message` from any `sections` allow-list. |
| `notify-visit.js` | line 76 → `const webhook = process.env.DISCORD_WEBHOOK_URL;` |
| `presets.js`, `reset-views.js`, `log-event.js`, `get-analytics.js`, `increment-view.js`, `bot-filter.js`, `lib/*` | Remove any reads or writes of the dead blobs. Replace User-Agent strings. |
| `netlify.toml` | Only `[build]` and `[functions]` remain. Remove all four `[[edge_functions]]` blocks and both scheduled `[functions."…"]` blocks. |
| `package.json` | Change `"name"`. `@netlify/blobs` stays the only dependency. |
| `.gitignore` | Check only; no change expected. |

There must be **no** `netlify/edge-functions/` directory (`maintenance.js` and
`solar-gate.js` are gone), and no `send-message`, `list-messages`,
`get-messages`, `delete-message`, `get-dreams`, `delete-dream`,
`sync-dreams-now`, `toggle-maintenance`, `verify-solar-passcode`,
`lib/dream-sync.js`, or `solar-system.html`. Neither HTML page calls any of
them (verified: zero requests in the test runs).

---

## 5. Dashboard steps

### Cloudflare
1. **Turnstile** → Add widget → hostnames: the friend's custom domain **and**
   their `*.netlify.app` subdomain → Managed mode.
   - Site key → `index.html` line 3920 (`TURNSTILE_SITE_KEY`)
   - Secret key → Netlify env `TURNSTILE_SECRET_KEY`
2. **R2** → create a bucket → Settings → Public access → enable the
   `r2.dev` subdomain (or attach a custom domain) → copy the
   `https://pub-….r2.dev` URL into `index.html` lines 14 and 1870.
3. **R2 CORS policy** (bucket → Settings → CORS): allow `GET`/`HEAD` from the
   friend's domain(s). The audio player loads with `crossOrigin="anonymous"`
   (needed for iOS fade-in), and custom admin fonts load via `FontFace`. Without
   CORS the song still plays, but the fades and the fonts don't work.
4. Upload the song, background video/image, badge art, etc.

### Discord
1. Friend joins the Lanyard server (`discord.gg/lanyard`). Live status, avatar
   and Spotify all come from Lanyard.
2. Developer Mode → right-click profile → Copy User ID → the
   `YOUR_DISCORD_USER_ID` placeholders, plus Netlify env `DISCORD_USER_ID`.
3. Developer Portal → New Application → Bot → Reset Token → Netlify env
   `DISCORD_BOT_TOKEN`.
4. Channel → Edit → Integrations → Webhooks → New → Copy URL → Netlify env
   `DISCORD_WEBHOOK_URL`.

### Netlify
1. Add new site → Import from Git → this repo. No build command; publish
   directory per `netlify.toml`.
2. Site configuration → General → Site details → **Site ID** →
   `NETLIFY_SITE_ID`. User settings → Applications → Personal access tokens →
   new token → `NETLIFY_BLOBS_TOKEN`.
3. Site configuration → Environment variables → add all seven from section 1.
4. Domain management → add the custom domain (HTTPS is automatic). Then add
   that domain to the Turnstile widget's hostnames.
5. Deploys → Trigger deploy (env var changes need a redeploy).
6. Open `/admin.html`, unlock with `ADMIN_KEY`, and fill in the Content Editor,
   UI Editor (including Site accent) and Enter Screen.
7. On the friend's own devices, visit `/?owner` once, so their visits don't
   count as views or ping Discord (`/?owner=0` undoes it).
