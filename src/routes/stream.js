'use strict';

/**
 * stream.js — Philo x11grab HLS pipeline
 *
 * Serves Philo (Widevine DRM) channels via:
 *   Chromium/Playwright (non-headless, Xvfb) → x11grab → FFmpeg → HLS segments
 *
 * Endpoints:
 *   GET  /stream/:channelId              → philo.m3u8 (auto-detected)
 *   GET  /stream/:channelId/philo.m3u8   → HLS manifest (segment URLs rewritten)
 *   GET  /stream/:channelId/philo-seg/:f → serve an HLS segment file
 *   GET  /stream/:channelId/health       → per-stream diagnostics
 *   GET  /stream/status                  → all active sessions
 *   POST /stream/:channelId/restart      → seamless restart (keeps display/PA)
 *   POST /stream/reprobe-nvenc           → re-probe NVENC availability
 *   DELETE /stream/:channelId            → stop session and release resources
 */

const express   = require('express');
const { spawn, execSync } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const router    = express.Router();
const { getDb } = require('../db');
const {
  navigateToChannel,
  releaseStreamBrowser,
  _createPulseSink,
  _destroyPulseSink,
} = require('./philo');

require('events').EventEmitter.defaultMaxListeners = 50;

// ── Config ────────────────────────────────────────────────────────────────────
const MAX_PHILO_STREAMS   = parseInt(process.env.MAX_PHILO_STREAMS || '3');
const SESSION_IDLE_TTL    = 5 * 60 * 1000;   // 5 min idle → kill
const BASE_STREAM_DISPLAY = parseInt(process.env.BASE_STREAM_DISPLAY || '201');
const STARTUP_MANIFEST_WAIT_MS = parseInt(process.env.STARTUP_MANIFEST_WAIT_MS || '2500', 10);
const LOW_LATENCY_HLS     = ['1', 'true', 'yes', 'on']
  .includes(String(process.env.LOW_LATENCY_HLS || '').toLowerCase());

// ── Display pool ──────────────────────────────────────────────────────────────
// Each concurrent Philo session gets its own isolated Xvfb display so
// Chromium instances never share a screen and can run simultaneously.

const _philoDisplayPool = new Map(); // displayNum → channelId | null

function _acquirePhiloDisplay(channelId) {
  for (const [num, cid] of _philoDisplayPool) {
    if (cid === channelId) return `:${num}`;
  }
  for (let i = 0; i < MAX_PHILO_STREAMS; i++) {
    const num = BASE_STREAM_DISPLAY + i;
    if (!_philoDisplayPool.has(num) || _philoDisplayPool.get(num) === null) {
      _philoDisplayPool.set(num, channelId);
      return `:${num}`;
    }
  }
  return null; // all slots full
}

function _releasePhiloDisplay(channelId) {
  for (const [num, cid] of _philoDisplayPool) {
    if (cid === channelId) { _philoDisplayPool.set(num, null); return; }
  }
}

// ── Xvfb ─────────────────────────────────────────────────────────────────────

async function _ensureXvfb(display) {
  try {
    execSync(`xdpyinfo -display ${display}`, {
      stdio: 'ignore', timeout: 1000,
      env: { ...process.env, DISPLAY: display },
    });
    return; // already running
  } catch (_) {}

  const num = display.replace(':', '');
  try { fs.unlinkSync(`/tmp/.X${num}-lock`); }    catch (_) {}
  try { fs.unlinkSync(`/tmp/.X11-unix/X${num}`); } catch (_) {}

  const xvfb = spawn('Xvfb', [
    display,
    '-screen', '0', '1280x720x24',
    '-ac', '+extension', 'GLX', '+render', '-noreset',
  ], { stdio: 'ignore', detached: true });
  xvfb.unref();

  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      execSync(`xdpyinfo -display ${display}`, {
        stdio: 'ignore', timeout: 500,
        env: { ...process.env, DISPLAY: display },
      });
      console.log(`[stream] Xvfb ready on ${display} (${(i + 1) * 250}ms)`);
      return;
    } catch (_) {}
  }
  console.warn(`[stream] Xvfb ${display} not confirmed ready after 10s — continuing`);
}

