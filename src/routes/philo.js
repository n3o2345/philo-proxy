/**
 * Philo Integration -- Playwright browser-based OTP login
 *
 * Exact port of the Python app.py login flow:
 *   1. POST /api/philo/send_code   { ident: "email or phone" }
 *      -> Headless Chromium navigates to philo.com/login/authenticate,
 *        fills the input, submits. Keeps the page open.
 *   2. GET  /api/philo/send_code/status
 *      -> Poll for: idle | sending | awaiting_code | done_auth | error
 *   3. POST /api/philo/verify_code { code: "123456", source_id }
 *      -> Types OTP into the same open page, submits.
 *        On success: extracts cookies -> runs GraphQL GetUser + channels
 *        -> saves to source config + channels table.
 *
 * No fake REST APIs. No guessed endpoints. Just the real Philo login page.
 */

const express  = require('express');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const axios    = require('axios');
const router   = express.Router();
const { getDb } = require('../db');

const PHILO_BASE = 'https://www.philo.com';
const PHILO_GQL  = 'https://www.philo.com/graphql';
const CDN_LOGOS  = 'https://prod-s.cdn-cf.philo.com/images/channel_logos';

// ── Playwright lazy-load ──────────────────────────────────────────────────────
let playwright  = null;
let browser     = null;
let loginPage   = null;   // held between send_code and verify_code
let sendStatus  = { state: 'idle', error: null, message: '' };

async function getBrowser() {
  if (!playwright) playwright = require('playwright');
  if (!browser || !browser.isConnected()) {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
             '--disable-gpu','--autoplay-policy=no-user-gesture-required',
             '--disable-blink-features=AutomationControlled'],
    });
  }
  return browser;
}

// Per-display non-headless browser for x11grab (mirrors Python start_on_display)
const _streamBrowsers = {};

async function getStreamBrowser(display, pulseSink) {
  if (!playwright) playwright = require('playwright');
  const entry = _streamBrowsers[display];
  if (entry && entry.browser && entry.browser.isConnected()) return entry.browser;
  console.log(`[philo] Launching stream browser on ${display} sink=${pulseSink || 'default'}`);
  const sb = await playwright.chromium.launch({
    headless: false,
    env: {
      ...process.env,
      DISPLAY: display,
      PULSE_SERVER: process.env.PULSE_SERVER || 'unix:/var/run/pulse/native',
      // Route this browser's audio to its dedicated sink
      // Point Chromium at this stream's private PulseAudio daemon socket
      ...(pulseSink ? {
        PULSE_SERVER:       `unix:${pulseSink}`,
        PULSE_RUNTIME_PATH: require('path').dirname(pulseSink),
        HOME:               require('path').dirname(pulseSink),
        XDG_RUNTIME_DIR:    require('path').dirname(pulseSink),
      } : {}),
    },
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--disable-software-rasterizer',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run','--no-default-browser-check',
      '--disable-background-timer-throttling','--disable-renderer-backgrounding',
      '--disable-infobars','--disable-notifications','--hide-scrollbars',
      '--start-maximized','--start-fullscreen',
      '--window-size=1280,720','--window-position=0,0',
      '--disable-session-crashed-bubble','--hide-crash-restore-bubble',
      '--disable-features=MediaSessionService,HardwareMediaKeyHandling',
    ],
  });
  _streamBrowsers[display] = { browser: sb };
  sb.on('disconnected', () => { delete _streamBrowsers[display]; });
  return sb;
}

async function releaseStreamBrowser(display) {
  const entry = _streamBrowsers[display];
  if (!entry) return;
  try { await entry.browser.close(); } catch (_) {}
  delete _streamBrowsers[display];
}

// ── Per-channel virtual PulseAudio sink ──────────────────────────────────────
// Uses the global system-mode PA daemon (already running) and creates a
// dedicated null sink per channel via pactl. This avoids spawning per-channel
// PA daemons as root in user mode, which is broken on Debian bookworm.
// ─────────────────────────────────────────────────────────────────────────────

// ── Per-channel private PulseAudio daemon ────────────────────────────────────
const { execSync: _execSync, spawn: _spawnPa } = require('child_process');
const _os    = require('os');
const _fs2   = require('fs');
const _path2 = require('path');
const _channelPulse = new Map(); // channelId -> { dir, socket, proc }

