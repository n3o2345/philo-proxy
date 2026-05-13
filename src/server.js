'use strict';

const express  = require('express');
const path     = require('path');
const cors     = require('cors');
const morgan   = require('morgan');
const { initDb } = require('./db');
const plugins    = require('./plugins');

const app  = express();
const PORT = process.env.PORT || 5050;

// ── In-memory log ring buffer ─────────────────────────────────────────────────
const LOG_MAX   = 500;
const logBuffer = [];

function addLog(level, message) {
  logBuffer.unshift({ time: new Date().toISOString(), level, message });
  if (logBuffer.length > LOG_MAX) logBuffer.pop();
}

const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);
console.log   = (...a) => { const m = a.join(' '); addLog('INFO',  m); _origLog(m); };
console.warn  = (...a) => { const m = a.join(' '); addLog('WARN',  m); _origWarn(m); };
console.error = (...a) => { const m = a.join(' '); addLog('ERROR', m); _origError(m); };
global._logBuffer = logBuffer;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────────────
initDb();

// ── Plugin routers (Philo → /api/philo/*) ────────────────────────────────────
for (const plugin of plugins.all()) {
  if (plugin.router) {
    app.use(`/api/${plugin.type}`, plugin.router);
    console.log(`[plugins] Mounted /api/${plugin.type}`);
  }
}

// ── Plugin metadata ───────────────────────────────────────────────────────────
app.get('/api/sources/plugin-types', (_req, res) => {
  res.json(plugins.all().map(p => ({
    type:        p.type,
    displayName: p.displayName,
    icon:        p.icon,
    description: p.description,
    configFields: p.configFields || [],
    hasEpg:      typeof p.refreshEpg === 'function',
  })));
});

