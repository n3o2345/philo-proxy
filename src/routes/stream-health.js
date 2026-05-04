'use strict';

/**
 * Stream Health Monitor
 *
 * Tracks per-channel stream events persistently:
 *   - stream starts / stops
 *   - errors and failover events
 *   - viewer counts
 *   - uptime stats
 *
 * Data is written to stream_events and stream_stats tables.
 * In-memory session map for concurrent viewer tracking.
 */

const express    = require('express');
const router     = express.Router();
const { getDb }  = require('../db');

// In-memory: Map<channelId, Set<sessionId>>
const _activeSessions = new Map();

// ── Session tracking API (called by stream route) ─────────────────────────────

function sessionStart(channelId, sessionId, meta = {}) {
  if (!_activeSessions.has(channelId)) _activeSessions.set(channelId, new Set());
  _activeSessions.get(channelId).add(sessionId);

  try {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO stream_events (channel_id, session_id, event, detail, ts)
      VALUES (?, ?, 'start', ?, datetime('now'))
    `).run(channelId, sessionId, JSON.stringify(meta));

    // Update stats
    db.prepare(`
      INSERT INTO stream_stats (channel_id, date, starts)
      VALUES (?, date('now'), 1)
      ON CONFLICT(channel_id, date) DO UPDATE SET starts = starts + 1
    `).run(channelId);
  } catch (err) {
    console.warn('[health] sessionStart error:', err.message);
  }
}

function sessionStop(channelId, sessionId, meta = {}) {
  if (_activeSessions.has(channelId)) {
    _activeSessions.get(channelId).delete(sessionId);
  }

  try {
    const db       = getDb();
    const startRow = db.prepare(
      "SELECT ts FROM stream_events WHERE channel_id=? AND session_id=? AND event='start' ORDER BY ts DESC LIMIT 1"
    ).get(channelId, sessionId);

    let durationSec = null;
    if (startRow) {
      durationSec = Math.round((Date.now() - new Date(startRow.ts + 'Z').getTime()) / 1000);
    }

    db.prepare(`
      INSERT INTO stream_events (channel_id, session_id, event, detail, ts)
      VALUES (?, ?, 'stop', ?, datetime('now'))
    `).run(channelId, sessionId, JSON.stringify({ ...meta, duration_sec: durationSec }));

    if (durationSec != null) {
      db.prepare(`
        INSERT INTO stream_stats (channel_id, date, watch_seconds)
        VALUES (?, date('now'), ?)
        ON CONFLICT(channel_id, date) DO UPDATE SET watch_seconds = watch_seconds + ?
      `).run(channelId, durationSec, durationSec);
    }
  } catch (err) {
    console.warn('[health] sessionStop error:', err.message);
  }
}

function sessionError(channelId, sessionId, errorMsg) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO stream_events (channel_id, session_id, event, detail, ts)
      VALUES (?, ?, 'error', ?, datetime('now'))
    `).run(channelId, sessionId || 'unknown', JSON.stringify({ error: errorMsg }));

    db.prepare(`
      INSERT INTO stream_stats (channel_id, date, errors)
      VALUES (?, date('now'), 1)
      ON CONFLICT(channel_id, date) DO UPDATE SET errors = errors + 1
    `).run(channelId);
  } catch (err) {
    console.warn('[health] sessionError error:', err.message);
  }
}

function sessionFailover(channelId, fromMemberIdx, toMemberIdx) {
  try {
    getDb().prepare(`
      INSERT INTO stream_events (channel_id, session_id, event, detail, ts)
      VALUES (?, 'map', 'failover', ?, datetime('now'))
    `).run(channelId, JSON.stringify({ from: fromMemberIdx, to: toMemberIdx }));
  } catch (err) {
    console.warn('[health] sessionFailover error:', err.message);
  }
}

function getActiveViewers(channelId) {
  if (channelId) return _activeSessions.get(channelId)?.size || 0;
  let total = 0;
  for (const s of _activeSessions.values()) total += s.size;
  return total;
}