async function _createPulseSink(channelId) {
  if (_channelPulse.has(channelId)) return _channelPulse.get(channelId).socket;

  const pulseDir    = _path2.join(_os.tmpdir(), `tvnow_pulse_${channelId}`);
  const pulseSocket = _path2.join(pulseDir, 'native');
  const paConf      = _path2.join(pulseDir, 'pa.conf');
  const daemonConf  = _path2.join(pulseDir, 'daemon.conf');
  const cookieFile  = _path2.join(pulseDir, '.pulse-cookie');
  const cookieDir   = _path2.join(pulseDir, '.config', 'pulse');

  // Kill any previous instance and wipe the dir
  const prev = _channelPulse.get(channelId);
  if (prev) { try { prev.proc.kill('SIGKILL'); } catch (_) {} _channelPulse.delete(channelId); await sleep(150); }
  try { _fs2.rmSync(pulseDir, { recursive: true, force: true }); } catch (_) {}
  _fs2.mkdirSync(cookieDir, { recursive: true });

  // Pre-create cookie files so PA doesn't fail auth init when running as root
  const zeroCookie = Buffer.alloc(256);
  _fs2.writeFileSync(cookieFile, zeroCookie);
  _fs2.writeFileSync(_path2.join(cookieDir, 'cookie'), zeroCookie);

  // Minimal config: null sink + native unix socket, auth disabled
  _fs2.writeFileSync(paConf,
    `load-module module-null-sink sink_name=out\n` +
    `set-default-sink out\n` +
    `set-default-source out.monitor\n` +
    `load-module module-native-protocol-unix auth-anonymous=1 auth-cookie-enabled=0 socket=${pulseSocket}\n`
  );
  _fs2.writeFileSync(daemonConf,
    `default-sample-rate = 48000\n` +
    `exit-idle-time = -1\n` +
    `log-level = error\n`
  );

  const paEnv = {
    ...process.env,
    PULSE_RUNTIME_PATH: pulseDir,
    HOME:               pulseDir,
    XDG_RUNTIME_DIR:    pulseDir,
    PULSE_COOKIE:       cookieFile,
    // Suppress dbus errors -- expected in a container
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent',
    DBUS_SYSTEM_BUS_ADDRESS:  'unix:path=/nonexistent',
  };

  const paProc = _spawnPa('pulseaudio', [
    '--daemonize=no',
    '--exit-idle-time=-1',
    '--disallow-exit',
    '-n',
    `--file=${paConf}`,
    '--log-target=stderr',
  ], { env: paEnv, stdio: ['ignore', 'ignore', 'pipe'] });

  paProc.stderr && paProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    // Suppress expected noise: dbus, cookie, root warning
    if (msg && !msg.includes('/nonexistent') && !msg.includes('D-Bus')
            && !msg.includes('cookie') && !msg.includes('not intended to be run as root'))
      console.log(`[philo-pa ch${channelId}] ${msg}`);
  });
  paProc.on('error', err => console.warn(`[philo] PA ch${channelId} error: ${err.message}`));
  paProc.on('exit',  code => { console.log(`[philo] PulseAudio ch${channelId} exited (${code})`); _channelPulse.delete(channelId); });

  // Poll until the socket exists AND pactl can list the sink
  const { execSync: _paCtl } = require('child_process');
  let ready = false;
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    if (!_fs2.existsSync(pulseSocket)) continue;
    try {
      const out = _paCtl(`pactl --server=unix:${pulseSocket} list short sinks`,
        { stdio: 'pipe', timeout: 1000, env: { ...paEnv, PULSE_SERVER: `unix:${pulseSocket}` } }
      ).toString();
      if (out.includes('out')) { ready = true; break; }
    } catch (_) {}
  }

  if (!ready) {
    console.warn(`[philo] PA sink not ready for ch${channelId} after 8s -- aborting`);
    try { paProc.kill('SIGKILL'); } catch (_) {}
    return null;
  }

  console.log(`[philo] PulseAudio ready for ch${channelId} at ${pulseSocket}`);
  _channelPulse.set(channelId, { dir: pulseDir, socket: pulseSocket, proc: paProc });
  return pulseSocket;
}

