'use strict';

const express  = require('express');
const router   = express.Router();
const { getDb }    = require('../db');
const { fetchXmltv } = require('../lib/xmltv');

// ── EPG Sources ───────────────────────────────────────────────────────────────

// GET /api/epg/sources
router.get('/sources', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM epg_sources ORDER BY id').all());
});

// POST /api/epg/sources
router.post('/sources', async (req, res) => {
  const { name, url, refresh_hours } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  const rh = refresh_hours != null ? Math.max(1, Math.min(168, parseInt(refresh_hours, 10))) : 6;
  const result = getDb()
    .prepare("INSERT INTO epg_sources (name, url, refresh_hours) VALUES (?, ?, ?)")
    .run(name, url, rh);
  res.json({ id: result.lastInsertRowid, name, url, refresh_hours: rh });
});

// PATCH /api/epg/sources/:id - update refresh_hours (and name/url if provided)
router.patch('/sources/:id', (req, res) => {
  const { name, url, refresh_hours } = req.body;
  const db = getDb();
  const src = db.prepare('SELECT * FROM epg_sources WHERE id=?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'Not found' });
  db.prepare(`
    UPDATE epg_sources SET
      name          = COALESCE(?, name),
      url           = COALESCE(?, url),
      refresh_hours = COALESCE(?, refresh_hours)
    WHERE id = ?
  `).run(name ?? null, url ?? null,
         refresh_hours != null ? Math.max(1, Math.min(168, parseInt(refresh_hours, 10))) : null,
         req.params.id);
  res.json({ ok: true });
});

// DELETE /api/epg/sources/:id
router.delete('/sources/:id', (req, res) => {
  getDb().prepare('DELETE FROM epg_sources WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/epg/sources/:id/refresh  - manual trigger
router.post('/sources/:id/refresh', async (req, res) => {
  const src = getDb().prepare('SELECT * FROM epg_sources WHERE id=?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'Not found' });

  try {
    const { programs } = await fetchXmltv(src.url);
    _savePrograms(getDb(), programs);
    getDb().prepare("UPDATE epg_sources SET last_fetch=datetime('now') WHERE id=?").run(src.id);
    res.json({ ok: true, programs: programs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/epg/ids?q=search&limit=30  -- searchable list of all known EPG IDs
// Returns each unique epg_id with program count, current program, and next program.
// Also blends in channel epg_ids that have no programs yet (so you can map before
// EPG data is fetched).
router.get('/ids', (req, res) => {
  const db    = getDb();
  const q     = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 40, 200);
  const now   = Math.floor(Date.now() / 1000);
  const like  = q ? `%${q}%` : '%';

  // Primary: EPG IDs that have program data
  const withPrograms = db.prepare(`
    SELECT
      p.epg_id,
      COUNT(*) AS program_count,
      MAX(CASE WHEN p.start_time <= ? AND p.end_time > ? THEN p.title ELSE NULL END) AS now_title,
      MAX(CASE WHEN p.start_time <= ? AND p.end_time > ? THEN p.start_time ELSE NULL END) AS now_start,
      MAX(CASE WHEN p.start_time <= ? AND p.end_time > ? THEN p.end_time   ELSE NULL END) AS now_end,
      (SELECT p2.title FROM programs p2
        WHERE p2.epg_id = p.epg_id AND p2.start_time > ?
        ORDER BY p2.start_time ASC LIMIT 1) AS next_title,
      (SELECT p2.start_time FROM programs p2
        WHERE p2.epg_id = p.epg_id AND p2.start_time > ?
        ORDER BY p2.start_time ASC LIMIT 1) AS next_start
    FROM programs p
    WHERE p.epg_id LIKE ? ESCAPE '\\'
    GROUP BY p.epg_id
    ORDER BY program_count DESC
    LIMIT ?
  `).all(now, now, now, now, now, now, now, now, like, limit);

  // Secondary: channel epg_ids not already in results (for channels with no EPG data yet)
  const existingIds = new Set(withPrograms.map(r => r.epg_id));
  const fromChannels = q
    ? db.prepare(`
        SELECT DISTINCT epg_id FROM channels
        WHERE epg_id IS NOT NULL AND epg_id != '' AND epg_id LIKE ? ESCAPE '\\'
        LIMIT ?
      `).all(like, limit)
    : [];

  const channelOnly = fromChannels
    .filter(r => !existingIds.has(r.epg_id))
    .map(r => ({ epg_id: r.epg_id, program_count: 0, now_title: null, now_start: null, now_end: null, next_title: null, next_start: null }));

  res.json([...withPrograms, ...channelOnly].slice(0, limit));
});

// ── Program queries ───────────────────────────────────────────────────────────

// GET /api/epg/now?epg_id=...
router.get('/now', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const db  = getDb();

  if (req.query.epg_id) {
    const row = db.prepare(
      'SELECT * FROM programs WHERE epg_id=? AND start_time<=? AND end_time>? ORDER BY start_time DESC LIMIT 1'
    ).get(req.query.epg_id, now, now);
    return res.json(row || null);
  }

  // Return current program for every known epg_id
  const rows = db.prepare(`
    SELECT p.*
    FROM programs p
    INNER JOIN (
      SELECT epg_id, MAX(start_time) AS ms
      FROM programs
      WHERE start_time <= ? AND end_time > ?
      GROUP BY epg_id
    ) latest ON p.epg_id = latest.epg_id AND p.start_time = latest.ms
  `).all(now, now);

  res.json(rows);
});

// GET /api/epg/guide?epg_id=...&from=unix&to=unix
router.get('/guide', (req, res) => {
  const now  = Math.floor(Date.now() / 1000);
  const from = parseInt(req.query.from) || now - 1800;
  const to   = parseInt(req.query.to)   || now + 4 * 3600;
  const db   = getDb();

  if (req.query.epg_id) {
    const rows = db.prepare(
      'SELECT * FROM programs WHERE epg_id=? AND end_time>? AND start_time<? ORDER BY start_time'
    ).all(req.query.epg_id, from, to);
    return res.json(rows);
  }

  const rows = db.prepare(
    'SELECT * FROM programs WHERE end_time>? AND start_time<? ORDER BY epg_id, start_time'
  ).all(from, to);
  res.json(rows);
});

// GET /api/epg/channel/:id  - programs for a channel by channel id
router.get('/channel/:id', (req, res) => {
  const db  = getDb();
  const ch  = db.prepare('SELECT epg_id FROM channels WHERE id=?').get(req.params.id);
  if (!ch || !ch.epg_id) return res.json([]);

  const now  = Math.floor(Date.now() / 1000);
  const from = parseInt(req.query.from) || now - 1800;
  const to   = parseInt(req.query.to)   || now + 6 * 3600;

  const rows = db.prepare(
    'SELECT * FROM programs WHERE epg_id=? AND end_time>? AND start_time<? ORDER BY start_time'
  ).all(ch.epg_id, from, to);
  res.json(rows);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function _savePrograms(db, programs) {
  if (!programs.length) return;
  const epgIds = [...new Set(programs.map(p => p.epg_id))];
  const del    = db.prepare('DELETE FROM programs WHERE epg_id=?');
  const ins    = db.prepare(`
    INSERT OR REPLACE INTO programs
      (epg_id, title, description, category, start_time, end_time, episode, icon_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const id of epgIds) del.run(id);
    for (const p of programs) ins.run(p.epg_id, p.title, p.description, p.category, p.start_time, p.end_time, p.episode, p.icon_url);
  })();
}

module.exports = router;
module.exports._savePrograms = _savePrograms;
