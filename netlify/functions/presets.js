// POST /.netlify/functions/presets   (admin only)
//
// Backs the admin Presets section. A preset is a named snapshot of the public
// site's look: theme (UI Editor), background video, song and enter screen.
//   {action:'save',   preset:{id?, name, theme, videoBg, song, enterScreen}}  create, or overwrite by id
//   {action:'apply',  id}         write the snapshot into the live blobs
//   {action:'rename', id, name}
//   {action:'delete', id}
//   {action:'list'}
// Every action replies {ok:true, presets:[...]}.
//
// Snapshots go through update-content's own field validators, so a preset can
// never store or apply anything a normal save would reject.
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { checkAdmin, authFailure } = require('./lib/admin-auth');
const { SPECS, applySpec, ValidationError, claimRev, text } = require('./update-content');
const { writeIfUnchanged } = require('./lib/rate-limit');

const MAX_PRESETS = 30;
const MAX_BODY = 200 * 1024;

const contentStore = () => getStore({
  name: 'site-content',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN,
  consistency: 'strong',
});

const json = (statusCode, body, headers) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body),
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (message) => { throw new ValidationError(message); };

// Snapshot part → blob it applies to.
const PARTS = [
  { field: 'theme', blob: 'theme', spec: SPECS.theme },
  { field: 'videoBg', blob: 'video-bg', spec: SPECS['video-bg'] },
  { field: 'song', blob: 'song', spec: SPECS.song },
  { field: 'enterScreen', blob: 'enter-screen', spec: SPECS['enter-screen'] },
];

// Validate a snapshot, keeping only known fields.
function cleanSnapshot(preset) {
  const out = {};
  for (const p of PARTS) out[p.field] = isObj(preset[p.field]) ? applySpec(preset[p.field], p.spec, {}).next : {};
  return out;
}

async function readPresets(store) {
  const cur = await store.getWithMetadata('presets', { type: 'json' });
  const list = cur && isObj(cur.data) && Array.isArray(cur.data.presets) ? cur.data.presets : [];
  return { list, cur };
}

// Read-modify-write the presets list with an ETag check, retrying on races.
async function updatePresets(store, mutate) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { list, cur } = await readPresets(store);
    const next = mutate(list.slice());
    const res = await writeIfUnchanged(store, 'presets', cur, { presets: next });
    if (res.modified) return next;
  }
  throw new Error('Could not save presets (too much contention).');
}

function findIndex(list, id) {
  const i = list.findIndex((p) => p && p.id === id);
  if (i < 0) fail('Preset not found.');
  return i;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' }, { Allow: 'POST' });

  const auth = await checkAdmin(event);
  if (!auth.ok) return authFailure(auth);

  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: 'Request too large.' });
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { body = null; }
  if (!isObj(body)) return json(400, { ok: false, error: 'Body must be a JSON object.' });

  let store;
  try {
    store = contentStore();
  } catch (err) {
    console.error('[presets] blobs not configured —', err && err.message);
    return json(500, { ok: false, error: 'Content store not configured — set NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN.' });
  }

  try {
    const now = new Date().toISOString();
    const id = typeof body.id === 'string' ? body.id : '';

    switch (body.action) {
      case 'list': {
        const { list } = await readPresets(store);
        return json(200, { ok: true, presets: list });
      }

      case 'save': {
        if (!isObj(body.preset)) fail('Missing preset.');
        const name = text(body.preset.name, 'Preset name', 40, { required: true });
        const snapshot = cleanSnapshot(body.preset);
        const presetId = typeof body.preset.id === 'string' ? body.preset.id : '';
        const presets = await updatePresets(store, (list) => {
          if (presetId) {
            const i = findIndex(list, presetId);
            list[i] = { ...list[i], name, ...snapshot, updatedAt: now };
          } else {
            if (list.length >= MAX_PRESETS) fail(`At most ${MAX_PRESETS} presets — delete one first.`);
            list.push({ id: crypto.randomBytes(6).toString('hex'), name, ...snapshot, createdAt: now, updatedAt: now });
          }
          return list;
        });
        return json(200, { ok: true, presets });
      }

      case 'rename': {
        const name = text(body.name, 'Preset name', 40, { required: true });
        const presets = await updatePresets(store, (list) => {
          const i = findIndex(list, id);
          list[i] = { ...list[i], name, updatedAt: now };
          return list;
        });
        return json(200, { ok: true, presets });
      }

      case 'delete': {
        const presets = await updatePresets(store, (list) => {
          findIndex(list, id);
          return list.filter((p) => p && p.id !== id);
        });
        return json(200, { ok: true, presets });
      }

      case 'apply': {
        const { list } = await readPresets(store);
        const preset = list[findIndex(list, id)];
        // Validate every part and merge it over the live blob BEFORE writing
        // anything, so a bad snapshot can't leave the site half-applied.
        const writes = [];
        for (const p of PARTS) {
          if (!isObj(preset[p.field]) || !Object.keys(preset[p.field]).length) continue;
          const live = await store.get(p.blob, { type: 'json' });
          writes.push({ blob: p.blob, value: applySpec(preset[p.field], p.spec, isObj(live) ? live : {}).next });
        }
        if (!writes.length) fail('This preset is empty.');
        await claimRev(store);   // other open admin tabs will reload instead of overwriting
        for (const w of writes) await store.setJSON(w.blob, w.value);
        return json(200, { ok: true, presets: list });
      }

      default:
        return json(400, { ok: false, error: `Unknown action: ${String(body.action)}` });
    }
  } catch (err) {
    if (err instanceof ValidationError) return json(400, { ok: false, error: err.message });
    console.error(`[presets] ${body.action} failed —`, err && err.message);
    return json(500, { ok: false, error: 'Preset operation failed — try again.' });
  }
};
