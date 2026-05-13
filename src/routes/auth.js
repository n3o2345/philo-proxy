'use strict';

/**
 * Auth module - lightweight multi-user auth with API tokens.
 *
 * Users are stored in the `users` table. Roles: 'admin' | 'viewer'.
 * Admins can manage sources, channels, maps, settings, users.
 * Viewers can only read (GET) and stream.
 *
 * Auth methods (checked in order):
 *   1. Bearer token header:  Authorization: Bearer <token>
 *   2. Query param:          ?token=<token>
 *   3. Session cookie:       philoproxy_token=<token>
 *
 * If no users exist, auth is disabled entirely (first-run open access).
 * Once any user is created, all non-GET non-stream requests require auth.
 */

const express  = require('express');
const crypto   = require('crypto');
const { getDb } = require('../db');

const router = express.Router();

// ── helpers ───────────────────────────────────────────────────────────────────

function _hashPw(pw) {
  return crypto.createHash('sha256').update(pw + 'philoproxy_salt_2024').digest('hex');
}

function _genToken() {
  return crypto.randomBytes(32).toString('hex');
}

function _getUser(token) {
  if (!token) return null;
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE token=? AND enabled=1').get(token) || null;
}

function _extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.query.token) return req.query.token;
  const cookie = req.headers['cookie'] || '';
  const m = cookie.match(/philoproxy_token=([a-f0-9]{64})/);
  return m ? m[1] : null;
}

function _hasUsers() {
  try {
    return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  } catch (_) { return false; }
}

// ── middleware ────────────────────────────────────────────────────────────────

/**
 * requireAuth(role?)
 * Returns express middleware that enforces auth.
 * If no users exist: passes through (open-access mode).
 * role = 'admin' -> only admins allowed.
 */
function requireAuth(role) {
  return (req, res, next) => {
    if (!_hasUsers()) return next(); // open-access: no users configured

    const token = _extractToken(req);
    const user  = _getUser(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (role === 'admin' && user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    req.philoproxyUser = user;
    next();
  };
}

/**
 * softAuth -- attaches user to req if token present, never blocks.
 * Used on GET endpoints so the UI can show user info.
 */
function softAuth(req, res, next) {
  if (_hasUsers()) {
    const token = _extractToken(req);
    req.philoproxyUser = _getUser(token) || null;
  } else {
    req.philoproxyUser = { role: 'admin', username: 'admin' }; // virtual admin in open-access mode
  }
  next();
}

// ── /api/auth routes ──────────────────────────────────────────────────────────

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username=? AND enabled=1').get(username);
  if (!user || user.password_hash !== _hashPw(password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Rotate token on each login
  const token = _genToken();
  db.prepare('UPDATE users SET token=?, last_login=datetime(\'now\') WHERE id=?').run(token, user.id);

  res.setHeader('Set-Cookie', `philoproxy_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.json({ ok: true, token, username: user.username, role: user.role });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'philoproxy_token=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// GET /api/auth/me -- returns current user info (or null if open-access)
router.get('/me', softAuth, (req, res) => {
  if (!req.philoproxyUser) return res.status(401).json({ error: 'Not authenticated' });
  const { id, username, role, last_login } = req.philoproxyUser;
  res.json({ id, username, role, last_login, open_access: !_hasUsers() });
});

// ── /api/users CRUD (admin only) ──────────────────────────────────────────────

// GET /api/users
router.get('/users', requireAuth('admin'), (req, res) => {
  const rows = getDb().prepare('SELECT id, username, role, enabled, last_login, created FROM users ORDER BY id').all();
  res.json(rows);
});

// POST /api/users
router.post('/users', requireAuth('admin'), (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const r = (role === 'admin') ? 'admin' : 'viewer';
  try {
    const result = getDb().prepare(
      'INSERT INTO users (username, password_hash, role, token) VALUES (?, ?, ?, ?)'
    ).run(username, _hashPw(password), r, _genToken());
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    throw err;
  }
});

// PUT /api/users/:id (admin only; can change password/role/enabled)
router.put('/users/:id', requireAuth('admin'), (req, res) => {
  const { password, role, enabled } = req.body || {};
  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });

  if (password)         db.prepare('UPDATE users SET password_hash=?, token=? WHERE id=?').run(_hashPw(password), _genToken(), user.id);
  if (role !== undefined) db.prepare('UPDATE users SET role=? WHERE id=?').run(role === 'admin' ? 'admin' : 'viewer', user.id);
  if (enabled !== undefined) db.prepare('UPDATE users SET enabled=? WHERE id=?').run(enabled ? 1 : 0, user.id);

  res.json({ ok: true });
});

// DELETE /api/users/:id
router.delete('/users/:id', requireAuth('admin'), (req, res) => {
  // Don't allow deleting the last admin
  const db    = getDb();
  const user  = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (user.role === 'admin') {
    const adminCount = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role=\'admin\' AND enabled=1').get().n;
    if (adminCount <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/users/:id/reset-token -- force a token rotation (invalidates existing sessions)
router.post('/users/:id/reset-token', requireAuth('admin'), (req, res) => {
  const token = _genToken();
  getDb().prepare('UPDATE users SET token=? WHERE id=?').run(token, req.params.id);
  res.json({ ok: true });
});

module.exports = { router, requireAuth, softAuth, _hasUsers };
