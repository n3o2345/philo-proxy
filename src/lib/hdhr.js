'use strict';

/**
 * HDHomeRun network tuner library
 * Handles local UDP discovery, cloud discovery, and lineup fetching.
 */

const axios = require('axios');
const dgram = require('dgram');

const HDHR_DISCOVER_PORT = 65001;
const HDHR_CLOUD_URL     = 'https://api.hdhomerun.com/discover';

/**
 * discoverLocal(timeoutMs) -> DeviceInfo[]
 * Sends a UDP broadcast and collects HDHomeRun responses.
 */
function discoverLocal(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const devices = [];
    const sock    = dgram.createSocket('udp4');

    // Discovery packet
    const pkt = Buffer.from([
      0x00, 0x02,             // type: discover request
      0x00, 0x0c,             // length: 12
      0x01, 0x04, 0xff, 0xff, 0xff, 0xff, // device type: any
      0x02, 0x04, 0xff, 0xff, 0xff, 0xff, // device id: any
    ]);

    sock.on('message', (msg, rinfo) => {
      try {
        const info = _parseDiscoveryResponse(msg, rinfo.address);
        if (info) devices.push(info);
      } catch (_) {}
    });

    sock.on('error', () => sock.close());

    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(pkt, 0, pkt.length, HDHR_DISCOVER_PORT, '255.255.255.255', () => {});
      setTimeout(() => { try { sock.close(); } catch (_) {} resolve(devices); }, timeoutMs);
    });
  });
}

function _parseDiscoveryResponse(buf, ip) {
  // Minimal: just confirm it looks like an HDHR packet and return the IP
  if (buf.length < 4) return null;
  const type = (buf[0] << 8) | buf[1];
  if (type !== 0x0003) return null; // discover response
  return { device_id: ip, ip, base_url: `http://${ip}` };
}

/**
 * discoverCloud() -> CloudDevice[]
 */
async function discoverCloud() {
  try {
    const res = await axios.get(HDHR_CLOUD_URL, { timeout: 5000 });
    return Array.isArray(res.data) ? res.data : [];
  } catch (_) {
    return [];
  }
}

/**
 * fetchDeviceInfo(ip) -> DeviceInfo | null
 */
async function fetchDeviceInfo(ip) {
  try {
    const res = await axios.get(`http://${ip}/discover.json`, { timeout: 4000 });
    return { ...res.data, ip, base_url: `http://${ip}` };
  } catch (_) {
    return null;
  }
}

/**
 * fetchLineup(baseUrl, sourceId) -> ChannelRow[]
 */
async function fetchLineup(baseUrl, sourceId) {
  const url = `${baseUrl}/lineup.json`;
  const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'TVNow/1.0' } });
  const lineup = Array.isArray(res.data) ? res.data : [];

  return lineup.map((ch, idx) => ({
    source_id:   sourceId,
    name:        ch.GuideName  || ch.GuideNumber || 'Unknown',
    number:      ch.GuideNumber ? String(ch.GuideNumber) : null,
    logo_url:    ch.ImageURL   || null,
    stream_url:  ch.URL        || '',
    stream_type: _detectType(ch.URL || ''),
    group_name:  ch.Affiliate  || 'HDHomeRun',
    epg_id:      ch.GuideName  || null,
    enabled:     !ch.DRM ? 1 : 0, // skip DRM-protected channels
    sort_order:  idx,
  }));
}

function _detectType(url) {
  const u = url.toLowerCase();
  if (u.includes('.m3u8') || u.includes('hls')) return 'hls';
  if (u.includes('.ts')   || u.includes('mpegts')) return 'mpegts';
  return 'hls';
}

module.exports = { fetchLineup, discoverLocal, discoverCloud, fetchDeviceInfo };
