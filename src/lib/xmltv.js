'use strict';

/**
 * XMLTV EPG parser
 * Fetches and parses an XMLTV-format XML file into program + channel rows.
 */

const axios = require('axios');
const sax   = require('sax');

/**
 * parseXmltvDate('20240315120000 +0000') -> Unix timestamp (seconds)
 */
function parseXmltvDate(str) {
  if (!str) return 0;
  // Format: YYYYMMDDHHmmss +HHMM  or  YYYYMMDDHHmmss
  const m = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if (!m) return 0;
  const [, yr, mo, dy, hr, mn, sc, tz] = m;
  const iso = `${yr}-${mo}-${dy}T${hr}:${mn}:${sc}${tz ? tz.slice(0,3)+':'+tz.slice(3) : 'Z'}`;
  return Math.floor(new Date(iso).getTime() / 1000);
}

function htmlDecode(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/**
 * fetchXmltv(url) -> { channels: [], programs: [] }
 */
async function fetchXmltv(url) {
  let text;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const res = await axios.get(url, {
      responseType: 'text',
      timeout: 60000,
      headers: { 'User-Agent': 'Philoproxy/1.0' },
    });
    text = res.data;
  } else {
    text = require('fs').readFileSync(url, 'utf8');
  }

  return parseXmltvText(text);
}

function parseXmltvText(text) {
  return new Promise((resolve, reject) => {
    const parser   = sax.parser(true, { trim: true, normalize: true });
    const channels = [];
    const programs = [];

    let curProg    = null;
    let curChan    = null;
    let inTitle    = false;
    let inDesc     = false;
    let inCategory = false;
    let inEpisode  = false;
    let inIcon     = false;
    let inDisplayName = false;
    let textBuf    = '';

    parser.onopentag = (node) => {
      const { name, attributes: a } = node;
      textBuf = '';

      if (name === 'channel') {
        curChan = { id: a.id, displayName: '' };
        return;
      }
      if (name === 'display-name' && curChan) { inDisplayName = true; return; }

      if (name === 'programme') {
        curProg = {
          epg_id:      a.channel || '',
          title:       '',
          description: null,
          category:    null,
          start_time:  parseXmltvDate(a.start),
          end_time:    parseXmltvDate(a.stop),
          episode:     null,
          icon_url:    null,
        };
        return;
      }
      if (curProg) {
        if (name === 'title')           { inTitle    = true; return; }
        if (name === 'desc')            { inDesc     = true; return; }
        if (name === 'category')        { inCategory = true; return; }
        if (name === 'episode-num')     { inEpisode  = true; return; }
        if (name === 'icon')            { curProg.icon_url = a.src || null; return; }
      }
    };

    parser.ontext = (t) => { textBuf += t; };
    parser.oncdata = (t) => { textBuf += t; };

    parser.onclosetag = (name) => {
      const val = htmlDecode(textBuf.trim());
      textBuf = '';

      if (name === 'display-name' && curChan) { curChan.displayName = val; inDisplayName = false; return; }
      if (name === 'channel' && curChan) { channels.push(curChan); curChan = null; return; }

      if (curProg) {
        if (name === 'title')       { curProg.title       = val; inTitle    = false; return; }
        if (name === 'desc')        { curProg.description = val; inDesc     = false; return; }
        if (name === 'category')    { curProg.category    = val; inCategory = false; return; }
        if (name === 'episode-num') { curProg.episode     = val; inEpisode  = false; return; }
        if (name === 'programme') {
          if (curProg.title && curProg.epg_id && curProg.start_time && curProg.end_time) {
            programs.push(curProg);
          }
          curProg = null;
        }
      }
    };

    parser.onerror = (err) => { parser.resume(); };
    parser.onend   = () => resolve({ channels, programs });

    parser.write(text).close();
  });
}

module.exports = { fetchXmltv, parseXmltvText, parseXmltvDate };