function _destroyPulseSink(channelId) {
  const entry = _channelPulse.get(channelId);
  if (!entry) return;
  try { entry.proc.kill('SIGTERM'); } catch (_) {}
  try { _fs2.rmSync(entry.dir, { recursive: true, force: true }); } catch (_) {}
  _channelPulse.delete(channelId);
  console.log(`[philo] PulseAudio destroyed for ch${channelId}`);
}
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/philo/send_code
// Body: { ident: "email@example.com" or "5551234567" }
// Navigates to philo.com/login/authenticate, fills the field, submits.
// Keeps the page open for verify_code.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send_code', async (req, res) => {
  const ident = (req.body.ident || '').trim();
  if (!ident) return res.status(400).json({ ok: false, error: 'ident required (email or phone)' });

  // Respond immediately -- browser work runs in background
  res.json({ ok: true, pending: true });

  sendStatus = { state: 'sending', error: null, message: 'Opening Philo login page...' };

  // Run in background (matches Python's threading.Thread approach)
  _browserSendCode(ident).catch(err => {
    console.error('[philo] send_code background error:', err.message);
    sendStatus = { state: 'error', error: err.message, message: '' };
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/philo/send_code/status
// ─────────────────────────────────────────────────────────────────────────────
router.get('/send_code/status', (req, res) => {
  const s = sendStatus.state;
  if (s === 'idle')           return res.json({ state: 'idle' });
  if (s === 'sending')        return res.json({ state: 'sending',        message: sendStatus.message || 'Opening Philo login page...' });
  if (s === 'awaiting_code')  return res.json({ state: 'awaiting_code',  message: '✓ Code sent -- check your email or phone.' });
  if (s === 'done_auth')      return res.json({ state: 'done_auth',      message: '✓ Already authenticated -- session synced.' });
  if (s === 'error')          return res.json({ state: 'error',          message: sendStatus.error || 'Unknown error' });
  res.json({ state: s });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/philo/verify_code
// Body: { code: "123456", source_id }
// Types the OTP into the open login page, submits, extracts cookies on success.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/verify_code', async (req, res) => {
  const { code, source_id, ident } = req.body;
  const normalizedCode = String(code ?? '').trim();
  if (!normalizedCode && !loginPage?.alreadyAuthed) {
    return res.status(400).json({ ok: false, error: 'code required' });
  }

  try {
    const result = await _browserVerifyCode(normalizedCode);
    if (!result.ok) return res.status(400).json(result);

    // Cookies extracted -- validate via GraphQL + import channels
    const cookies = result.cookies; // "name=val; name2=val2" string
    const user = await gqlGetUser(cookies);
    if (!user) return res.status(401).json({ ok: false, error: 'Cookies invalid after login' });

    const channels = await gqlGetChannels(cookies);

    if (source_id) {
      savePhiloSource(source_id, cookies, user, channels, ident);
      // Kick off a wider guide fetch in the background immediately after login
      gqlGetChannelsWithGuide(cookies)
        .then(guideChannels => { if (guideChannels.length) savePhiloEpg(getDb(), guideChannels); })
        .catch(err => console.warn('[philo] initial guide fetch:', err.message));
    }

    res.json({ ok: true, user: user.displayName || user.id, channels_count: channels.length });
  } catch (err) {
    console.error('[philo] verify_code error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Browser automation -- mirrors Python _browser_send_code exactly
// ─────────────────────────────────────────────────────────────────────────────
async function _browserSendCode(ident) {
  const bw      = await getBrowser();
  const context = await bw.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:  { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  try {
    const loginUrl = `${PHILO_BASE}/login/authenticate`;
    console.log('[philo] Navigating to', loginUrl);

    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (_) {
      await page.goto(loginUrl, { timeout: 30000 });
    }

    // Give the SPA a moment to render
    await page.waitForTimeout(2000);
    const finalUrl = page.url();
    console.log('[philo] Landed on:', finalUrl);

    // Already authenticated? (redirected away from login page)
    if (!finalUrl.includes('/login') && !finalUrl.includes('/authenticate')) {
      console.log('[philo] Already authenticated -- syncing cookies');
      const cookies = await context.cookies();
      const cookieStr = philoCookiesAsString(cookies);
      sendStatus = { state: 'done_auth', error: null, message: '' };
      loginPage  = { page, context, cookieStr, alreadyAuthed: true };
      return;
    }

    // Wait for the email/phone input
    const inp = await page.waitForSelector('input:not([type=hidden])', { timeout: 15000 });
    await inp.click();
    await inp.fill(ident);
    console.log('[philo] Filled ident:', ident);

    // Submit -- try the same selectors as the Python version
    let submitted = false;
    for (const sel of [
      'button[type="submit"]',
      'button:has-text("Sign in")',
      'button:has-text("Send")',
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'input[type="submit"]',
    ]) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible()) {
          await btn.click();
          submitted = true;
          console.log('[philo] Clicked submit:', sel);
          break;
        }
      } catch (_) {}
    }
    if (!submitted) {
      console.log('[philo] No submit button -- pressing Enter');
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(4000);
    console.log('[philo] After submit URL:', page.url());

    // Check for error messages
    const errText = await page.evaluate(() => {
      const el = document.querySelector('[class*="error" i], [role="alert"]');
      return el ? el.innerText.trim().slice(0, 200) : null;
    });
    if (errText) {
      sendStatus = { state: 'error', error: errText, message: '' };
      await page.close();
      await context.close();
      return;
    }

    // Keep the page open for verify_code
    loginPage  = { page, context };
    sendStatus = { state: 'awaiting_code', error: null, message: '' };
    console.log('[philo] Code dispatched to', ident);

  } catch (err) {
    sendStatus = { state: 'error', error: err.message, message: '' };
    try { await page.close(); } catch (_) {}
    try { await context.close(); } catch (_) {}
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser automation -- mirrors Python _browser_verify_code exactly
// ─────────────────────────────────────────────────────────────────────────────
async function _browserVerifyCode(code) {
  if (!loginPage) {
    return { ok: false, error: 'Send Code first before verifying' };
  }

  // Already authenticated case
  if (loginPage.alreadyAuthed) {
    const cookieStr = loginPage.cookieStr;
    try { await loginPage.page.close(); } catch (_) {}
    try { await loginPage.context.close(); } catch (_) {}
    loginPage = null;
    return { ok: true, cookies: cookieStr };
  }

  const { page, context } = loginPage;
  if (!page || page.isClosed()) {
    loginPage = null;
    return { ok: false, error: 'Login page was closed -- please Send Code again' };
  }

  try {
    console.log('[philo] Verify page URL:', page.url());

    // Wait for the OTP input
    const inp = await page.waitForSelector('input', { timeout: 10000 });
    await inp.click();
    await inp.fill(code);
    console.log('[philo] Filled OTP:', code);

    // Click verify -- same selectors as Python
    let submitted = false;
    for (const sel of [
      'button[type="submit"]',
      'button:has-text("Verify")',
      'button:has-text("Confirm")',
      'button:has-text("Sign in")',
      'button:has-text("Continue")',
    ]) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible()) {
          await btn.click();
          submitted = true;
          console.log('[philo] Clicked verify:', sel);
          break;
        }
      } catch (_) {}
    }
    if (!submitted) {
      console.log('[philo] No verify button -- pressing Enter');
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(4000);
    const currentUrl = page.url();
    console.log('[philo] After verify URL:', currentUrl);

    // Still on login page = wrong code
    if (currentUrl.includes('login') || currentUrl.includes('authenticate')) {
      const errText = await page.evaluate(() => {
        const el = document.querySelector('[class*="error" i], [role="alert"]');
        return el ? el.innerText.trim().slice(0, 200) : null;
      }) || 'Still on login page -- code wrong or expired';
      return { ok: false, error: errText };
    }

    // Success -- extract cookies from browser context
    const allCookies = await context.cookies();
    const cookieStr  = philoCookiesAsString(allCookies);
    console.log('[philo] Login successful --', allCookies.filter(c => c.domain.includes('philo')).length, 'philo cookies');

    // Clean up
    loginPage = null;
    try { await page.close(); } catch (_) {}
    try { await context.close(); } catch (_) {}

    return { ok: true, cookies: cookieStr };

  } catch (err) {
    console.error('[philo] verify_code error:', err.message);
    try { await page.close(); } catch (_) {}
    try { await context.close(); } catch (_) {}
    loginPage = null;
    return { ok: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL helpers -- same approach as Python _gql_raw
// ─────────────────────────────────────────────────────────────────────────────
const GQL_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type':    'application/json',
  'Origin':          PHILO_BASE,
  'Referer':         PHILO_BASE + '/',
};

async function gqlRaw(query, operationName, cookies) {
  const r = await axios.post(
    PHILO_GQL,
    JSON.stringify([{ query, operationName }]),
    { headers: { ...GQL_HEADERS, 'Cookie': cookies }, timeout: 20000 }
  );
  const parsed = Array.isArray(r.data) ? r.data[0] : r.data;
  return { data: parsed.data || {}, errors: parsed.errors || [] };
}

async function gqlGetUser(cookies) {
  const { data } = await gqlRaw('query GetUser { user { id displayName } }', 'GetUser', cookies);
  return data.user || null;
}

async function gqlGetChannels(cookies) {
  // Mirrors Python _fetch_channels_gql -- tries 4 query variants in order
  const BROADCAST_EDGES         = 'edges { node { id startsAt endsAt  show { title description } } }';
  const BROADCAST_EDGES_MINIMAL = 'edges { node { id startsAt         show { title } } }';
  const NUM_UPCOMING = 4;

  const attempts = [
    {
      label: 'availableChannels(full)',
      query: `query GetChannels {
        availableChannels(order: NUMERIC, first: 300) {
          edges { node {
            id displayName callsign displayNumber
            images { small large }
            currentBroadcast { id startsAt endsAt show { title description } }
            broadcasts(first: ${NUM_UPCOMING}) { ${BROADCAST_EDGES} }
          }}
        }
      }`,
      extract: d => ((d.availableChannels || {}).edges || []).map(e => e.node).filter(Boolean),
    },
    {
      label: 'availableChannels(minimal)',
      query: `query GetChannels {
        availableChannels(order: NUMERIC, first: 300) {
          edges { node {
            id displayName callsign displayNumber
            images { small large }
            currentBroadcast { id startsAt show { title } }
            broadcasts(first: ${NUM_UPCOMING}) { ${BROADCAST_EDGES_MINIMAL} }
          }}
        }
      }`,
      extract: d => ((d.availableChannels || {}).edges || []).map(e => e.node).filter(Boolean),
    },
    {
      label: 'popularChannels(full)',
      query: `query GetChannels {
        popularChannels {
          id displayName callsign displayNumber
          images { small large }
          currentBroadcast { id startsAt endsAt show { title description } }
          broadcasts(first: ${NUM_UPCOMING}) { ${BROADCAST_EDGES} }
        }
      }`,
      extract: d => d.popularChannels || [],
    },
    {
      label: 'popularChannels(minimal)',
      query: `query GetChannels {
        popularChannels {
          id displayName callsign displayNumber
          images { small large }
          currentBroadcast { id startsAt show { title } }
          broadcasts(first: ${NUM_UPCOMING}) { ${BROADCAST_EDGES_MINIMAL} }
        }
      }`,
      extract: d => d.popularChannels || [],
    },
  ];

  for (const { label, query, extract } of attempts) {
    try {
      const { data, errors } = await gqlRaw(query, 'GetChannels', cookies);
      if (errors.length) {
        console.warn(`[philo] ${label} errors:`, errors.map(e => e.message));
        continue;
      }
      const nodes = extract(data);
      if (nodes.length) {
        console.log(`[philo] Got ${nodes.length} channels via ${label}`);
        return nodes.map(normaliseChannel);
      }
    } catch (err) {
      console.warn(`[philo] ${label} failed:`, err.message);
    }
  }
  return [];
}

// Decode HTML entities that Philo's API encodes in channel names
// e.g. "A&amp;E" -> "A&E", "Hallmark Movies &amp; Mysteries" -> "Hallmark Movies & Mysteries"
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

function normaliseChannel(ch) {
  const callsign = ch.callsign || '';
  const images   = ch.images   || {};
  const logo     = images.large || images.small ||
                   (callsign ? `${CDN_LOGOS}/${callsign}/large.png?ver=1&auto=webp` : null);

  // Extract broadcast_id from currentBroadcast
  const cb           = ch.currentBroadcast || {};
  const broadcastId  = cb.id || '';

  // Normalise broadcasts list (paginated connection -> flat)
  const bcConn   = ch.broadcasts || {};
  const bcEdges  = bcConn.edges || [];
  const broadcasts = bcEdges.map(e => e.node).filter(Boolean);

  return {
    id:           String(ch.id || ''),
    name:         htmlDecode(ch.displayName || ch.name || 'Unknown'),
    callsign,
    number:       String(ch.displayNumber || ch.number || ''),
    logo:         logo || null,
    broadcast_id: broadcastId,
    broadcasts,
  };
}

function philoCookiesAsString(cookies) {
  return cookies
    .filter(c => c.domain && c.domain.includes('philo'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Save to DB
// ─────────────────────────────────────────────────────────────────────────────
function savePhiloSource(sourceId, cookies, user, channels, ident) {
  const db     = getDb();
  const source = db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
  if (!source) return;

  const config    = JSON.parse(source.config);
  if (ident) {
    config.ident = String(ident).trim();
    config.email = config.email || config.ident;
  }
  config.cookies  = cookies;
  config.user     = { id: user.id, displayName: user.displayName };
  config.channels = channels.map(ch => ({
    id:         ch.id,
    name:       htmlDecode(ch.name),
    number:     ch.number || null,
    logo_url:   ch.logo   || null,
    stream_url: `philo://${ch.id}`,
    epg_id:     htmlDecode(ch.callsign || ch.name),
    group_name: 'Philo',
  }));

  db.prepare(`UPDATE sources SET config=?, last_sync=datetime('now') WHERE id=?`)
    .run(JSON.stringify(config), sourceId);

  db.prepare('DELETE FROM channels WHERE source_id=?').run(sourceId);
  const stmt = db.prepare(`
    INSERT INTO channels
      (source_id,name,number,logo_url,stream_url,stream_type,group_name,epg_id,enabled,sort_order)
    VALUES
      (@source_id,@name,@number,@logo_url,@stream_url,@stream_type,@group_name,@epg_id,@enabled,@sort_order)
  `);
  const insertMany = db.transaction(chs => { for (const c of chs) stmt.run(c); });
  insertMany(config.channels.map((ch, idx) => ({
    source_id:   sourceId,
    name:        htmlDecode(ch.name),
    number:      ch.number    || null,
    logo_url:    ch.logo_url  || null,
    stream_url:  ch.stream_url,
    stream_type: 'philo',
    group_name:  'Philo',
    epg_id:      htmlDecode(ch.epg_id || ch.name),
    enabled:     1,
    sort_order:  idx,
  })));

  // Save EPG data from broadcasts
  savePhiloEpg(db, channels);
}

// ─────────────────────────────────────────────────────────────────────────────
// EPG extraction -- converts Philo broadcasts to programs table rows
// ─────────────────────────────────────────────────────────────────────────────
function savePhiloEpg(db, channels) {
  const programs = [];

  for (const ch of channels) {
    const epgId = ch.callsign || ch.name;
    if (!epgId) continue;

    // Include currentBroadcast + broadcasts list
    const allBroadcasts = [];

    // Add broadcasts from the paginated list
    for (const bc of (ch.broadcasts || [])) {
      allBroadcasts.push(bc);
    }

    for (const bc of allBroadcasts) {
      const show = bc.show || {};
      const title = show.title;
      if (!title) continue;

      const startIso = bc.startsAt || '';
      const endIso   = bc.endsAt   || '';
      if (!startIso) continue;

      const startTs = parseIsoToUnix(startIso);
      const endTs   = endIso ? parseIsoToUnix(endIso) : startTs + 3600;
      if (!startTs) continue;

      programs.push({
        epg_id:      htmlDecode(epgId),
        title:       htmlDecode(title),
        description: htmlDecode(show.description) || null,
        category:    null,
        start_time:  startTs,
        end_time:    endTs,
        episode:     null,
        icon_url:    null,
      });
    }
  }

  if (!programs.length) return;

  // Delete existing Philo programs and replace with fresh data
  const epgIds = [...new Set(programs.map(p => p.epg_id))];
  const placeholders = epgIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM programs WHERE epg_id IN (${placeholders})`).run(...epgIds);

  const stmt = db.prepare(`
    INSERT INTO programs (epg_id, title, description, category, start_time, end_time, episode, icon_url)
    VALUES (@epg_id, @title, @description, @category, @start_time, @end_time, @episode, @icon_url)
  `);
  const insertMany = db.transaction(progs => { for (const p of progs) stmt.run(p); });
  insertMany(programs);
  console.log(`[philo] EPG: saved ${programs.length} programs for ${epgIds.length} channels`);
}

function parseIsoToUnix(iso) {
  try {
    return Math.floor(new Date(iso.replace('Z', '+00:00')).getTime() / 1000);
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/philo/epg/refresh
// Re-fetches channels+guide using stored cookies, updates programs table.
// Body: { source_id }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/epg/refresh', async (req, res) => {
  const { source_id } = req.body;
  if (!source_id) return res.status(400).json({ error: 'source_id required' });

  const db     = getDb();
  const source = db.prepare('SELECT * FROM sources WHERE id=?').get(source_id);
  if (!source) return res.status(404).json({ error: 'Source not found' });

  const config = JSON.parse(source.config);
  if (!config.cookies) return res.status(401).json({ error: 'Philo not paired -- login first' });

  try {
    // Fetch with more upcoming broadcasts for a wider guide window
    const channels = await gqlGetChannelsWithGuide(config.cookies);
    if (!channels.length) return res.status(502).json({ error: 'No channels returned from Philo' });

    savePhiloEpg(db, channels);
    res.json({ ok: true, programs_saved: channels.reduce((n, c) => n + (c.broadcasts || []).length, 0) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Wider guide window query -- used for EPG refresh (more broadcasts)
async function gqlGetChannelsWithGuide(cookies) {
  const NUM_UPCOMING = 24; // More slots for a fuller guide
  const BROADCAST_EDGES = 'edges { node { id startsAt endsAt show { title description } } }';
  const BROADCAST_EDGES_MINIMAL = 'edges { node { id startsAt show { title } } }';

  const attempts = [
    {
      label: 'availableChannels(guide)',
      query: `query GetChannels {
        availableChannels(order: NUMERIC, first: 300) {
          edges { node {
            id displayName callsign displayNumber
            images { small large }
            broadcasts(first: ${NUM_UPCOMING}) { ${BROADCAST_EDGES} }
          }}
        }
      }`,
      extract: d => ((d.availableChannels || {}).edges || []).map(e => e.node).filter(Boolean),
    },
    {
      label: 'popularChannels(guide)',
      query: `query GetChannels {
        popularChannels {
          id displayName callsign displayNumber
          images { small large }
          broadcasts(first: ${NUM_UPCOMING}) { ${BROADCAST_EDGES} }
        }
      }`,
      extract: d => d.popularChannels || [],
    },
    {
      label: 'availableChannels(guide-minimal)',
      query: `query GetChannels {
        availableChannels(order: NUMERIC, first: 300) {
          edges { node {
            id displayName callsign displayNumber
            images { small large }
            broadcasts(first: ${NUM_UPCOMING}) { ${BROADCAST_EDGES_MINIMAL} }
          }}
        }
      }`,
      extract: d => ((d.availableChannels || {}).edges || []).map(e => e.node).filter(Boolean),
    },
  ];

  for (const { label, query, extract } of attempts) {
    try {
      const { data, errors } = await gqlRaw(query, 'GetChannels', cookies);
      if (errors.length) { console.warn(`[philo] ${label} errors:`, errors.map(e => e.message)); continue; }
      const nodes = extract(data);
      if (nodes.length) {
        console.log(`[philo] Guide: ${nodes.length} channels via ${label}`);
        return nodes.map(normaliseChannel);
      }
    } catch (err) {
      console.warn(`[philo] ${label} failed:`, err.message);
    }
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// gqlGetCurrentBroadcastId -- fetch fresh broadcastId via availableChannels GQL
// ─────────────────────────────────────────────────────────────────────────────
async function gqlGetCurrentBroadcastId(channelId, cookies) {
  for (const { label, query, extract } of [
    { label: 'availableChannels',
      query: `query GetCurrentBroadcast { availableChannels(order: NUMERIC, first: 300) { edges { node { id currentBroadcast { id } } } } }`,
      extract: d => ((d.availableChannels || {}).edges || []).map(e => e.node).filter(Boolean) },
    { label: 'popularChannels',
      query: `query GetCurrentBroadcast { popularChannels { id currentBroadcast { id } } }`,
      extract: d => d.popularChannels || [] },
  ]) {
    try {
      const { data, errors } = await gqlRaw(query, 'GetCurrentBroadcast', cookies);
      if (errors && errors.length) continue;
      const match = extract(data).find(n => String(n.id) === String(channelId));
      if (match?.currentBroadcast?.id) {
        console.log(`[philo] Fresh broadcastId for ch${channelId} via ${label}: ${match.currentBroadcast.id}`);
        return match.currentBroadcast.id;
      }
    } catch (err) { console.warn(`[philo] ${label} failed:`, err.message); }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// navigateToChannel -- x11grab path only (Philo = Widevine DRM, no plain stream)
//
// Key fix for cookie auth:
//   Cookies are injected via storageState at context creation time, BEFORE any
//   navigation. This is the only reliable way -- addCookies() after navigation
//   does not work because Philo's SPA checks auth on first load.
// ─────────────────────────────────────────────────────────────────────────────
async function navigateToChannel(channelId, cookies, broadcastId, display, pulseSink) {
  // 1. Fresh broadcastId
  let activeBroadcastId = await gqlGetCurrentBroadcastId(channelId, cookies);
  if (!activeBroadcastId) {
    activeBroadcastId = broadcastId || null;
    if (activeBroadcastId) console.warn(`[philo] Using stale broadcastId for ch${channelId}`);
    else throw new Error(`No broadcastId for ch${channelId} -- cookies expired? Try Re-authenticate`);
  }

  display = display || process.env.DISPLAY || ':200';
  const playerUrl = `${PHILO_BASE}/player/player/broadcast/${activeBroadcastId}`;
  console.log(`[philo] Navigating to ${playerUrl} on display ${display}`);

  // 2. Parse cookie string into Playwright format
  const pwCookies = cookies.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
    const eq = pair.indexOf('=');
    return {
      name:   pair.slice(0, eq).trim(),
      value:  pair.slice(eq + 1).trim(),
      domain: '.philo.com',
      path:   '/',
      httpOnly: false,
      secure:   true,
      sameSite: 'None',
    };
  }).filter(c => c.name && c.value);

  // 3. Launch non-headless browser on the Xvfb display
  const bw = await getStreamBrowser(display, pulseSink);

  // 4. Create context with cookies pre-loaded via storageState
  //    This injects cookies BEFORE any navigation -- the only way Philo accepts them.
  const context = await bw.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:  { width: 1280, height: 720 },
    storageState: {
      cookies: pwCookies,
      origins: [],
    },
  });

  const page = await context.newPage();

  // 5. Navigate to player -- cookies pre-loaded via storageState
  try {
    await page.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch (_) {}
  console.log(`[philo] Landed on: ${page.url()}`);

  // 6. Inject fullscreen CSS + CDP window bounds immediately
  //    Do this before waiting for video -- x11grab starts right after this returns
  try {
    await page.evaluate(() => {
      if (document.getElementById('tvnow-fullscreen')) return;
      const s = document.createElement('style');
      s.id = 'tvnow-fullscreen';
      s.textContent = `
        [class*="overlay"],[class*="Overlay"],[class*="controls"],[class*="Controls"],
        [class*="nav"],[class*="Nav"],[class*="header"],[class*="Header"],
        [class*="banner"],[class*="Badge"],[class*="modal"],[class*="Modal"],
        [class*="tooltip"],[class*="Tooltip"],[class*="uiLayer"],[class*="PlayerUI"],
        [class*="stillWatching"],[class*="adOverlay"],[class*="pauseScreen"],[class*="endCard"]
        { opacity:0!important; visibility:hidden!important; }
        video { position:fixed!important; top:0!important; left:0!important;
                width:100vw!important; height:100vh!important; z-index:99999!important;
                object-fit:cover!important; background:#000!important; }
        body  { background:#000!important; overflow:hidden!important; margin:0!important; }
        *     { cursor:none!important; }
      `;
      document.head.appendChild(s);
      // Unmute video immediately if already loaded
      const v = document.querySelector('video');
      if (v) { v.muted = false; v.volume = 1.0; if (v.paused) v.play().catch(() => {}); }
    });
  } catch (_) {}

  // CDP fullscreen -- remove browser chrome
  try {
    const cdpFs = await context.newCDPSession(page);
    const { windowId } = await cdpFs.send('Browser.getWindowForTarget');
    await cdpFs.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
    await cdpFs.detach();
    console.log('[philo] CDP fullscreen applied');
  } catch (err) {
    try { await page.keyboard.press('F11'); } catch (_) {}
  }

  // 7. Click play (once, no waiting between retries)
  try {
    await page.evaluate(() => {
      const sels = ['[aria-label^="Play live"]','[aria-label*="Watch"]',
                    'button[class*="play"]','button[class*="Play"]',
                    '[class*="playButton"]','[class*="PlayButton"]'];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
          if (['watch live','watch','live','play'].some(w => t.includes(w))) { el.click(); return; }
        }
      }
    });
  } catch (_) {}

  // 10. Start background keepalive: dismiss "still watching" overlays,
  //     keep video playing, detect cookie expiry
  _startPhiloKeepalive(page, context, channelId => {
    // Cookie expiry callback -- mark session for restart
    console.warn(`[philo] Cookie expiry detected on ch${channelId || '?'} -- marking for re-auth`);
  });

  console.log('[philo] Browser ready for x11grab capture');
  return { page, context, display };
}

// ─────────────────────────────────────────────────────────────────────────────
// Background keepalive -- runs every 30s while the page is open
// Dismisses "still watching" overlays, keeps video playing,
// detects Philo error pages (expired cookies / session kicked)
// ─────────────────────────────────────────────────────────────────────────────
function _startPhiloKeepalive(page, context, onExpired) {
  let stopped = false;

  async function tick() {
    if (stopped || !page || page.isClosed()) return;
    try {
      const result = await page.evaluate(() => {
        // 1. Dismiss "still watching?" overlay
        const overlayBtns = [...document.querySelectorAll('button')].filter(b => {
          const t = (b.textContent || '').toLowerCase();
          return t.includes('still watching') || t.includes('continue') || t.includes('yes') || t.includes('keep watching');
        });
        if (overlayBtns.length) { overlayBtns[0].click(); return { action: 'dismissed_overlay' }; }

        // 2. Resume paused video
        const v = document.querySelector('video');
        if (v) {
          v.muted = false; v.volume = 1.0;
          if (v.paused || v.ended) { v.play(); return { action: 'resumed' }; }
        }

        // 3. Check for Philo error / login wall (cookie expiry signal)
        const isLoginPage = window.location.href.includes('/login') || window.location.href.includes('/authenticate');
        const hasSignInBtn = !!document.querySelector('[data-testid="sign-in"], button[class*="signIn"]');
        const hasErrorCode = /Error\s+code:\s*philo-\d+/i.test(document.body?.innerText || '');
        if (isLoginPage || hasSignInBtn || hasErrorCode) return { action: 'expired' };

        return { action: 'ok' };
      });

      if (result.action === 'expired') {
        console.warn('[philo] Session expired detected in keepalive');
        stopped = true;
        if (onExpired) onExpired();
        return;
      }
      if (result.action !== 'ok') {
        console.log(`[philo] Keepalive: ${result.action}`);
      }
    } catch (_) {}

    if (!stopped) setTimeout(tick, 30000);
  }

  // Allow video to stabilize before first keepalive check
  setTimeout(tick, 30000);

  // Return a stop function
  return () => { stopped = true; };
}

module.exports = router;
module.exports._channelPulse = _channelPulse;
module.exports.navigateToChannel    = navigateToChannel;
module.exports.releaseStreamBrowser = releaseStreamBrowser;
module.exports._createPulseSink     = _createPulseSink;
module.exports._destroyPulseSink    = _destroyPulseSink;


module.exports.gqlGetChannelsWithGuide = gqlGetChannelsWithGuide;
module.exports.savePhiloEpg            = savePhiloEpg;
module.exports.getStreamBrowser        = getStreamBrowser;
