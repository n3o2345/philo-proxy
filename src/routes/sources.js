'use strict';

const express  = require('express');
const axios    = require('axios');
const router   = express.Router();
const { getDb }   = require('../db');
const plugins     = require('../plugins');

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseChannels(channels, sourceId) {
  return channels.map((ch, idx) => ({
    source_id:   ch.source_id   ?? sourceId,
    name:        ch.name        || 'Unknown',
    number:      ch.number      ?? null,
    logo_url:    ch.logo_url    ?? null,
    stream_url:  ch.stream_url  || '',
    stream_type: ch.stream_type || 'hls',
    group_name:  ch.group_name  ?? null,
    epg_id:      ch.epg_id      ?? null,
    enabled:     ch.enabled     ?? 1,
    sort_order:  ch.sort_order  ?? idx,
  }));
}

async function syncSource(sourceId, type, config) {
  const db     = getDb();
  const plugin = plugins.get(type);

  if (!plugin) throw new Error(`Unknown source type: ${type}`);

  const prevRows = db.prepare('SELECT name, stream_url, enabled FROM channels WHERE source_id=?').all(sourceId);
  const enabledMap = new Map();
  for (const r of prevRows) {
    enabledMap.set(`${r.name}\x00${r.stream_url}`, r.enabled);
  }

  db.prepare('DELETE FROM channels WHERE source_id=?').run(sourceId);

  const raw        = await plugin.syncChannels(sourceId, config, db);
  const normalised = normaliseChannels(raw, sourceId);

  for (const ch of normalised) {
    const key = `${ch.name}\x00${ch.stream_url}`;
    if (enabledMap.has(key)) ch.enabled = enabledMap.get(key);
  }

  const stmt = db.prepare(`
    INSERT INTO channels
      (source_id,name,number,logo_url,stream_url,stream_type,group_name,epg_id,enabled,sort_order)
    VALUES
      (@source_id,@name,@number,@logo_url,@stream_url,@stream_type,@group_name,@epg_id,@enabled,@sort_order)
  `);
  const insertMany = db.transaction(chs => { for (const ch of chs) stmt.run(ch); });
  insertMany(normalised);
  return normalised;
}

// ── Fuzzy name-matching helpers ───────────────────────────────────────────────

function normaliseName(str) {
  return (str || '')
    .toLowerCase()
    .trim()
    .replace(/\s+(hd|sd|fhd|4k|uhd)\s*$/i, '')
    .replace(/^\d+\.?\s+/, '')
    .replace(/\s+/g, ' ');
}

function _levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (a.length < b.length) { const t = a; a = b; b = t; }
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

function _jaroWinkler(s1, s2) {
  if (s1 === s2) return 1;
  const len1 = s1.length, len2 = s2.length;
  if (!len1 || !len2) return 0;
  const matchDist = Math.max(Math.floor(Math.max(len1, len2) / 2) - 1, 0);
  const s1Matches = new Uint8Array(len1);
  const s2Matches = new Uint8Array(len2);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < len1; i++) {
    const lo = Math.max(0, i - matchDist), hi = Math.min(i + matchDist + 1, len2);
    for (let j = lo; j < hi; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = s2Matches[j] = 1;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, len1, len2); i++) {
    if (s1[i] !== s2[i]) break;
    prefix++;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function _similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const jw  = _jaroWinkler(a, b);
  const lev = 1 - _levenshtein(a, b) / Math.max(a.length, b.length);
  return 0.6 * jw + 0.4 * lev;
}

function _isSimilar(a, b, tolerance) {
  if (tolerance === 0) return a === b;
  return _similarity(a, b) >= (1 - tolerance / 100);
}

function _findSimilar(candidate, seenList, tolerance) {
  if (tolerance === 0) return null;
  for (const seen of seenList) {
    if (_isSimilar(candidate, seen, tolerance)) return seen;
  }
  return null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const rows = getDb().prepare('SELECT * FROM sources ORDER BY id').all();
  res.json(rows.map(r => ({ ...r, config: JSON.parse(r.config) })));
});

