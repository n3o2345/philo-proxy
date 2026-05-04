'use strict';

const express  = require('express');
const router   = express.Router();
const { getDb } = require('../db');

// GET /api/channels  - optionally filter by ?source_id=&group=&enabled=
router.get('/', (req, res) => {
  const db = getDb();
  let sql  = 'SELECT * FROM channels WHERE 1=1';
  const params = [];

  if (req.query.source_id) { sql += ' AND source_id=?'; params.push(req.query.source_id); }
  if (req.query.group)     { sql += ' AND group_name=?'; params.push(req.query.group); }
  if (req.query.enabled !== undefined) { sql += ' AND enabled=?'; params.push(req.query.enabled === '1' || req.query.enabled === 'true' ? 1 : 0); }

  sql += ' ORDER BY sort_order ASC, id ASC';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/channels/groups - distinct group names
router.get('/groups', (req, res) => {
  const rows = getDb()
    .prepare("SELECT DISTINCT group_name FROM channels WHERE group_name IS NOT NULL AND enabled=1 ORDER BY group_name")
    .all();
  res.json(rows.map(r => r.group_name));
});

// GET /api/channels/:id
router.get('/:id', (req, res) => {
  const row = getDb().prepare('SELECT * FROM channels WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// PUT /api/channels/:id - patch name/number/logo/epg_id/enabled/sort_order
router.put('/:id', (req, res) => {
  const { name, number, logo_url, epg_id, group_name, enabled, sort_order } = req.body;
  getDb().prepare(`
    UPDATE channels SET
      name       = COALESCE(?, name),
      number     = COALESCE(?, number),
      logo_url   = COALESCE(?, logo_url),
      epg_id     = COALESCE(?, epg_id),
      group_name = COALESCE(?, group_name),
      enabled    = COALESCE(?, enabled),
      sort_order = COALESCE(?, sort_order)
    WHERE id = ?
  `).run(
    name       ?? null,
    number     ?? null,
    logo_url   ?? null,
    epg_id     ?? null,
    group_name ?? null,
    enabled    ?? null,
    sort_order ?? null,
    req.params.id
  );
  res.json({ ok: true });
});

// DELETE /api/channels/:id
router.delete('/:id', (req, res) => {
  getDb().prepare('DELETE FROM channels WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/channels/:id/toggle
router.post('/:id/toggle', (req, res) => {
  const ch = getDb().prepare('SELECT enabled FROM channels WHERE id=?').get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  getDb().prepare('UPDATE channels SET enabled=? WHERE id=?').run(ch.enabled ? 0 : 1, req.params.id);
  res.json({ ok: true, enabled: ch.enabled ? 0 : 1 });
});

module.exports = router;
