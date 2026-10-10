# Setup checklist for the trimmed copy

This copy keeps the following.

**Public site**
- The enter/loading screen, in both the classic gradient and the cinematic loader.
- The hero card: avatar, name, live Discord status and the typewriter bio.
- The audio player.
- The Discord presence card with interests.
- About, Favorite Game, Watch (YouTube) and Socials.
- The glassy cards, with their hover scaling and scroll reveal.

**Admin**
- Home, Analytics, Content Editor, UI Editor, Presets, Discord Badges and Enter Screen, numbered 01–07.
- The Settings drawer: 01 Public Site Features, 02 Admin Panel Theme, 03 Home Greetings (new: the admin home page's welcome messages) and 04 Danger Zone. Danger Zone keeps the view reset and the Cloudflare Turnstile Gate toggle.

**Removed**
- Current Job.
- Showcase.
- Leave a Message, including the guestbook wall and the admin notification bell.
- Dream Journal, including its Settings-drawer controls.
- Solar System, including its passcode gate and nav entry.
- Maintenance.
- The hamburger menu. Its only link now sits in the footer.

> This file is in the site root, and `netlify.toml` publishes the root
> (`publish = "."`), so it is publicly reachable at `/SETUP.md`. It contains no
> secrets. Delete it once setup is done if you'd rather not expose it (see §7).

---

## 1. Files (27)

| # | File | Why it's here |
|---|---|---|
| 1 | `index.html` | Public site (trimmed) |
| 2 | `admin.html` | Admin panel (trimmed) |
| 3 | `netlify.toml` | Has only `[build]` and `[functions]`. Runs `npm install`, publishes the root, and bundles functions with esbuild, keeping `@netlify/blobs` external |
| 4 | `package.json` | The one dependency, `@netlify/blobs` (`^10.7.13`). Node ≥ 18 |
| 5 | `.gitignore` | `node_modules/`, `.netlify/`, `.env*` and OS/log clutter |
| 6 | `netlify/functions/get-content.js` | The single read endpoint. Holds every `DEFAULT_*` object and merges them over the stored blobs |
| 7 | `netlify/functions/update-content.js` | The single write endpoint, with one validated handler per content type |
| 8 | `netlify/functions/presets.js` | Presets: list, create, rename, update, delete and apply |
| 9 | `netlify/functions/get-analytics.js` | The Analytics section (`?range=24h\|3d\|7d\|14d\|all`) |
| 10 | `netlify/functions/reset-views.js` | Settings → Danger Zone → Reset View Counter & Analytics |
| 11 | `netlify/functions/verify-turnstile.js` | Server-side Turnstile check. Issues the gate-pass cookie |
| 12 | `netlify/functions/discord-banner-live.js` | Live Discord profile banner, accent colour and avatar decoration |
| 13 | `netlify/functions/get-guild-preview.js` | Server preview for the guild-tag pill next to the username |
| 14 | `netlify/functions/increment-view.js` | Global view counter |
| 15 | `netlify/functions/log-event.js` | View, click and session events for Analytics |
| 16 | `netlify/functions/notify-visit.js` | Discord webhook ping on a real visit (`DISCORD_WEBHOOK_URL` only) |
| 17 | `netlify/functions/bot-filter.js` | Bot detection, user-agent parsing, the cross-site check and the gate-pass cookie |
| 18 | `netlify/functions/lib/admin-auth.js` | Constant-time admin-key check plus the brute-force lockout |
| 19 | `netlify/functions/lib/rate-limit.js` | Blob-backed fixed-window rate limiter |
| 20 | `netlify/functions/lib/countries.js` | ISO code → country name and flag, for Analytics and the webhook |
| 21 | `favicon.png` | **Copy in from your site**, then replace the artwork |
| 22 | `cover.png` | **Copy in.** Keep the filename and replace the artwork (see §4) |
| 23–25 | `discord-icon.png`, `spotify-icon.png`, `steam-icon.png` | **Copy in** unchanged. They're social-link icon URLs you paste in the admin |
| 26 | `loader-sfx.mp3` | **Copy in** unchanged. The cinematic loader's ambient loop (see §4) |
| 27 | `SETUP.md` | This file |

The 6 binary assets (rows 21–26) aren't in the repo. Copy them from your site
into the repo root next to `index.html`.

There is **no** `netlify/edge-functions/` directory and no `package-lock.json`.
`npm install` resolves the lock on each deploy. To pin it, run `npm install`
locally and commit the lockfile.

**The functions were written from scratch.** Your originals never arrived in
this conversation (only the two HTML files did). So every function above was
built against exactly what `index.html` and `admin.html` send and expect, and
was tested end to end against both pages (§8). The behaviour matches the brief.
It isn't a line-by-line copy of your code, though, so read §6 for where it
differs or is stricter.

---

## 2. Environment variables

Set these in Netlify → Site configuration → Environment variables, then
redeploy.

| Variable | Used by | Notes |
|---|---|---|
| `ADMIN_KEY` | `lib/admin-auth.js` (every admin endpoint goes through it) | The admin password. Make it long and random, e.g. `openssl rand -base64 32`. Surrounding whitespace is trimmed. If it's missing, admin endpoints answer 500 (they fail closed) |
| `DISCORD_BOT_TOKEN` | `discord-banner-live.js`, `get-guild-preview.js` | Bot token only, no `Bot ` prefix. Without it the banner falls back to the admin's static banner, and the guild preview uses the public widget, if the server has one enabled |
| `DISCORD_USER_ID` | `get-content.js` (both pages), `discord-banner-live.js`, `get-guild-preview.js` | The friend's numeric user ID. **This one value decides whose Discord profile the site shows**: both pages read it from `get-content` and ask Lanyard for that user's avatar, name, Nitro name effect, guild tag, status and Spotify. The guild preview only looks up the server in this user's guild tag |
| `DISCORD_WEBHOOK_URL` | `notify-visit.js` | Must be a `https://discord.com/api/webhooks/…` URL. If it's unset, visit pings are skipped silently |
| `TURNSTILE_SECRET_KEY` | `verify-turnstile.js`, `bot-filter.js` | Verifies Turnstile tokens, and also signs the HMAC gate-pass cookie. Rotating it signs every visitor out of the gate (they just solve it again) |
| `NETLIFY_SITE_ID` | every function: Blobs storage, rate limits and the lockout | Site configuration → Site details → Site ID |
| `NETLIFY_BLOBS_TOKEN` | every function, as above | Personal access token. Pick **no expiry**, or a long one with a reminder to rotate it. When it expires, every save, the view counter, analytics and admin login stop working (they fail with 503) |

**Do not set:** `MAINTENANCE_KEY`, `SOLAR_SYSTEM_PASSCODE`, `SOLAR_WEBHOOK_URL`,
`DREAMS_CHANNEL_ID`. Nothing reads them.

Blob stores in use:
- `site-content`: content, theme, presets and the view counter.
- `site-analytics`: events.
- `site-guard`: rate limits and the lockout.

None of these use the dead keys (`showcase`, `current-job`, `messages`,
`messages-seen`, `dreams`, `dreams-deleted`, `dream-settings`, `maintenance`,
`solar-system`, `loader`), and nothing reads or writes them.

---

## 3. What fills in by itself, and what's left to edit

Nothing in `admin.html` or the functions needs editing. Both pages pick up who
the site belongs to while they run:

| What | Where it comes from |
|---|---|
| Discord avatar, name, Nitro name effect, guild tag, status, Spotify, "Add on Discord" link | Lanyard, for the user in the `DISCORD_USER_ID` env var |
| Name on the hero card and the tab title | Admin → Content Editor → A Identity → Display handle. **Leave it blank to use the Discord display name.** |
| Avatar initials (only shown if no picture loads) | The name above |
| Song, artist, cover | Admin → Content Editor → D Audio |
| Domain (footer link, admin login, sidebar, help text) | The address bar |
| Admin home greetings and subtitle | Admin → Settings → 03 Home Greetings (default "first message" / "☆ subtitle ☆"). One is picked at random per visit; `{name}` becomes the display handle, or the Discord name |
| Interests, about, bio, favorite game | Admin → Content Editor. Until then the site shows neutral placeholders ("First interest" … "Fourth interest", 一 二 三 四); the favorite-game card stays hidden until a game is set |
| Discord API User-Agent | Netlify's built-in `URL` variable |

Only three things in `index.html` are still typed in by hand:

| Line | What | Notes |
|---|---|---|
| 3954 | `YOUR_TURNSTILE_SITE_KEY` | The Turnstile **site** key (§5). Only needed if the gate is switched on in Settings → Danger Zone. |
| 1836 | `<span id="hudLocText"></span>` | Optional location in the bottom-right corner, e.g. `<span id="hudLocText">Berlin, Germany</span>`. Left empty, it's hidden. There's no admin field for it. |
| 1872 | "site made by @dmorfd" | Your credit as the person who made the site, linking to your Discord. Edit or delete the line if you'd rather not. |

---

## 4. Assets and media

- **R2 for media.** Upload songs, background videos and images, badge art and
  game covers to R2. Paste their `https://pub-….r2.dev/…` (or custom-domain)
  URLs into the admin.
- **`favicon.png`**: replace the artwork with the friend's.
- **`cover.png`**: keep the filename and replace the artwork. It's the default
  song cover (`coverUrl: '/cover.png'` in `get-content.js`) and the soundbar's
  first-paint `<img>` in `index.html`.
  - There's **no `og:image` tag** in the uploaded `index.html`, so cover.png
    isn't a link-preview image here.
  - To get one, add
    `<meta property="og:image" content="https://YOUR_DOMAIN/cover.png">` to the
    `<head>`.
- **`discord-icon.png`, `spotify-icon.png`, `steam-icon.png`**: not referenced
  in code by design. In Content Editor → F Social links, paste them as icon
  URLs, e.g. `/discord-icon.png`.
- **`loader-sfx.mp3`**: Enter Screen → Cinematic → Ambient sound → Loop URL.
  Use the **full** URL, `https://YOUR_DOMAIN/loader-sfx.mp3`, not
  `/loader-sfx.mp3`. Both the page's sound loader and the admin's Test button
  only play http(s) URLs, and the server rejects a relative Loop URL on save.
  Uploading the file to R2 and using that URL works too.

---

## 5. Dashboard steps

### Cloudflare
1. **Turnstile** → Add widget.
   - Hostnames: the friend's custom domain **and** their `*.netlify.app`
     subdomain.
   - Mode: Managed.
   - Site key → index.html line 3954. Secret key → Netlify env
     `TURNSTILE_SECRET_KEY`.
2. **R2** → create a bucket → Settings → Public access → enable the `r2.dev`
   subdomain, or connect a custom domain. Media URLs are pasted into the admin
   (e.g. Content Editor → D Audio), so no file needs the bucket URL.
3. **R2 CORS** (bucket → Settings → CORS policy): allow `GET` and `HEAD` from
   the friend's domain(s) and the `*.netlify.app` URL. For example:
   ```json
   [{ "AllowedOrigins": ["https://YOUR_DOMAIN", "https://your-site.netlify.app"],
      "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 86400 }]
   ```
   - The audio player loads with `crossOrigin="anonymous"`, which the fade-in
     needs, and custom fonts load through `FontFace`.
   - Without CORS, songs still play, but fades and custom fonts break.
4. Upload the media.

### Discord
1. The friend joins the Lanyard server (`discord.gg/lanyard`). Live status, the
   avatar and Spotify all come from Lanyard.
2. Settings → Advanced → Developer Mode → right-click their profile → Copy User
   ID → Netlify env `DISCORD_USER_ID`. That's the only place it goes.
3. Developer Portal → New Application → Bot → Reset Token → Netlify env
   `DISCORD_BOT_TOKEN`.
   - The banner endpoint needs no server invite.
   - For the guild-tag preview, the bot must be **in the friend's tag
     server**. Otherwise it falls back to the server widget, if that's enabled.
4. Server channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy
   URL → Netlify env `DISCORD_WEBHOOK_URL`.

### Netlify
1. Add new site → Import an existing project → this repo. The build settings
   come from `netlify.toml`: `npm install`, publish `.`, functions in
   `netlify/functions`.
2. Site configuration → Site details → **Site ID** → `NETLIFY_SITE_ID`.
   User settings → Applications → Personal access tokens → New token (no
   expiry) → `NETLIFY_BLOBS_TOKEN`.
3. Add all seven env vars from §2.
4. Domain management → add the custom domain (HTTPS is automatic). Add the
   same domain to the Turnstile widget's hostnames.
5. Deploys → Trigger deploy. Env var changes only take effect after a deploy.
6. Open `/admin.html` and unlock it with `ADMIN_KEY`. Then fill in:
   - Content Editor
   - UI Editor, including **Color & glow → Site accent**
   - Discord Badges
   - Enter Screen
7. On the friend's own devices, visit `/?owner` once. Their visits then don't
   count as views or ping Discord. `/?owner=0` undoes it.

---

## 6. Behaviour notes and decisions

**Site accent (new, editable).**
- The glass look comes from a single accent colour, through
  `applySharedAccent`.
- It used to be the Dream Journal's colour. It's now `theme.siteAccent`:
  - Default `#e7a6e0` in `DEFAULT_THEME`, next to `glowColor`.
  - Validated as hex in `update-content`.
  - Edited at **UI Editor → Color & glow → Site accent**.
- "Glow colour" falls back to it when blank.
- Presets snapshot it with the rest of the theme.
- At `#e7a6e0`, every kept card's computed style matches your original site.

**Discord name effects.** The profile card's name mirrors the friend's Nitro
display name style: Solid, Gradient, Neon, Toon, Pop, Glow, Prism (up to five
colours, flowing) and Gummy (a colour per letter). The style comes from
Lanyard, or from the bot (`discord-banner-live`) if Lanyard doesn't carry it.
Discord's display-name fonts aren't public, so the font itself isn't copied.

**Admin videos.** Whatever plays on the admin Home page fades out on the other
sections. With both videos set, the Hero / Overview video plays on Home and the
Main Background Video on every other section. With only the Main video, it
plays on Home only.

**Hamburger → footer link.** The burger icon, its overlay and its script are
gone. The one remaining link is in the footer, and shows the site's own domain.

**Job title and Workplace are not in Content Editor A.**
- Your checklist listed them under Identity, but they were the Current Job
  section's fields. `update-content` drops the `current-job` type as you asked,
  so it now answers 400.
- Publish All saves one type after another and stops at the first error.
- So with those fields kept, Publish All would fail every time. Identity now
  has just Display handle.
- "Leave a Message" is also gone from the UI Editor's reorder list, along with
  Showcase and Current Job, since its section no longer exists.

**`get-content` caching.**
- `cacheable = !hasAdminKey`: public responses are CDN-cached (5 s, then
  stale-while-revalidate). Any request carrying `X-Admin-Key` is verified and
  never cached.
- A response where some blobs failed to load is never cached.
- Admin-only fields stay out of the public response: presets, admin theme and
  the admin video background.
- `includeSolar`, `hasValidToken`, `solarSystem` and `solarGateAudio` don't
  exist.

**Admin login doesn't write anything.** Unlocking checks the key with a keyed,
read-only `get-content` request. The old way, saving the display handle to test
the key, is gone.

**Lockout.**
- 5 wrong keys in 15 minutes locks that client out for 15 minutes. A client is
  an IPv4 address, or an IPv6 /64.
- Parallel guesses can't get around it, because every attempt is reserved
  before the key is compared.
- After a correct key, that client is trusted for 12 hours. Normal admin use
  costs no extra writes.
- There's also a **site-wide budget of 100 failed attempts per hour**, against
  guessing spread over many IPs.
- Trade-off: someone hammering the login from many IPs can stop *new* admin
  logins for up to an hour. An already-unlocked browser keeps working.

**Turnstile gate is enforced server-side.**
- When Settings → Danger Zone → Cloudflare Turnstile Gate is on, a visitor who
  passes Turnstile gets a signed, HttpOnly cookie, valid for 6 hours.
- Visitors without that cookie are ignored by `increment-view`, `log-event` and
  `notify-visit`. Scripts can't inflate the stats by skipping the widget.

**Cross-site requests are refused.** All public endpoints that write reject
cross-site browser requests (`Sec-Fetch-Site` / `Origin`): views, events, pings
and the Turnstile check.

**Analytics click events** are only recorded for names that match one of the
saved social links. Arbitrary labels can't be injected.

**Guild preview** only ever spends the bot token on the friend's own tag server.
Any other `guildId` gets a 404.

**Reset View Counter & Analytics** sets the counter to 0 and deletes every
stored analytics event.

**Rate limits** (per client):
| Endpoint | Limit |
|---|---|
| Views | 6 per hour |
| Events | 60 per 10 min |
| Turnstile verifies | 20 per 10 min |
| Guild previews | 30 per 10 min |
| Visit pings | 1 per 30 min, plus a site-wide 60 per hour |

---

## 7. Known trade-offs kept per the brief

- **`publish = "."` exposes the source.** Because the repo root is the publish
  directory, `/netlify/functions/*.js`, `/package.json` and `/SETUP.md` are
  downloadable. There are no secrets in them (secrets are only in env vars), but
  the code is readable.
  - To hide it, move the site files into a `public/` folder and set
    `publish = "public"`.
  - Or add a `_redirects` file with
    `/netlify/*  /404  404!` and `/SETUP.md  /404  404!`.
  - Both mean adding a file beyond the 27, which is why it isn't done here.
- **`external_node_modules = ["@netlify/blobs"]`** ships the whole package with
  each function, so each function zip is a few MB. That's well under Netlify's
  limits; it only makes deploys slightly slower. Removing the line makes
  esbuild bundle it instead, which is smaller, but you asked to keep it.

---

## 8. Verification done

Tested locally in headless Chromium, desktop and mobile. The local server ran
these functions against a local Blobs server, with Discord, Lanyard and
Turnstile stubbed.

- **Public site.** Both enter-screen styles render with no JS errors. Removed
  sections are absent from the DOM. The kept sections render in the saved order.
  Views, events and visit pings fire once.
- **Admin.** All 7 sections work, plus the Settings drawer with no Maintenance,
  Solar or Dream Journal. Every editor saves, and the change shows up on the
  public site. Presets round-trip. Reset works. A stale tab gets a 409 conflict
  instead of overwriting newer changes.
- **No dead calls.** Neither page requests any removed endpoint, such as
  `send-message`, `get-dreams`, `toggle-maintenance` or
  `verify-solar-passcode`.
- **Security.** The lockout, rate limits and gate were checked under parallel
  load, with storage semantics matching production.
