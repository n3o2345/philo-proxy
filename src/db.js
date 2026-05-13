'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_PATH = process.env.DB_PATH || path.join('/data', 'philoproxy.db');

// Ensure data directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      type          TEXT    NOT NULL,
      config        TEXT    NOT NULL DEFAULT '{}',
      enabled       INTEGER NOT NULL DEFAULT 1,
      max_streams   INTEGER NOT NULL DEFAULT 0,
      epg_source_id INTEGER REFERENCES epg_sources(id) ON DELETE SET NULL,
      color         TEXT,
      last_sync     TEXT,
      created       TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channels (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id    INTEGER REFERENCES sources(id) ON DELETE CASCADE,
      number       TEXT,
      name         TEXT    NOT NULL,
      logo_url     TEXT,
      stream_url   TEXT    NOT NULL,
      stream_type  TEXT    NOT NULL DEFAULT 'hls',
      group_name   TEXT,
      epg_id       TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS epg_sources (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      url           TEXT NOT NULL,
      last_fetch    TEXT,
      refresh_hours INTEGER NOT NULL DEFAULT 6,
      created       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS programs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      epg_id      TEXT    NOT NULL,
      title       TEXT    NOT NULL,
      description TEXT,
      category    TEXT,
      start_time  INTEGER NOT NULL,
      end_time    INTEGER NOT NULL,
      episode     TEXT,
      icon_url    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_programs_epg_time
      ON programs(epg_id, start_time, end_time);

    CREATE INDEX IF NOT EXISTS idx_channels_source
      ON channels(source_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS channel_maps (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      number      TEXT,
      logo_url    TEXT,
      epg_id      TEXT,
      group_name  TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channel_map_members (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      map_id     INTEGER NOT NULL REFERENCES channel_maps(id) ON DELETE CASCADE,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      priority   INTEGER NOT NULL DEFAULT 0,
      UNIQUE(map_id, channel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_map_members_map
      ON channel_map_members(map_id, priority);

    -- ── Users (multi-user auth) ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL DEFAULT 'viewer',
      token         TEXT    NOT NULL UNIQUE,
      enabled       INTEGER NOT NULL DEFAULT 1,
      last_login    TEXT,
      created       TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Transcode profiles ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS transcode_profiles (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL UNIQUE,
      video_codec   TEXT    NOT NULL DEFAULT 'copy',
      audio_codec   TEXT    NOT NULL DEFAULT 'copy',
      video_bitrate TEXT,
      audio_bitrate TEXT,
      resolution    TEXT,
      extra_args    TEXT    NOT NULL DEFAULT '',
      description   TEXT    NOT NULL DEFAULT '',
      created       TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Webhooks ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS webhooks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      url         TEXT    NOT NULL,
      events      TEXT    NOT NULL DEFAULT '*',
      secret      TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      last_fired  TEXT,
      last_status INTEGER,
      created     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Stream health events ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS stream_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER,
      session_id TEXT,
      event      TEXT    NOT NULL,
      detail     TEXT,
      ts         TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_stream_events_channel
      ON stream_events(channel_id, ts);

    -- ── Stream stats (aggregated per day) ───────────────────────────────────
    CREATE TABLE IF NOT EXISTS stream_stats (
      channel_id    INTEGER NOT NULL,
      date          TEXT    NOT NULL,
      starts        INTEGER NOT NULL DEFAULT 0,
      errors        INTEGER NOT NULL DEFAULT 0,
      watch_seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (channel_id, date)
    );
  `);

  console.log('[db] Philoproxy database initialized at', DB_PATH);
  return db;
}

// ── Migration: drop the old hardcoded type CHECK constraint if present ────────
// The new schema accepts any plugin-registered type without a DB-level CHECK.
(function migrateDropTypeCheck() {
  try {
    const db = getDb();
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sources'").get();
    if (!tableInfo || !tableInfo.sql.includes('CHECK')) return; // already migrated or fresh

    console.log('[migration] Dropping hardcoded type CHECK from sources table...');

    db.prepare(`CREATE TABLE sources_new (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT    NOT NULL,
      type      TEXT    NOT NULL,
      config    TEXT    NOT NULL DEFAULT '{}',
      enabled   INTEGER NOT NULL DEFAULT 1,
      last_sync TEXT,
      created   TEXT    NOT NULL DEFAULT (datetime('now'))
    )`).run();

    const rows = db.prepare('SELECT * FROM sources').all();
    const ins  = db.prepare('INSERT INTO sources_new (id,name,type,config,enabled,last_sync,created) VALUES (?,?,?,?,?,?,?)');
    db.transaction(() => {
      for (const r of rows) ins.run(r.id, r.name, r.type, r.config, r.enabled ?? 1, r.last_sync ?? null, r.created ?? new Date().toISOString());
    })();

    db.prepare('DROP TABLE sources').run();
    db.prepare('ALTER TABLE sources_new RENAME TO sources').run();
    console.log('[migration] sources type CHECK removed - plugin types are now open');
  } catch (err) {
    console.warn('[migration] type CHECK migration error:', err.message);
    try { getDb().prepare('DROP TABLE IF EXISTS sources_new').run(); } catch (_) {}
  }
})();

// ── Migration: fix HTML entities in existing channel/program names ────────────
(function migrateHtmlEntities() {
  try {
    const db = getDb();
    function htmlDecode(str) {
      if (!str || !str.includes('&')) return str;
      return str.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
                .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'")
                .replace(/&#(\d+);/g, (_,n) => String.fromCharCode(parseInt(n,10)));
    }
    const channels = db.prepare("SELECT id, name, epg_id FROM channels WHERE name LIKE '%&%' OR epg_id LIKE '%&%'").all()
      .filter(c => c.name !== htmlDecode(c.name) || (c.epg_id && c.epg_id !== htmlDecode(c.epg_id)));
    if (channels.length) {
      const upd = db.prepare('UPDATE channels SET name=?, epg_id=? WHERE id=?');
      db.transaction(chs => { for (const c of chs) upd.run(htmlDecode(c.name), htmlDecode(c.epg_id), c.id); })(channels);
      console.log(`[migration] Fixed HTML entities in ${channels.length} channel names`);
    }
    const progs = db.prepare("SELECT id, title, description FROM programs WHERE title LIKE '%&amp;%' OR title LIKE '%&lt;%'").all();
    if (progs.length) {
      const upd2 = db.prepare('UPDATE programs SET title=?, description=? WHERE id=?');
      db.transaction(ps => { for (const p of ps) upd2.run(htmlDecode(p.title), htmlDecode(p.description), p.id); })(progs);
      console.log(`[migration] Fixed HTML entities in ${progs.length} program titles`);
    }
  } catch (err) { console.warn('[migration] HTML entity fix error:', err.message); }
})();

// ── Migration: add max_streams, epg_source_id, color to sources ──────────────
(function migrateSourceColumns() {
  try {
    const db = getDb();
    const info = db.prepare("PRAGMA table_info(sources)").all();
    const cols = info.map(c => c.name);
    if (!cols.includes('max_streams'))
      db.prepare("ALTER TABLE sources ADD COLUMN max_streams INTEGER NOT NULL DEFAULT 0").run();
    if (!cols.includes('epg_source_id'))
      db.prepare("ALTER TABLE sources ADD COLUMN epg_source_id INTEGER REFERENCES epg_sources(id) ON DELETE SET NULL").run();
      // Add refresh_hours to epg_sources if missing
      try { db.prepare("ALTER TABLE epg_sources ADD COLUMN refresh_hours INTEGER NOT NULL DEFAULT 6").run(); } catch(_) {}
    if (!cols.includes('color'))
      db.prepare("ALTER TABLE sources ADD COLUMN color TEXT").run();
  } catch (err) { console.warn('[migration] source columns error:', err.message); }
})();

// ── Migration: add transcode_profile_id to channels and sources ───────────────
(function migrateTranscodeProfile() {
  try {
    const db = getDb();
    const chInfo  = db.prepare('PRAGMA table_info(channels)').all().map(c => c.name);
    const srcInfo = db.prepare('PRAGMA table_info(sources)').all().map(c => c.name);
    if (!chInfo.includes('transcode_profile_id'))
      db.prepare('ALTER TABLE channels ADD COLUMN transcode_profile_id INTEGER REFERENCES transcode_profiles(id) ON DELETE SET NULL').run();
    if (!srcInfo.includes('transcode_profile_id'))
      db.prepare('ALTER TABLE sources ADD COLUMN transcode_profile_id INTEGER REFERENCES transcode_profiles(id) ON DELETE SET NULL').run();
  } catch (err) { console.warn('[migration] transcode_profile_id error:', err.message); }
})();

module.exports = { getDb, initDb };

// -- Migration: add market_type and market_name to channel_maps ----------------
(function migrateMarketFields() {
  try {
    const db   = getDb();
    const cols = db.prepare('PRAGMA table_info(channel_maps)').all().map(c => c.name);
    if (!cols.includes('market_type'))
      db.prepare("ALTER TABLE channel_maps ADD COLUMN market_type TEXT").run();
    if (!cols.includes('market_name'))
      db.prepare("ALTER TABLE channel_maps ADD COLUMN market_name TEXT").run();
  } catch (err) { console.warn('[migration] market fields error:', err.message); }
})();
