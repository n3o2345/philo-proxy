'use strict';

/**
 * Philo plugin
 *
 * The Playwright OTP login flow, GQL channel/EPG fetches, and x11grab
 * streaming are all still handled by src/routes/philo.js (unchanged).
 * This plugin wires the sync/refresh/stream hooks so sources.js no
 * longer needs to know about Philo specifically.
 */

const philoRouter = require('../routes/philo');

module.exports = {
  type:        'philo',
  displayName: 'Philo',
  icon:        '📱',
  description: 'Playwright browser OTP login (email or phone) - Widevine DRM via x11grab',

  // The existing philo.js router handles /api/philo/* endpoints
  router: philoRouter,

  // ── Sync: channels come from the stored config (populated by verify_code) ─
  async syncChannels(sourceId, config, db) {
    if (!config.channels || !config.channels.length) return [];

    const { htmlDecode } = _helpers();
    return config.channels.map((ch, idx) => ({
      source_id:   sourceId,
      name:        htmlDecode(ch.name),
      stream_url:  ch.stream_url || `philo://${ch.id}`,
      stream_type: 'philo',
      number:      ch.number     || null,
      logo_url:    ch.logo_url   || null,
      epg_id:      htmlDecode(ch.epg_id || ch.name),
      group_name:  'Philo',
      enabled:     1,
      sort_order:  idx,
    }));
  },

  // ── EPG refresh ──────────────────────────────────────────────────────────
  async refreshEpg(source, db) {
    const config = JSON.parse(source.config);
    if (!config.cookies) return;
    const { gqlGetChannelsWithGuide, savePhiloEpg } = philoRouter;
    if (!gqlGetChannelsWithGuide || !savePhiloEpg) return;
    const channels = await gqlGetChannelsWithGuide(config.cookies);
    if (channels.length) {
      savePhiloEpg(db, channels);
      console.log(`[epg-auto] Refreshed Philo EPG: ${channels.length} channels`);
    }
  },
};

function _helpers() {
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
  return { htmlDecode };
}