// ── NVENC probe ───────────────────────────────────────────────────────────────
// Runs once at startup (with 5s delay to let the NVIDIA runtime load).
// All FFmpeg spawn paths call awaitNvenc() so they never race the probe.

let _nvencAvailable    = null;
let _nvencProbePromise = null;

function hasNvenc() { return _nvencAvailable === true; }

async function awaitNvenc() {
  if (_nvencAvailable !== null) return _nvencAvailable;
  if (_nvencProbePromise) return _nvencProbePromise;
  _nvencProbePromise = _probeNvenc();
  return _nvencProbePromise;
}

async function _probeNvenc() {
  if (_nvencAvailable !== null) return _nvencAvailable;
  try {
    const enc = execSync('ffmpeg -hide_banner -encoders 2>&1', { timeout: 5000, stdio: 'pipe' }).toString();
    if (!enc.includes('h264_nvenc')) {
      _nvencAvailable = false;
      console.log('[stream] NVENC: h264_nvenc not compiled in — using x264');
      return false;
    }
  } catch (_) {}

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      execSync(
        'ffmpeg -hide_banner -loglevel error -f lavfi -i color=black:s=1280x720:r=1 -frames:v 1 -c:v h264_nvenc -f null -',
        { timeout: 15000, stdio: 'pipe' }
      );
      _nvencAvailable = true;
      console.log(`[stream] NVENC: available ✓ (attempt ${attempt})`);
      return true;
    } catch (_) {
      if (attempt < 5) {
        const delay = attempt * 3000;
        console.log(`[stream] NVENC: probe attempt ${attempt} failed — retrying in ${delay / 1000}s`);
        await sleep(delay);
      }
    }
  }
  _nvencAvailable = false;
  console.log('[stream] NVENC: not available after 5 attempts — using x264');
  return false;
}

setTimeout(() => awaitNvenc(), 5000);

// ── HLS tuning ────────────────────────────────────────────────────────────────

function getHlsTuning(lowLatency = LOW_LATENCY_HLS) {
  return lowLatency
    ? { hlsTime: '1', hlsListSize: '3', hlsFlags: 'delete_segments+append_list+omit_endlist+split_by_time+program_date_time' }
    : { hlsTime: '2', hlsListSize: '5', hlsFlags: 'delete_segments+append_list+omit_endlist+split_by_time' };
}

function getSessionTelemetry(hlsDir, startedAt) {
  try {
    const files    = fs.readdirSync(hlsDir);
    const segments = files.filter(f => f.endsWith('.ts'));
    const newest   = segments.length
      ? Math.max(...segments.map(s => fs.statSync(path.join(hlsDir, s)).mtimeMs))
      : null;
    return {
      startup_ms:    startedAt ? Date.now() - startedAt : null,
      segment_count: segments.length,
      segment_age_ms: newest ? Math.max(0, Math.round(Date.now() - newest)) : null,
    };
  } catch (_) {
    return { startup_ms: null, segment_count: 0, segment_age_ms: null };
  }
}

function _setHlsHeaders(res) {
  res.setHeader('Content-Type',  'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

function _sendWarmingManifest(channelId, session, res) {
  const hls = getHlsTuning();
  const elapsed = session.startedAt ? Math.round((Date.now() - session.startedAt) / 1000) : 0;
  _setHlsHeaders(res);
  res.setHeader('X-Philoproxy-State', 'warming');
  res.send([
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${hls.hlsTime}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-PROGRAM-DATE-TIME:${new Date().toISOString()}`,
    `#EXT-X-SESSION-DATA:DATA-ID="com.Philoproxy.state",VALUE="warming-${channelId}-${elapsed}s"`,
    '',
  ].join('\n'));
}

// ── Philo sessions ────────────────────────────────────────────────────────────
// key: channelId → { hlsDir, clients: Set, lastAccess, startedAt,
//                    _ffmpeg, _page, _context, _display, _pulseSink }

const philoSessions = {};

// Idle cleanup — runs every 15 s
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of Object.entries(philoSessions)) {
    if (now - s.lastAccess > SESSION_IDLE_TTL) {
      console.log(`[stream] expiring idle Philo session ch${id}`);
      _destroyPhiloSession(id, s);
    }
  }
}, 15000);