function getAllActiveChannels() {
  const result = [];
  for (const [chId, sessions] of _activeSessions) {
    if (sessions.size > 0) result.push({ channel_id: chId, viewers: sessions.size });
  }
  return result;
}

// ── HTTP Routes ───────────────────────────────────────────────────────────────

// GET /api/stream-health/active -- currently active streams
router.get('/active', (req, res) => {
  const db       = getDb();
  const active   = getAllActiveChannels();
  const total    = active.reduce((s, a) => s + a.viewers, 0);

  // Enrich with channel names
  const enriched = active.map(a => {
    const ch = db.prepare('SELECT name, source_id FROM channels WHERE id=?').get(a.channel_id);
    return { ...a, channel_name: ch?.name || `Channel ${a.channel_id}` };
  });

  res.json({ active_streams: total, channels: enriched });
});

// GET /api/stream-health/stats?channel_id=&days=7
router.get('/stats', (req, res) => {
  const db      = getDb();
  const days    = Math.min(90, parseInt(req.query.days) || 7);
  const chFilter = req.query.channel_id;

  let sql = `
    SELECT ss.channel_id, ch.name AS channel_name,
           ss.date, ss.starts, ss.errors, ss.watch_seconds
    FROM   stream_stats ss
    LEFT   JOIN channels ch ON ch.id = ss.channel_id
    WHERE  ss.date >= date('now', ? || ' days')
  `;
  const params = [`-${days}`];
  if (chFilter) { sql += ' AND ss.channel_id=?'; params.push(chFilter); }
  sql += ' ORDER BY ss.date DESC, ss.starts DESC';

  res.json(db.prepare(sql).all(...params));
});

// GET /api/stream-health/events?channel_id=&limit=100
router.get('/events', (req, res) => {
  const db      = getDb();
  const limit   = Math.min(500, parseInt(req.query.limit) || 100);
  const chFilter = req.query.channel_id;

  let sql = `
    SELECT se.*, ch.name AS channel_name
    FROM   stream_events se
    LEFT   JOIN channels ch ON ch.id = se.channel_id
  `;
  const params = [];
  if (chFilter) { sql += ' WHERE se.channel_id=?'; params.push(chFilter); }
  sql += ' ORDER BY se.id DESC LIMIT ?';
  params.push(limit);

  res.json(db.prepare(sql).all(...params));
});

// GET /api/stream-health/top-channels?days=7&limit=10
router.get('/top-channels', (req, res) => {
  const db    = getDb();
  const days  = Math.min(90, parseInt(req.query.days) || 7);
  const limit = Math.min(50, parseInt(req.query.limit) || 10);

  const rows = db.prepare(`
    SELECT ss.channel_id, ch.name AS channel_name,
           SUM(ss.starts) AS total_starts,
           SUM(ss.watch_seconds) AS total_watch_seconds,
           SUM(ss.errors) AS total_errors
    FROM   stream_stats ss
    LEFT   JOIN channels ch ON ch.id = ss.channel_id
    WHERE  ss.date >= date('now', ? || ' days')
    GROUP  BY ss.channel_id
    ORDER  BY total_starts DESC
    LIMIT  ?
  `).all(`-${days}`, limit);

  res.json(rows);
});

// DELETE /api/stream-health/events -- purge old events (keep last N days)
router.delete('/events', (req, res) => {
  const days = Math.max(1, parseInt(req.query.keep_days) || 30);
  const db   = getDb();
  const info = db.prepare("DELETE FROM stream_events WHERE ts < datetime('now', ? || ' days')").run(`-${days}`);
  res.json({ ok: true, deleted: info.changes });
});

module.exports = router;
module.exports.sessionStart    = sessionStart;
module.exports.sessionStop     = sessionStop;
module.exports.sessionError    = sessionError;
module.exports.sessionFailover = sessionFailover;
module.exports.getActiveViewers = getActiveViewers;
module.exports.getAllActiveChannels = getAllActiveChannels;
