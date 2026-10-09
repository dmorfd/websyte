# Setup checklist for the trimmed copy

This copy keeps: the enter/loading screen (classic gradient and the cinematic
loader), hero card with live Discord status and typewriter bio, audio player,
Discord presence and interests, About, Favorite Game, Watch (YouTube), Socials.
Admin keeps: Home, Analytics, Content Editor, UI Editor, Presets, Discord
Badges and Enter Screen (sidebar and topbar numbered 01–07).

Removed: Current Job, Showcase, Leave a Message (with the guestbook wall and
the admin messages bell), Dream Journal, Solar System (with the passcode gate),
and Maintenance.

> **Status:** `index.html` and `admin.html` are done and tested. The
> `netlify/` functions, `netlify.toml`, `package.json` and `.gitignore` were not
> in this repo, so section 4 lists what still needs to change in them.

> This file sits in the site root. If Netlify publishes the root folder, it
> will be publicly reachable at `/SETUP.md`. It contains no secrets, but you can
> delete it once setup is finished.

---

## 1. Environment variables (Netlify → Site configuration → Environment variables)

| Variable | Status | Evidence |
|---|---|---|
| `ADMIN_KEY` | **keep** | every admin call sends `X-Admin-Key` (checked by `lib/admin-auth.js`) |
| `TURNSTILE_SECRET_KEY` | **keep** | the entry gate POSTs to `verify-turnstile` |
| `DISCORD_BOT_TOKEN` | **keep** | `discord-banner-live` (live banner and avatar decoration) and probably `get-guild-preview` |
| `DISCORD_USER_ID` | keep (unconfirmed) | likely read by `discord-banner-live.js` to look up the profile; not visible from the HTML |
| `DISCORD_WEBHOOK_URL` | ⚠ check | this was most likely the **Leave a Message** webhook (`send-message`). It stays needed only if `notify-visit.js` or another kept function reads it |
| `NETLIFY_SITE_ID` | keep (unconfirmed) | only needed if the functions pass `siteID` to `getStore()` |
| `NETLIFY_BLOBS_TOKEN` | keep (unconfirmed) | only needed if the functions pass `token` to `getStore()` |
| `MAINTENANCE_KEY` | **remove** | was only sent to `toggle-maintenance` |
| `SOLAR_SYSTEM_PASSCODE` | **remove** | was only checked by `verify-solar-passcode` |
| `DREAMS_CHANNEL_ID` | **remove** | was only used by `sync-dreams-now` and the dream sync |
| `SOLAR_WEBHOOK_URL` | ⚠ **probably still needed** | the original `index.html` said the visit ping (`notify-visit`) goes "via the solar webhook". If `notify-visit.js` reads `SOLAR_WEBHOOK_URL`, deleting it silently stops the visit pings. Either keep it or point `notify-visit.js` at `DISCORD_WEBHOOK_URL` |

I can confirm the last four rows once I have the function files (section 4).

---

## 2. Personal values to replace (placeholders, not invented values)

