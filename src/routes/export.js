'use strict';

/**
 * Export routes
 *   GET /channels.m3u   → M3U playlist (Philo channels, philo.m3u8 URLs)
 *   GET /epg.xml        → XMLTV guide data
 *   GET /lineup.json    → HDHomeRun-compatible lineup (Plex DVR / Dispatcharr)
 *   GET /device.xml     → HDHomeRun device descriptor
 *   GET /discover.json  → HDHomeRun discovery response
 */

const express   = require('express');
const router    = express.Router();
const { getDb } = require('../db');

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host  = req.headers['x-forwarded-host']  || req.headers.host || 'localhost:5050';
  return `${proto}://${host}`;
}

// ── M3U playlist ──────────────────────────────────────────────────────────────
//
// All Philo channels use the philo.m3u8 endpoint (x11grab HLS).
// Query params:
//   ?group=<name>  — override group-title (default: "Philo")

router.get('/channels.m3u', (req, res) => {
  const db       = getDb();
  const channels = db.prepare('SELECT * FROM channels WHERE enabled=1 ORDER BY sort_order, id').all();
  const base     = baseUrl(req);
  const group    = req.query.group || 'Philo';

  let m3u = '#EXTM3U\n';
  for (const ch of channels) {
    const num   = ch.number   ? ` tvg-chno="${_esc(ch.number)}"` : '';
    const logo  = ch.logo_url ? ` tvg-logo="${_esc(ch.logo_url)}"` : '';
    const epgId = ch.epg_id  ? ` tvg-id="${_esc(ch.epg_id)}"` : '';
    const grp   = ` group-title="${_esc(group)}"`;
    m3u += `#EXTINF:-1${num}${epgId} tvg-name="${_esc(ch.name)}"${logo}${grp},${ch.name}\n`;
    m3u += `${base}/stream/${ch.id}/philo.m3u8\n`;
  }

  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="philo.m3u"');
  res.send(m3u);
});

// ── XMLTV EPG ─────────────────────────────────────────────────────────────────
router.get('/epg.xml', (req, res) => {
  const db   = getDb();
  const now  = Math.floor(Date.now() / 1000);
  const from = parseInt(req.query.from) || now - 3600;
  const to   = parseInt(req.query.to)   || now + 48 * 3600;

  const channels = db.prepare('SELECT * FROM channels WHERE enabled=1 ORDER BY sort_order, id').all();
  const programs = db.prepare(
    'SELECT * FROM programs WHERE end_time>? AND start_time<? ORDER BY epg_id, start_time'
  ).all(from, to);

  const epgIds = new Set(channels.map(c => c.epg_id).filter(Boolean));

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml    += '<!DOCTYPE tv SYSTEM "xmltv.dtd">\n';
  xml    += '<tv generator-info-name="PhiloProxy">\n';

  for (const ch of channels) {
    if (!ch.epg_id) continue;
    xml += `  <channel id="${_esc(ch.epg_id)}">\n`;
    xml += `    <display-name>${_esc(ch.name)}</display-name>\n`;
    if (ch.logo_url) xml += `    <icon src="${_esc(ch.logo_url)}" />\n`;
    xml += `  </channel>\n`;
  }

  for (const p of programs) {
    if (!epgIds.has(p.epg_id)) continue;
    const start = _toXmltvDate(p.start_time);
    const stop  = _toXmltvDate(p.end_time);
    xml += `  <programme start="${start}" stop="${stop}" channel="${_esc(p.epg_id)}">\n`;
    xml += `    <title lang="en">${_esc(p.title)}</title>\n`;
    if (p.description) xml += `    <desc lang="en">${_esc(p.description)}</desc>\n`;
    if (p.category)    xml += `    <category lang="en">${_esc(p.category)}</category>\n`;
    if (p.episode)     xml += `    <episode-num system="onscreen">${_esc(p.episode)}</episode-num>\n`;
    if (p.icon_url)    xml += `    <icon src="${_esc(p.icon_url)}" />\n`;
    xml += `  </programme>\n`;
  }

  xml += '</tv>\n';
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="epg.xml"');
  res.send(xml);
});

// ── HDHomeRun compatibility ───────────────────────────────────────────────────
router.get('/discover.json', (req, res) => {
  const base = baseUrl(req);
  res.json({
    FriendlyName:    'PhiloProxy',
    Manufacturer:    'PhiloProxy',
    ModelNumber:     'HDTC-2US',
    FirmwareName:    'hdhomerun3_atsc',
    FirmwareVersion: '20200101',
    DeviceID:        'philoproxy0001',
    DeviceAuth:      '',
    BaseURL:         base,
    LineupURL:       `${base}/lineup.json`,
  });
});

router.get('/device.xml', (req, res) => {
  const base = baseUrl(req);
  res.setHeader('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>${base}</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>PhiloProxy</friendlyName>
    <manufacturer>PhiloProxy</manufacturer>
    <modelName>HDTC-2US</modelName>
    <modelNumber>HDTC-2US</modelNumber>
    <serialNumber>philoproxy0001</serialNumber>
    <UDN>uuid:philoproxy-0001-0001-0001</UDN>
  </device>
</root>`);
});

router.get('/lineup_status.json', (_req, res) => {
  res.json({ ScanInProgress: 0, ScanPossible: 0, Source: 'Cable', SourceList: ['Cable'] });
});

// lineup.json — HDHomeRun-compatible channel list.
// All streams point directly to /stream/:id/philo.m3u8.
router.get('/lineup.json', (req, res) => {
  const db       = getDb();
  const base     = baseUrl(req);
  const channels = db.prepare('SELECT * FROM channels WHERE enabled=1 ORDER BY sort_order, id').all();

  res.json(channels.map(ch => ({
    GuideNumber: ch.number || String(ch.id),
    GuideName:   ch.name,
    ImageURL:    ch.logo_url || '',
    URL:         `${base}/stream/${ch.id}/philo.m3u8`,
  })));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function _esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _toXmltvDate(unixSec) {
  const d   = new Date(unixSec * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
         `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`;
}

module.exports = router;