// ── Per-source manual EPG refresh ─────────────────────────────────────────────
app.post('/api/sources/:id/refresh-epg', async (req, res) => {
  try {
    const db     = require('./db').getDb();
    const source = db.prepare('SELECT * FROM sources WHERE id=?').get(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    const plugin = plugins.get(source.type);
    if (!plugin?.refreshEpg) return res.status(400).json({ error: 'Plugin has no EPG refresh' });
    await plugin.refreshEpg(source, db);
    const count = db.prepare(
      'SELECT COUNT(*) AS n FROM programs WHERE epg_id IN (SELECT epg_id FROM channels WHERE source_id=?)'
    ).get(source.id);
    res.json({ ok: true, programs: count?.n ?? 0 });
  } catch (err) {
    console.error(`[epg-manual] error (id=${req.params.id}): ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Core routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',               require('./routes/auth').router);
app.use('/api/sources',            require('./routes/sources'));
app.use('/api/channels',           require('./routes/channels'));
app.use('/api/epg',                require('./routes/epg'));
app.use('/api/transcode-profiles', require('./routes/transcode-profiles'));
app.use('/api/stream-health',      require('./routes/stream-health'));
app.use('/stream',                 require('./routes/stream'));
app.use('/',                       require('./routes/export'));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── System resource endpoint ──────────────────────────────────────────────────
app.get('/api/system', async (_req, res) => {
  const { execSync } = require('child_process');
  const osMod = require('os');
  const total = osMod.totalmem(), free = osMod.freemem(), used = total - free;
  const load  = osMod.loadavg();

  let gpu = null;
  try {
    const out = execSync(
      'nvidia-smi --query-gpu=name,utilization.gpu,utilization.encoder,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
      { timeout: 3000 }
    ).toString().trim();
    const p = out.split(',').map(s => s.trim());
    if (p.length >= 6) gpu = { name: p[0], gpuPct: p[1], encPct: p[2], memUsedMb: p[3], memTotalMb: p[4], tempC: p[5] };
  } catch (_) {}

  res.json({
    memory: { totalMb: Math.round(total/1024/1024), usedMb: Math.round(used/1024/1024), freeMb: Math.round(free/1024/1024), pct: Math.round(used/total*100) },
    cpu:    { cores: osMod.cpus().length, load1: load[0].toFixed(2), load5: load[1].toFixed(2), load15: load[2].toFixed(2) },
    uptime: Math.round(process.uptime()),
    gpu,
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/api/settings', (_req, res) => {
  const db = require('./db').getDb();
  const obj = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) obj[r.key] = r.value;
  res.json(obj);
});

app.post('/api/settings', (req, res) => {
  const db   = require('./db').getDb();
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(entries => {
    for (const [k, v] of entries) stmt.run(k, String(v ?? ''));
  })(Object.entries(req.body || {}));
  res.json({ ok: true });
});

// ── Logs ──────────────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, LOG_MAX);
  res.json((global._logBuffer || []).slice(0, limit));
});

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Auto EPG refresh (Philo plugin EPG) ──────────────────────────────────────
// Fires every EPG_REFRESH_HOURS for all enabled Philo sources.
const EPG_REFRESH_HOURS = Math.max(1, parseInt(process.env.EPG_REFRESH_HOURS || '6'));

setInterval(async () => {
  try {
    const db   = require('./db').getDb();
    const srcs = db.prepare('SELECT * FROM sources WHERE enabled=1').all();
    for (const src of srcs) {
      const plugin = plugins.get(src.type);
      if (!plugin?.refreshEpg) continue;
      try { await plugin.refreshEpg(src, db); }
      catch (err) { console.warn(`[epg-auto] ${src.type} refresh failed (id=${src.id}): ${err.message}`); }
    }
  } catch (err) { console.warn('[epg-auto] error:', err.message); }
}, EPG_REFRESH_HOURS * 60 * 60 * 1000);

// Also handle XML-backed EPG sources (if any are configured)
const _epgTimers = new Map();

function _scheduleEpgSource(src) {
  if (_epgTimers.has(src.id)) clearInterval(_epgTimers.get(src.id));
  const hours = Math.max(1, src.refresh_hours || 6);
  const timer = setInterval(async () => {
    try {
      const db = require('./db').getDb();
      const { fetchXmltv } = require('./lib/xmltv');
      const { programs } = await fetchXmltv(src.url);
      if (programs.length) {
        const epgIds = [...new Set(programs.map(p => p.epg_id))];
        const del    = db.prepare('DELETE FROM programs WHERE epg_id=?');
        const stmt   = db.prepare(
          'INSERT OR REPLACE INTO programs (epg_id,title,description,category,start_time,end_time,episode,icon_url) VALUES (?,?,?,?,?,?,?,?)'
        );
        db.transaction(() => {
          for (const id of epgIds) del.run(id);
          for (const p of programs) stmt.run(p.epg_id, p.title, p.description, p.category, p.start_time, p.end_time, p.episode, p.icon_url);
        })();
        db.prepare(`UPDATE epg_sources SET last_fetch=datetime('now') WHERE id=?`).run(src.id);
        console.log(`[epg-auto] Refreshed ${programs.length} programs from "${src.name}"`);
      }
    } catch (err) { console.warn(`[epg-auto] Failed to refresh "${src.name}": ${err.message}`); }
  }, hours * 60 * 60 * 1000);
  _epgTimers.set(src.id, timer);
  console.log(`[epg-auto] Scheduled "${src.name}" every ${hours}h`);
}

// Bootstrap EPG sources on startup
;(function _bootstrapEpg() {
  try {
    const db = require('./db').getDb();
    for (const src of db.prepare('SELECT * FROM epg_sources').all()) _scheduleEpgSource(src);
    console.log(`[epg-auto] Scheduled ${_epgTimers.size} external EPG source(s); Philo plugin EPG every ${EPG_REFRESH_HOURS}h`);
  } catch (err) { console.warn('[epg-auto] Bootstrap error:', err.message); }
})();

app.post('/api/epg/sources/:id/reschedule', (req, res) => {
  const src = require('./db').getDb().prepare('SELECT * FROM epg_sources WHERE id=?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'Not found' });
  _scheduleEpgSource(src);
  res.json({ ok: true, refresh_hours: src.refresh_hours });
});

// ── Channel lineup auto-sync ──────────────────────────────────────────────────
let _syncTimer = null;

function _getSyncHours() {
  try {
    const row = require('./db').getDb().prepare("SELECT value FROM settings WHERE key='sync_refresh_hours'").get();
    return Math.max(1, parseInt(row?.value || '12', 10));
  } catch (_) { return 12; }
}

async function _runLineupSync() {
  const { syncSource } = require('./routes/sources');
  const db = require('./db').getDb();
  const srcs = db.prepare('SELECT * FROM sources WHERE enabled=1').all();
  console.log(`[sync-auto] Syncing lineup for ${srcs.length} source(s)…`);
  for (const src of srcs) {
    try {
      const config = JSON.parse(src.config || '{}');
      const chs    = await syncSource(src.id, src.type, config);
      db.prepare("UPDATE sources SET last_sync=datetime('now') WHERE id=?").run(src.id);
      console.log(`[sync-auto] ${src.name}: ${chs.length} channels`);
    } catch (err) { console.warn(`[sync-auto] ${src.name} failed: ${err.message}`); }
  }
}

function _scheduleLineupSync() {
  if (_syncTimer) clearInterval(_syncTimer);
  const hours = _getSyncHours();
  _syncTimer = setInterval(_runLineupSync, hours * 60 * 60 * 1000);
  console.log(`[sync-auto] Lineup sync every ${hours}h`);
}
_scheduleLineupSync();

app.post('/api/settings/apply', (_req, res) => {
  _scheduleLineupSync();
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Philoproxy => http://0.0.0.0:${PORT}\n`);
});