function _destroyPhiloSession(id, s) {
  if (s._ffmpeg)   { try { s._ffmpeg.kill('SIGTERM'); }     catch (_) {} }
  if (s._page)     s._page.close().catch(() => {});
  if (s._context)  s._context.close().catch(() => {});
  if (s._display)  { releaseStreamBrowser(s._display).catch(() => {}); _releasePhiloDisplay(id); }
  if (s._pulseSink) _destroyPulseSink(id);
  delete philoSessions[id];
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /stream/reprobe-nvenc
router.post('/reprobe-nvenc', async (req, res) => {
  _nvencAvailable    = null;
  _nvencProbePromise = null;
  const result = await awaitNvenc();
  res.json({ nvenc: result, encoder: result ? 'NVENC' : 'x264' });
});

// GET /stream/status — must be registered before the /:channelId wildcard
router.get('/status', (req, res) => {
  const db = getDb();
  const streams = Object.entries(philoSessions).map(([id, s], idx) => {
    const ch = db.prepare('SELECT name FROM channels WHERE id=?').get(id);
    const t  = getSessionTelemetry(s.hlsDir, s.startedAt || s.lastAccess);
    return {
      channelId:    id,
      name:         ch ? ch.name : `Channel ${id}`,
      tuner:        idx + 1,
      clients:      s.clients.size,
      type:         'philo',
      encoder:      hasNvenc() ? 'NVENC' : 'x264',
      ffmpegAlive:  s._ffmpeg ? s._ffmpeg.exitCode === null : false,
      ready:        !!s._ffmpeg,
      startup_ms:   t.startup_ms,
      segment_age_ms: t.segment_age_ms,
      segment_count:  t.segment_count,
    };
  });
  res.json({
    philo_cap:  MAX_PHILO_STREAMS,
    philo_used: Object.keys(philoSessions).length,
    nvenc:      hasNvenc(),
    encoder:    hasNvenc() ? 'NVENC' : 'x264',
    low_latency_hls: LOW_LATENCY_HLS,
    streams,
  });
});

// GET /stream/:channelId — entry point; all Philo channels served inline
router.get('/:channelId', async (req, res) => {
  const channel = getDb().prepare('SELECT * FROM channels WHERE id=?').get(req.params.channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  return _handlePhiloM3u8Request(String(channel.id), channel, req, res);
});

// GET /stream/:channelId/philo.m3u8 — explicit Philo HLS manifest
router.get('/:channelId/philo.m3u8', async (req, res) => {
  const channel = getDb().prepare('SELECT * FROM channels WHERE id=?').get(req.params.channelId);
  if (!channel) return res.status(404).send('Not found');
  return _handlePhiloM3u8Request(req.params.channelId, channel, req, res);
});

async function _handlePhiloM3u8Request(channelId, channel, req, res) {
  const source = getDb().prepare('SELECT config FROM sources WHERE id=?').get(channel.source_id);
  const config = source ? JSON.parse(source.config) : {};
  if (!config.cookies) {
    return res.status(401).send('Philo not authenticated — use Re-authenticate in Sources');
  }

  const allSessions    = Object.keys(philoSessions);
  const activeSessions = allSessions.filter(id => philoSessions[id].clients.size > 0);
  const isNew          = !philoSessions[channelId];

  if (isNew && allSessions.length >= MAX_PHILO_STREAMS) {
    const names = activeSessions.map(id => {
      const ch = getDb().prepare('SELECT name FROM channels WHERE id=?').get(id);
      return ch ? ch.name : id;
    }).join(', ') || 'none';
    return res.status(503).send(
      `Max ${MAX_PHILO_STREAMS} concurrent Philo streams reached. Active: ${names}`
    );
  }

  let session = philoSessions[channelId];
  if (!session || !session.hlsDir) {
    const philoChannelId = channel.stream_url.replace('philo://', '');
    const cfgCh          = (config.channels || []).find(c => c.id === philoChannelId);
    const broadcastId    = cfgCh?.broadcast_id || null;

    const hlsDir = path.join(os.tmpdir(), `philo_${channelId}`);
    if (!fs.existsSync(hlsDir)) fs.mkdirSync(hlsDir, { recursive: true });
    for (const f of fs.readdirSync(hlsDir)) {
      try { fs.unlinkSync(path.join(hlsDir, f)); } catch (_) {}
    }

    session = { hlsDir, clients: new Set(), lastAccess: Date.now(), startedAt: Date.now() };
    philoSessions[channelId] = session;
    console.log(`[stream] New Philo session ch${channelId} (${activeSessions.length + 1}/${MAX_PHILO_STREAMS})`);
    _startPhiloX11grab(channel, config, philoChannelId, broadcastId, channelId, session, hlsDir);
  }

  session.lastAccess = Date.now();

  // Browser startup can exceed short upstream proxy connect windows. Wait a
  // little for a real manifest, then return a valid live manifest immediately
  // so HLS-aware clients/proxies can keep polling instead of timing out.
  const hasSegments = () =>
    fs.existsSync(path.join(session.hlsDir, 'index.m3u8')) &&
    fs.readdirSync(session.hlsDir).some(f => f.endsWith('.ts'));

  if (!hasSegments()) {
    const deadline = Date.now() + Math.max(0, STARTUP_MANIFEST_WAIT_MS);
    while (!hasSegments() && Date.now() < deadline) {
      await sleep(250);
      session.lastAccess = Date.now();
    }
    if (!hasSegments()) {
      return _sendWarmingManifest(channelId, session, res);
    }
  }

  session.clients.add(res);
  res.on('close', () => {
    session.clients.delete(res);
    console.log(`[stream] Philo client left ch${channelId} (${session.clients.size} remaining)`);
  });

  try {
    const text  = fs.readFileSync(path.join(session.hlsDir, 'index.m3u8'), 'utf8');
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host  = req.headers['x-forwarded-host']  || req.get('host');
    const base  = `${proto}://${host}/stream/${channelId}/philo-seg/`;
    const out   = text.split('\n').map(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      return base + path.basename(t);
    }).join('\n');

    res.setHeader('Content-Type',  'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.send(out);
  } catch (err) {
    session.clients.delete(res);
    res.status(502).send('Failed to read manifest: ' + err.message);
  }
}

// GET /stream/:channelId/philo-seg/:segment — serve HLS segment files
router.get('/:channelId/philo-seg/:segment', (req, res) => {
  const session = philoSessions[req.params.channelId];
  if (!session || !session.hlsDir) return res.status(404).end();
  const segPath = path.join(session.hlsDir, req.params.segment);
  if (!fs.existsSync(segPath)) return res.status(404).end();
  session.lastAccess = Date.now();
  res.setHeader('Content-Type',  'video/MP2T');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.sendFile(segPath);
});

// GET /stream/:channelId/health — per-stream diagnostics
router.get('/:channelId/health', (req, res) => {
  const id      = req.params.channelId;
  const session = philoSessions[id];
  if (!session) {
    return res.status(404).json({
      error: 'No active stream',
      activeIds: Object.keys(philoSessions),
    });
  }
  const t = getSessionTelemetry(session.hlsDir, session.startedAt || session.lastAccess);
  res.json({
    channelId:    id,
    clients:      session.clients.size,
    ffmpegAlive:  session._ffmpeg ? session._ffmpeg.exitCode === null : false,
    display:      session._display || null,
    encoder:      hasNvenc() ? 'NVENC' : 'x264',
    idleSecs:     Math.round((Date.now() - session.lastAccess) / 1000),
    ...t,
  });
});

// POST /stream/:channelId/restart — seamless restart (reuses display/PulseAudio)
router.post('/:channelId/restart', async (req, res) => {
  const channelId = req.params.channelId;
  const session   = philoSessions[channelId];
  if (!session) return res.status(404).json({ error: 'No active stream' });

  const channel = getDb().prepare('SELECT * FROM channels WHERE id=?').get(channelId);
  const src     = channel ? getDb().prepare('SELECT config FROM sources WHERE id=?').get(channel.source_id) : null;
  if (!channel || !src) return res.status(404).json({ error: 'Channel not found' });

  const config = JSON.parse(src.config);
  if (!config.cookies) return res.status(401).json({ error: 'Not authenticated' });

  if (session._ffmpeg)  { try { session._ffmpeg.kill('SIGTERM'); } catch (_) {} }
  if (session._page)    session._page.close().catch(() => {});
  if (session._context) session._context.close().catch(() => {});
  if (session._display) releaseStreamBrowser(session._display).catch(() => {});
  session._ffmpeg = null; session._page = null; session._context = null; session._display = null;

  try {
    for (const f of fs.readdirSync(session.hlsDir)) fs.unlinkSync(path.join(session.hlsDir, f));
  } catch (_) {}

  const philoChannelId = channel.stream_url.replace('philo://', '');
  const cfgCh = (config.channels || []).find(c => c.id === philoChannelId);
  _startPhiloX11grab(channel, config, philoChannelId, cfgCh?.broadcast_id || null, channelId, session, session.hlsDir);

  res.json({ ok: true, message: `Restarting stream for ${channel.name}` });
});

// DELETE /stream/:channelId — stop session and release all resources
router.delete('/:channelId', (req, res) => {
  const id      = req.params.channelId;
  const session = philoSessions[id];
  if (session) _destroyPhiloSession(id, session);
  res.json({ ok: true });
});

// ── x11grab pipeline ──────────────────────────────────────────────────────────

async function _startPhiloX11grab(channel, config, philoChannelId, broadcastId, channelId, session, hlsDir) {
  const display = _acquirePhiloDisplay(channelId);
  if (!display) {
    console.error(`[stream] Philo ch${channelId}: no free display slots (max ${MAX_PHILO_STREAMS})`);
    delete philoSessions[channelId];
    return;
  }
  session._display = display;

  await _ensureXvfb(display);

  const pulseSink = await _createPulseSink(channelId);
  session._pulseSink = pulseSink;

  if (pulseSink) {
    const paServer = `unix:${pulseSink}`;
    let sinkReady  = false;
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      try {
        const out = execSync(`pactl --server=${paServer} list short sinks`, {
          stdio: 'pipe', timeout: 1000,
          env: { ...process.env, PULSE_SERVER: paServer },
        }).toString();
        if (out.includes('out')) { sinkReady = true; break; }
      } catch (_) {}
    }
    if (!sinkReady) console.warn(`[stream] Philo ch${channelId}: PA sink not ready after 6s — continuing`);
    else            console.log(`[stream] Philo ch${channelId}: PA sink confirmed ready`);
  }

  try {
    const result = await navigateToChannel(philoChannelId, config.cookies, broadcastId, display, pulseSink, config.storageState);
    session._page    = result.page;
    session._context = result.context;
    console.log(`[stream] Philo ch${channelId}: browser ready on ${display}`);
  } catch (err) {
    console.error(`[stream] Philo ch${channelId} nav error: ${err.message}`);
    _destroyPhiloSession(channelId, session);
    return;
  }

  _startPhiloFfmpegX11grab(display, pulseSink, channel.name, channelId, session, hlsDir);
}

async function _startPhiloFfmpegX11grab(display, pulseSink, channelName, channelId, session, hlsDir) {
  const hls      = getHlsTuning();
  const useNvenc = await awaitNvenc();
  const manifest = path.join(hlsDir, 'index.m3u8');
  const segPat   = path.join(hlsDir, 'seg%05d.ts');

  const videoArgs = useNvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-rc', 'cbr',
       '-b:v', '4M', '-maxrate', '4M', '-bufsize', '8M', '-pix_fmt', 'yuv420p',
       '-g', '30', '-keyint_min', '30', '-zerolatency', '1', '-fps_mode', 'cfr']
    : ['-c:v', 'libx264', '-preset', 'superfast', '-tune', 'zerolatency',
       '-b:v', '4M', '-maxrate', '6M', '-bufsize', '8M', '-pix_fmt', 'yuv420p',
       '-g', '30', '-keyint_min', '30', '-threads', '0', '-fps_mode', 'cfr',
       '-x264-params', 'nal-hrd=cbr:force-cfr=1'];

  const audioDevice = pulseSink ? 'out.monitor' : 'Philoproxy_out.monitor';

  const args = [
    '-hide_banner', '-loglevel', 'warning',
    // Capture video first so HLS clients see a conventional video-primary TS.
    '-thread_queue_size', '4096',
    '-use_wallclock_as_timestamps', '1',
    '-f', 'x11grab', '-video_size', '1280x720', '-framerate', '30', '-i', display,
    '-thread_queue_size', '4096',
    '-use_wallclock_as_timestamps', '1',
    '-f', 'pulse', '-sample_rate', '48000', '-channels', '2',
    '-i', audioDevice,
    ...videoArgs,
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-af', 'aresample=async=9600:min_hard_comp=0.1:first_pts=0',
    '-map', '0:v', '-map', '1:a',
    '-fflags', '+genpts+discardcorrupt+igndts',
    '-max_interleave_delta', '0',
    '-f', 'hls',
    '-hls_time',            hls.hlsTime,
    '-hls_list_size',       hls.hlsListSize,
    '-hls_flags',           hls.hlsFlags,
    '-hls_segment_filename', segPat,
    manifest,
  ];

  const ffmpegEnv = {
    ...process.env,
    DISPLAY: display,
    ...(pulseSink ? {
      PULSE_SERVER:       `unix:${pulseSink}`,
      PULSE_RUNTIME_PATH: path.dirname(pulseSink),
      HOME:               path.dirname(pulseSink),
      XDG_RUNTIME_DIR:    path.dirname(pulseSink),
      PULSE_COOKIE:       path.join(path.dirname(pulseSink), '.pulse-cookie'),
    } : {}),
  };

  console.log(`[stream] Philo x11grab [${useNvenc ? 'NVENC' : 'x264'}] ch${channelId} (${channelName}) on ${display}`);
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], env: ffmpegEnv });

  proc.stderr.on('data', d => {
    const l = d.toString().trim();
    if (l) console.log(`[stream] Philo FFmpeg ch${channelId}: ${l}`);
  });

  proc.on('exit', code => {
    console.log(`[stream] Philo FFmpeg ch${channelId} exited (${code})`);
    const recentlyActive = (Date.now() - session.lastAccess) < SESSION_IDLE_TTL;

    if (philoSessions[channelId] === session) {
      if (recentlyActive && code !== null) {
        // Auto-recovery: restart for active sessions
        console.log(`[stream] Philo ch${channelId}: auto-recovery (${session.clients.size} clients waiting)`);
        if (session._page)    session._page.close().catch(() => {});
        if (session._context) session._context.close().catch(() => {});
        if (session._display) releaseStreamBrowser(session._display).catch(() => {});
        session._page = null; session._context = null; session._ffmpeg = null;

        try {
          for (const f of fs.readdirSync(session.hlsDir)) fs.unlinkSync(path.join(session.hlsDir, f));
        } catch (_) {}

        setTimeout(async () => {
          if (philoSessions[channelId] !== session) return;
          const ch  = getDb().prepare('SELECT * FROM channels WHERE id=?').get(channelId);
          const src = ch ? getDb().prepare('SELECT config FROM sources WHERE id=?').get(ch.source_id) : null;
          if (!ch || !src) { delete philoSessions[channelId]; return; }
          const cfg = JSON.parse(src.config);
          if (!cfg.cookies) { delete philoSessions[channelId]; return; }
          const pid    = ch.stream_url.replace('philo://', '');
          const cfgCh  = (cfg.channels || []).find(c => c.id === pid);
          _startPhiloX11grab(ch, cfg, pid, cfgCh?.broadcast_id || null, channelId, session, session.hlsDir);
        }, 3000);
        return;
      }
      _destroyPhiloSession(channelId, session);
    } else {
      if (session._page)    session._page.close().catch(() => {});
      if (session._context) session._context.close().catch(() => {});
      if (session._display) { releaseStreamBrowser(session._display).catch(() => {}); _releasePhiloDisplay(channelId); }
      if (session._pulseSink) _destroyPulseSink(channelId);
    }
  });

  session._ffmpeg = proc;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = router;