### index.html
| Line | Placeholder | Put here |
|---|---|---|
| 6 | `YOUR_NAME` | page title (also overwritten at runtime by the admin's display handle) |
| 14 | `https://pub-YOUR_R2_BUCKET_ID.r2.dev` | friend's R2 public URL (preconnect) |
| 1691 | `YOUR_DISCORD_USER_ID` / `YOUR_AVATAR_HASH` | first-paint avatar. Lanyard replaces it within seconds, so a 404 here is harmless |
| 1693 | `YOUR_INITIALS` | avatar fallback monogram |
| 1697 | `YOUR_NAME` | hero name before content loads |
| 1727–1728 | `YOUR_SONG_TITLE` | default song title before content loads |
| 1825 | `YOUR_DISCORD_USER_ID` | "Add on Discord" link |
| 1926 | `YOUR_LOCATION` | bottom-right HUD location |
| 1942 | `YOUR_DOMAIN` | hidden-nav label |
| 1979 | `YOUR_DISCORD_USER_ID`, `@YOUR_DISCORD_USERNAME` | footer "site made by" credit |
| 1987 | `https://pub-YOUR_R2_BUCKET_ID.r2.dev/YOUR_SONG.mp3` | default song URL |
| 4038 | `YOUR_TURNSTILE_SITE_KEY` | Turnstile **site** key (step 5) |
| 4491 | `YOUR_DISCORD_USER_ID` | Lanyard presence user ID |
| 4903 | `YOUR_SPOTIFY_USER_ID` | Spotify profile fallback link (used when a track has no id) |

### admin.html
| Line | Placeholder | Put here |
|---|---|---|
| 6 | `YOUR_DOMAIN` | tab title |
| 740 | `YOUR_NAME` | fallback handle used by the login key-check save |
| 780, 812 | `YOUR_INITIALS` | login and sidebar monogram (shown only if the avatar and favicon both fail) |
| 784 | `YOUR_DOMAIN` | login subtitle |
| 829 | `YOUR_DOMAIN` | sidebar footer |
| 840 | `YOUR_DISCORD_USER_ID` | admin avatar via Lanyard (a second hardcoded ID you hadn't listed) |
| 1093, 1094 | `YOUR_NAME` | home greetings |
| 1104 | `YOUR_NICKNAME` | home greeting |
| 1510 | `YOUR_NAME` | display-handle input hint |
| 1948 | `YOUR_NAME` | UI Editor name-gradient preview text |
| 3171 | `YOUR_DOMAIN` | Settings help text |

**Your call:** the other home greetings (lines 1092–1110: "Pharloom…",
"The Radiance…", "anime girls…", "Lucid Dreaming~…") and `INTRO_SUBTITLE`
(line 1112) are your personal flavour text. I left them unchanged.

### Files to swap
- `favicon.png` and `cover.png`: your branding. Replace them with the friend's.
- `discord-icon.png`, `spotify-icon.png`, `steam-icon.png`, `loader-sfx.mp3`:
  **not referenced anywhere in the two HTML files.** They are probably defaults
  in `get-content.js` (socials icons and the loader sound). I'll confirm when
  I see that file.

### Still to find in the files I haven't seen
- `"arandomperson.dev"` / your name in the **User-Agent strings** of the Netlify functions
- the `"name"` field in `package.json`
- any `pub-….r2.dev` URLs or your song/title in `get-content.js` `DEFAULT_*` objects

---

## 3. One behaviour change to know about

**Site accent colour.** On your site, the Dream Journal's "UI Accent Colour"
setting also recoloured the main site: `--glass`, `--glass-border`, and the
accent variables that make the cards look like transparent purple glass. To keep
that look exactly, `index.html` now applies a fixed `SITE_ACCENT = '#e7a6e0'`
(line 1991), which is the same default as before. To change the accent, edit
that line. The UI Editor's "Glow colour (blank = accent)" falls back to it.

I verified this in Chromium. Every kept card (hero, soundbar, Discord, About,
Interests, Favorite Game, YouTube, socials) has the same computed background,
border, radius, shadow, backdrop blur and transitions as your original, on
desktop and mobile, and the hover lift is the same.

The hidden burger menu now has only one entry ("01 · YOUR_DOMAIN · stay
here"), because Solar System and Dream Journal were its other two options.

---

## 4. Backend changes still to make (need the files)

| File | Change |
|---|---|
| `get-content.js` | drop `job`, `showcase`, `message` from `DEFAULT_SECTIONS`. Delete `DEFAULT_SHOWCASE`, `DEFAULT_CURRENT_JOB`, `DEFAULT_DREAM` (and any dream-settings default), `DEFAULT_MAINTENANCE`, solar defaults. Remove their blob reads from the `Promise.all`: `showcase`, `current-job`, `dreams`/`dream-settings`, `maintenance`, `solar-system`, plus the vestigial `loader`. Remove the response keys `showcase`, `currentJob`, `dream`, `maintenance`, `solarSystem`, `solarGateAudio`, and the `X-Admin-Key` branch if it only gated `solarSystem` |
| `update-content.js` | delete the `type === 'current-job'`, `'showcase'`, `'dream'`, `'solar-system'` handlers (and any `'maintenance'` handler). If the `'sections'` handler validates ids, drop `job`/`showcase`/`message` from its allow-list |
| `presets.js` | check that apply/save don't write any removed blob (the admin only snapshots `theme`, `videoBg`, `song`, `enterScreen`) |
| `notify-visit.js` | confirm which webhook env var it reads (see section 1) |
| `reset-views.js`, `log-event.js`, `get-analytics.js`, `increment-view.js`, `bot-filter.js`, `lib/*` | check for references to `messages`/`messages-seen`/`dreams`/`dreams-deleted`/`maintenance` blobs; replace User-Agent strings |
| `netlify.toml` | must end up with **only** `[build]` and `[functions]`: no `[[edge_functions]]` (e.g. a solar-system cookie gate), no scheduled `[functions."…"]` (e.g. the ~30-min dream sync) |
| `package.json` | swap `"name"` |

These function files should **not** exist in the friend's copy:
`send-message`, `list-messages`, `get-messages`, `delete-message`, `get-dreams`,
`delete-dream`, `sync-dreams-now`, `toggle-maintenance`, `verify-solar-passcode`,
plus `solar-system.html` and any edge-function folder. Neither HTML file calls
any of them any more (verified: zero requests in the test runs).

---

## 5. Dashboard steps

### Cloudflare
1. **Turnstile** → Add widget → hostnames: the friend's custom domain **and**
   their `*.netlify.app` subdomain → Managed mode.
   - Site key → `index.html` line 4038 (`TURNSTILE_SITE_KEY`)
   - Secret key → Netlify env `TURNSTILE_SECRET_KEY`
2. **R2** → create a bucket → Settings → Public access → enable the
   `r2.dev` subdomain (or attach a custom domain) → copy the
   `https://pub-….r2.dev` URL into `index.html` lines 14 and 1987.
3. **R2 CORS policy** (bucket → Settings → CORS): allow `GET`/`HEAD` from the
   friend's domain(s). The audio player loads with `crossOrigin="anonymous"`
   (needed for iOS fade-in), and custom admin fonts load via `FontFace`. Without
   CORS the song still plays, but the fades and the fonts don't work.
4. Upload the song, cover, background video/image, badge art, loader sound, etc.

### Discord
1. Friend joins the Lanyard server (`discord.gg/lanyard`). Live status, avatar
   and Spotify all come from Lanyard.
2. Developer Mode → right-click profile → Copy User ID → the
   `YOUR_DISCORD_USER_ID` placeholders, plus Netlify env `DISCORD_USER_ID`.
3. Developer Portal → New Application → Bot → Reset Token → Netlify env
   `DISCORD_BOT_TOKEN` (live banner, avatar decoration, guild preview).
4. Channel → Edit → Integrations → Webhooks → New → Copy URL → the webhook
   env var `notify-visit` uses (see section 1).

### Netlify
1. Add new site → Import from Git → this repo. No build command; publish
   directory per `netlify.toml`.
2. Site configuration → Environment variables → add the vars from section 1.
3. If the functions pass explicit Blobs credentials: Site configuration →
   General → Site details → **Site ID** → `NETLIFY_SITE_ID`. User settings →
   Applications → Personal access tokens → new token → `NETLIFY_BLOBS_TOKEN`.
4. Domain management → add the custom domain (HTTPS is automatic). Then add
   that domain to the Turnstile widget's hostnames.
5. Deploys → Trigger deploy (env var changes need a redeploy).
6. Open `/admin.html`, unlock with `ADMIN_KEY`, and fill in the Content Editor,
   UI Editor and Enter Screen.
7. On the friend's own devices, visit `/?owner` once, so their visits don't
   count as views or ping Discord (`/?owner=0` undoes it).
