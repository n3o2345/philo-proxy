'use strict';

/**
 * M3U / M3U8 playlist parser
 * Parses extended M3U (#EXTM3U) playlists into channel row objects.
 */

function htmlDecode(str) {
  if (!str || !str.includes('&')) return str;
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function attr(line, key) {
  const re = new RegExp(`${key}="([^"]*)"`, 'i');
  const m  = line.match(re);
  return m ? htmlDecode(m[1].trim()) : null;
}

function attrUnquoted(line, key) {
  const re = new RegExp(`${key}=([^\\s,]+)`, 'i');
  const m  = line.match(re);
  return m ? m[1].trim() : null;
}

/**
 * parseM3U(text, sourceId) -> ChannelRow[]
 */
function parseM3U(text, sourceId) {
  const lines   = text.split(/\r?\n/);
  const channels = [];
  let   pending  = null;
  let   sortIdx  = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF:')) {
      // #EXTINF:-1 tvg-id="..." tvg-name="..." tvg-logo="..." group-title="...",Display Name
      const commaIdx = line.indexOf(',');
      const meta     = commaIdx >= 0 ? line.slice(0, commaIdx) : line;
      const name     = commaIdx >= 0 ? htmlDecode(line.slice(commaIdx + 1).trim()) : '';

      const tvgId    = attr(meta, 'tvg-id')    || attr(meta, 'tvg-name') || name;
      const tvgName  = attr(meta, 'tvg-name')  || name;
      const logo     = attr(meta, 'tvg-logo')  || attr(meta, 'logo');
      const group    = attr(meta, 'group-title') || null;
      const number   = attrUnquoted(meta, 'tvg-chno') || attr(meta, 'tvg-chno') || null;

      pending = {
        source_id:   sourceId,
        name:        tvgName || name || 'Unknown',
        number:      number,
        logo_url:    logo,
        stream_url:  '',
        stream_type: 'hls',
        group_name:  group,
        epg_id:      tvgId || null,
        enabled:     1,
        sort_order:  sortIdx++,
      };
      continue;
    }

    if (line.startsWith('#')) continue; // other directives

    // This line is a URL
    if (pending) {
      pending.stream_url  = line;
      pending.stream_type = _detectType(line);
      channels.push(pending);
      pending = null;
    } else {
      // bare URL with no EXTINF
      channels.push({
        source_id:   sourceId,
        name:        line.split('/').pop() || 'Unknown',
        number:      null,
        logo_url:    null,
        stream_url:  line,
        stream_type: _detectType(line),
        group_name:  null,
        epg_id:      null,
        enabled:     1,
        sort_order:  sortIdx++,
      });
    }
  }

  return channels;
}

function _detectType(url = '') {
  const u = url.toLowerCase().split('?')[0];
  if (u.endsWith('.m3u8') || u.includes('/hls/') || u.includes('hls'))  return 'hls';
  if (u.endsWith('.ts')   || u.includes('mpegts') || u.includes('.ts?')) return 'mpegts';
  if (u.endsWith('.m3u'))                                                 return 'hls';
  return 'hls';
}

module.exports = { parseM3U };
