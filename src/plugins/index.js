'use strict';

/**
 * Plugin Registry — Philo-only build
 *
 * Only the Philo plugin is registered.  The registry API is kept generic so
 * additional plugins can be dropped in later without touching server.js.
 */

const path     = require('path');
const registry = new Map();

function register(plugin) {
  if (!plugin.type || typeof plugin.syncChannels !== 'function') {
    throw new Error(`Plugin missing required fields: type, syncChannels`);
  }
  registry.set(plugin.type, plugin);
  console.log(`[plugins] Registered: ${plugin.type}`);
}

function get(type)  { return registry.get(type) || null; }
function all()      { return [...registry.values()]; }
function types()    { return [...registry.keys()]; }

// ── Load Philo plugin ─────────────────────────────────────────────────────────
try {
  register(require(path.join(__dirname, 'philo.js')));
} catch (err) {
  console.error('[plugins] Failed to load philo plugin:', err.message);
}

module.exports = { register, get, all, types };