router.get('/plugin-types', (req, res) => {
  res.json(plugins.all().map(p => ({
    type:        p.type,
    displayName: p.displayName,
    icon:        p.icon,
    description: p.description,
  })));
});

router.get('/:id', (req, res) => {
  const row = getDb().prepare('SELECT * FROM sources WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ ...row, config: JSON.parse(row.config) });
});

router.post('/', async (req, res) => {
  const { name, type, config, max_streams, epg_source_id, color } = req.body;
  if (!name || !type || !config) return res.status(400).json({ error: 'name, type, config required' });
  if (!plugins.get(type)) return res.status(400).json({ error: `Unknown source type: ${type}` });

  const db     = getDb();
  const result = db.prepare(
    'INSERT INTO sources (name, type, config, max_streams, epg_source_id, color) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, type, JSON.stringify(config), max_streams ?? 0, epg_source_id ?? null, color ?? null);
  const sourceId = result.lastInsertRowid;

  try {
    const channels = await syncSource(sourceId, type, config);
    db.prepare(`UPDATE sources SET last_sync=datetime('now') WHERE id=?`).run(sourceId);
    res.json({ id: sourceId, name, type, config, channels_imported: channels.length });
  } catch (err) {
    res.status(207).json({ id: sourceId, name, type, config, warning: err.message });
  }
});

router.put('/:id', (req, res) => {
  const { name, enabled, config, max_streams, epg_source_id, color } = req.body;
  getDb().prepare(`
    UPDATE sources SET
      name          = COALESCE(?,name),
      enabled       = COALESCE(?,enabled),
      config        = COALESCE(?,config),
      max_streams   = COALESCE(?,max_streams),
      epg_source_id = CASE WHEN ? IS NOT NULL THEN ? ELSE epg_source_id END,
      color         = COALESCE(?,color)
    WHERE id=?
  `).run(
    name || null,
    enabled ?? null,
    config ? (typeof config === 'string' ? config : JSON.stringify(config)) : null,
    max_streams ?? null,
    epg_source_id !== undefined ? 1 : null, epg_source_id ?? null,
    color ?? null,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  getDb().prepare('DELETE FROM sources WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/sources/dedup-ranked
router.post('/dedup-ranked', (req, res) => {
  const db          = getDb();
  const sourceOrder = req.body?.source_order || [];
  const scope       = req.body?.scope || 'name';
  const tolerance   = Math.max(0, Math.min(100, parseInt(req.body?.tolerance ?? 0, 10)));

  const priority = {};
  sourceOrder.forEach((id, idx) => { priority[id] = idx; });

  const richness = {};
  {
    const rows = db.prepare(`
      SELECT
        epg_id,
        COUNT(*) AS prog_count,
        SUM(CASE WHEN description IS NOT NULL AND description != '' THEN 1 ELSE 0 END) AS desc_count,
        SUM(CASE WHEN episode IS NOT NULL AND episode != '' THEN 1 ELSE 0 END) AS ep_count,
        SUM(CASE WHEN icon_url IS NOT NULL AND icon_url != '' THEN 1 ELSE 0 END) AS icon_count
      FROM programs
      GROUP BY epg_id
    `).all();
    for (const r of rows) {
      richness[r.epg_id] = r.prog_count + r.desc_count * 2 + r.ep_count * 1.5 + r.icon_count * 0.5;
    }
  }

  const channels = db.prepare(`
    SELECT id, name, group_name, source_id, sort_order, epg_id
    FROM   channels
    ORDER  BY id
  `).all();

  // Sort hierarchy: EPG Richness (desc) -> Playlist Order -> internal sort
  channels.sort((a, b) => {
    const ra = richness[a.epg_id] ?? 0;
    const rb = richness[b.epg_id] ?? 0;
    if (ra !== rb) return rb - ra; // Richer EPG wins first

    const pa = priority[a.source_id] ?? 9999;
    const pb = priority[b.source_id] ?? 9999;
    if (pa !== pb) return pa - pb; // Playlist rank breaks ties

    return (a.sort_order - b.sort_order) || (a.id - b.id);
  });

  const seenNameExact = new Set();
  const seenNameList  = [];
  const toDisable     = [];

  function _registerName(namePart) {
    seenNameExact.add(namePart);
    if (!seenNameList.includes(namePart)) seenNameList.push(namePart);
  }

  for (const ch of channels) {
    const namePart  = normaliseName(ch.name);
    const groupPart = scope === 'name+group' ? (ch.group_name || '').trim().toLowerCase() : null;

    let isDuplicate = tolerance === 0
      ? seenNameExact.has(namePart)
      : _findSimilar(namePart, seenNameList, tolerance) !== null;

    // Group tie-break: if scope is name+group, different group name = not a duplicate
    if (isDuplicate && groupPart !== null) {
      const compoundKey = `${namePart}||${groupPart}`;
      if (!seenNameExact.has(compoundKey)) {
        isDuplicate = false;
        seenNameExact.add(compoundKey);
      }
    }

    if (isDuplicate) {
      toDisable.push(ch.id);
    } else {
      _registerName(namePart);
      if (groupPart !== null) seenNameExact.add(`${namePart}||${groupPart}`);
    }
  }

  if (toDisable.length === 0)
    return res.json({ removed: 0, message: 'No duplicates found', tolerance });

  const stmt = db.prepare('UPDATE channels SET enabled = 0 WHERE id=?');
  db.transaction(ids => { for (const id of ids) stmt.run(id); })(toDisable);

  res.json({
    disabled: toDisable.length,
    tolerance,
    message: `Disabled ${toDisable.length} duplicate channel(s) (tolerance=${tolerance})`,
  });
});

// POST /api/sources/dedup
router.post('/dedup', (req, res) => {
  const db        = getDb();
  const scope     = req.body?.scope || 'name';
  const tolerance = Math.max(0, Math.min(100, parseInt(req.body?.tolerance ?? 0, 10)));

  const channels = db.prepare(`
    SELECT id, name, group_name, source_id, sort_order, epg_id
    FROM   channels
    ORDER  BY source_id, sort_order, id
  `).all();

  const seenNameExact = new Set();
  const seenNameList  = [];
  const toDisable     = [];

  function _registerName(namePart) {
    seenNameExact.add(namePart);
    if (!seenNameList.includes(namePart)) seenNameList.push(namePart);
  }

  for (const ch of channels) {
    const namePart  = normaliseName(ch.name);
    const groupPart = scope === 'name+group' ? (ch.group_name || '').trim().toLowerCase() : null;

    let isDuplicate = tolerance === 0
      ? seenNameExact.has(namePart)
      : _findSimilar(namePart, seenNameList, tolerance) !== null;

    if (isDuplicate && groupPart !== null) {
      const compoundKey = `${namePart}||${groupPart}`;
      if (!seenNameExact.has(compoundKey)) {
        isDuplicate = false;
        seenNameExact.add(compoundKey);
      }
    }

    if (isDuplicate) {
      toDisable.push(ch.id);
    } else {
      _registerName(namePart);
      if (groupPart !== null) seenNameExact.add(`${namePart}||${groupPart}`);
    }
  }

  if (toDisable.length === 0) return res.json({ removed: 0, message: 'No duplicates found', tolerance });

  const stmt = db.prepare('UPDATE channels SET enabled = 0 WHERE id=?');
  db.transaction(ids => { for (const id of ids) stmt.run(id); })(toDisable);

  res.json({ 
    disabled: toDisable.length, 
    tolerance, 
    message: `Disabled ${toDisable.length} duplicate channel(s) (tolerance=${tolerance})` 
  });
});

router.post('/:id/sync', async (req, res) => {
  const source = getDb().prepare('SELECT * FROM sources WHERE id=?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Not found' });
  const config = JSON.parse(source.config);
  try {
    const channels = await syncSource(source.id, source.type, config);
    getDb().prepare(`UPDATE sources SET last_sync=datetime('now') WHERE id=?`).run(source.id);
    res.json({ channels_imported: channels.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.syncSource = syncSource;