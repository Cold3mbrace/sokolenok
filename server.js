// server.js
// SOKOLENOK v4.4 — clean rewrite.
// Только Node.js stdlib. Никаких npm зависимостей.
//
// Endpoints:
//   GET  /                       → public/index.html (landing)
//   GET  /dashboard              → public/dashboard.html
//   GET  /inventory              → public/inventory.html
//   GET  /lookup                 → public/lookup.html
//   GET  /settings               → public/settings.html
//
//   GET  /auth/steam             → Steam OpenID redirect
//   GET  /auth/steam/callback    → OpenID verify, set session cookie, redirect to /dashboard
//   POST /auth/logout            → clear session, redirect /
//
//   GET  /api/me                 → текущая сессия + профиль
//   GET  /api/health             → версия + backend storage
//   GET  /api/resolve?target=... → Steam URL/ID → SteamID64
//   GET  /api/profile/:steamid   → публичный профиль (XML или PlayerSummaries)
//   GET  /api/inventory/:steamid → инвентарь + цены + сохранение snapshot
//   GET  /api/inventory/history?steamid=... → история snapshots
//   GET  /api/news               → официальные новости CS2 (Steam News API)
//   GET  /api/stats/:steamid     → GetUserStatsForGame (требует STEAM_API_KEY)
//   GET  /api/faceit/:steamid    → Faceit профиль + lifetime + last matches (требует FACEIT_API_KEY)
//   GET  /api/prices?names=...   → текущие цены для items (cached)
//   GET  /api/price-history?name=...&currency=...&days=... → история цен
//   GET  /api/watchlist          → мой watchlist (требует session)
//   POST /api/watchlist          → добавить в watchlist
//   DELETE /api/watchlist        → удалить из watchlist
//   GET  /api/settings           → мои настройки
//   POST /api/settings           → обновить настройки

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./storage/db');
const wsHub = require('./lib/ws-hub');

// Transparently push every new notification through WebSocket to its recipient.
// We monkey-patch instead of editing each call-site (there are 5+ of them)
// so any future code that adds notifications will also benefit automatically.
// Push notification to ALL devices subscribed by this user.
// Removes subscriptions that the push service has rejected as gone (404/410)
// so the table stays clean. Best-effort: never throws.
async function pushToUser(steamId, payload) {
  if (!steamId || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return 0;
  const subs = db.listPushSubscriptions(steamId);
  if (!subs.length) return 0;
  const body = JSON.stringify(payload || {});
  let delivered = 0;
  await Promise.all(subs.map(async (sub) => {
    const r = await webPush.sendPush({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    }, body, {
      vapidPublic: VAPID_PUBLIC_KEY,
      vapidPrivate: VAPID_PRIVATE_KEY,
      contact: VAPID_CONTACT,
      ttl: 86400,
      urgency: 'normal'
    });
    if (r.ok) { delivered++; db.touchPushSubscription(sub.endpoint); return; }
    // 404 = endpoint gone forever (browser unsubscribed); 410 = expired
    if (r.status === 404 || r.status === 410) {
      db.deletePushSubscription(sub.endpoint);
    }
    // Other failures (network, 4xx other than gone) just log — the sub stays,
    // we'll retry on next event. Don't spam the log with every transient error.
  }));
  return delivered;
}

const _origCreateNotification = db.createNotification;
db.createNotification = function patchedCreateNotification(args) {
  const result = _origCreateNotification.call(db, args);
  // result === null means dedupe hit or self-notification — skip realtime too.
  if (!result || !args || !args.recipient) return result;

  // Realtime push to open tabs (instant in-app reaction)
  try {
    wsHub.sendTo(args.recipient, { type: 'notification:new', notification: {
      id: result.id,
      kind: args.kind,
      actor: args.actor,
      data: args.data || {},
      created_at: result.created_at,
      read_at: null
    }});
  } catch (_) { /* never let realtime kill the API */ }

  // Web Push to OS notification tray (works even when tab/browser is closed).
  // Only for kinds the user actually wants to see — lighten the spam:
  //   post_comment  → "Иван оставил коммент к твоему посту"
  //   message       → handled separately at insertMessage (carries text preview)
  //   friend_request, friend_accept → engagement-worthy
  // post_like and subscribe are intentionally NOT pushed — would be spammy.
  const PUSHABLE = new Set(['post_comment', 'friend_request', 'friend_accept']);
  if (PUSHABLE.has(args.kind)) {
    // Don't await — fire-and-forget so the API call returns immediately
    pushNotificationKind(args.recipient, args.kind, args.actor, args.data || {}).catch(() => {});
  }

  return result;
};

// Build a human-friendly title/body for a notification kind, then push it.
async function pushNotificationKind(recipient, kind, actorSteamId, data) {
  let actorName = actorSteamId || 'Кто-то';
  if (actorSteamId) {
    try {
      const u = db.getUser(actorSteamId);
      if (u?.persona_name) actorName = u.persona_name;
    } catch (_) {}
  }
  let title = 'SOKOLENOK';
  let body = '';
  let url = '/notifications';
  if (kind === 'post_comment') {
    title = `${actorName} прокомментировал`;
    body = data.preview ? String(data.preview).slice(0, 120) : 'Открыть пост';
    if (data.post_id) url = `/feed#post-${data.post_id}`;
  } else if (kind === 'friend_request') {
    title = `${actorName} хочет добавить в друзья`;
    body = 'Открыть запрос';
    url = '/friends';
  } else if (kind === 'friend_accept') {
    title = `${actorName} принял заявку в друзья`;
    body = 'Теперь вы можете переписываться';
    url = '/friends';
  }
  return pushToUser(recipient, { title, body, url, kind });
}

// `ws` is loaded lazily so the server still boots if npm install hasn't run
// yet — without it WS endpoints are simply unavailable and the frontend
// falls back to polling (same behaviour as a proxy that blocks Upgrade).
let WebSocketServer = null;
try { WebSocketServer = require('ws').WebSocketServer; } catch (_) {
  console.warn('[ws] "ws" module not installed — realtime disabled, polling fallback only. Run: npm install');
}

// Web Push (no npm deps, self-contained crypto)
const webPush = require('./lib/web-push');

// VAPID keys: prefer env vars, otherwise auto-generate on first boot and
// persist them in DATA_DIR/vapid.json so the same keys survive restarts.
// Changing keys later breaks all existing subscriptions (they're tied to the
// app-server identity), so we never regenerate if a file already exists.
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:admin@sokolenok.pro';

function ensureVapidKeys() {
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) return;
  const dataDir = process.env.SOKOLENOK_DATA_DIR ? path.resolve(process.env.SOKOLENOK_DATA_DIR) : path.join(__dirname, '.data');
  const vapidFile = path.join(dataDir, 'vapid.json');
  try {
    if (fs.existsSync(vapidFile)) {
      const j = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
      VAPID_PUBLIC_KEY = j.publicKey;
      VAPID_PRIVATE_KEY = j.privateKey;
      return;
    }
  } catch (_) { /* fall through to generation */ }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const k = webPush.generateVapidKeys();
    fs.writeFileSync(vapidFile, JSON.stringify(k, null, 2));
    fs.chmodSync(vapidFile, 0o600); // keys are secret
    VAPID_PUBLIC_KEY = k.publicKey;
    VAPID_PRIVATE_KEY = k.privateKey;
    console.log('[push] generated new VAPID keys → ' + vapidFile);
  } catch (e) {
    console.warn('[push] failed to initialize VAPID keys:', e?.message);
  }
}
ensureVapidKeys();

// ---------- config ----------
const APP_VERSION = 'v47.0.0';
const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.SOKOLENOK_DATA_DIR ? path.resolve(process.env.SOKOLENOK_DATA_DIR) : path.join(ROOT, '.data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB per image
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
const FACEIT_API_KEY = process.env.FACEIT_API_KEY || '';
// Mark session cookie Secure over HTTPS. Explicit COOKIE_SECURE=1/0 wins; otherwise
// inferred from an https:// BASE_URL.
const COOKIE_SECURE = process.env.COOKIE_SECURE != null
  ? (process.env.COOKIE_SECURE === '1' || process.env.COOKIE_SECURE === 'true')
  : /^https:\/\//i.test(process.env.BASE_URL || '');

// Admin access is granted by SteamID (NOT a password). Set ADMIN_STEAMIDS to a
// comma-separated list of 64-bit SteamIDs. These accounts see the admin panel.
const ADMIN_STEAMIDS = new Set(
  (process.env.ADMIN_STEAMIDS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
);
function isAdminSteamId(steamid) {
  return !!steamid && ADMIN_STEAMIDS.has(steamid);
}
// Superadmin = env admin (unremovable, can manage moderators).
function isSuperAdmin(steamid) {
  return isAdminSteamId(steamid);
}
// canModerate = superadmin OR a site moderator (bans, deletions, reports).
function canModerate(steamid) {
  return isSuperAdmin(steamid) || db.isModerator(steamid);
}

// ---------- message encryption at rest ----------
// DMs are stored encrypted with AES-256-GCM. The key is derived from MESSAGE_SECRET
// (or, if unset, from a file in the data dir so it's stable across restarts).
// This protects messages if the DB is read directly; it is NOT end-to-end.
let _msgKey = null;
function messageKey() {
  if (_msgKey) return _msgKey;
  let secret = process.env.MESSAGE_SECRET || '';
  if (!secret) {
    // Derive/persist a random secret in the data dir so restarts keep the same key.
    try {
      const p = path.join(process.env.SOKOLENOK_DATA_DIR || './.data', '.msgsecret');
      if (fs.existsSync(p)) {
        secret = fs.readFileSync(p, 'utf8').trim();
      } else {
        secret = crypto.randomBytes(48).toString('hex');
        try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
        fs.writeFileSync(p, secret, { mode: 0o600 });
      }
    } catch (_) {
      secret = 'sokolenok-insecure-fallback-key-change-me';
    }
  }
  _msgKey = crypto.createHash('sha256').update(secret).digest(); // 32 bytes
  return _msgKey;
}

function encryptMessage(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', messageKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // store as iv.tag.ciphertext, base64
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

function decryptMessage(blob) {
  try {
    const [ivB, tagB, dataB] = String(blob).split('.');
    const iv = Buffer.from(ivB, 'base64');
    const tag = Buffer.from(tagB, 'base64');
    const data = Buffer.from(dataB, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', messageKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (_) {
    return '[не удалось расшифровать]';
  }
}
const SESSION_COOKIE = 'sok_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const PRICE_CACHE_TTL_MS = Number(process.env.PRICE_CACHE_TTL_MS || 1000 * 60 * 60 * 6);
const PRICE_FETCH_LIMIT = Number(process.env.PRICE_FETCH_LIMIT || 80);
const INVENTORY_CONCURRENCY = 3;
const FETCH_TIMEOUT_MS = 8000;

const CURRENCIES = {
  RUB: { steam: '5', symbol: '₽', code: 'RUB', frac: 0 },
  USD: { steam: '1', symbol: '$', code: 'USD', frac: 2 },
  EUR: { steam: '3', symbol: '€', code: 'EUR', frac: 2 }
};

// ---------- mime ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

// ---------- helpers ----------
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location });
  res.end();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = decodeURIComponent(part.slice(i + 1).trim());
    if (k) out[k] = v;
  }
  return out;
}

function setSessionCookie(res, token) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  // Mark cookie Secure when serving over HTTPS (behind a TLS-terminating proxy).
  // Controlled by COOKIE_SECURE=1 or inferred from an https BASE_URL.
  if (COOKIE_SECURE) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (COOKIE_SECURE) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    // Sanity check: if BASE_URL is set without scheme, prepend https://
    let b = process.env.BASE_URL.replace(/\/$/, '');
    if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
    return b;
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  // Auto-detect scheme. Prefer X-Forwarded-Proto (set by nginx). Otherwise:
  // localhost → http; anything else (real domains) → https.
  // This is conservative: assumes you're not running production on bare http.
  let proto = req.headers['x-forwarded-proto'];
  if (!proto) proto = (host.startsWith('localhost') || host.startsWith('127.')) ? 'http' : 'https';
  return `${proto}://${host}`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Validate + normalize attachment from client.
// Allowed types: 'post', 'reply', 'forward'. Anything else → null.
function sanitizeAttachment(att) {
  if (!att || typeof att !== 'object') return null;
  const t = String(att.type || '');
  if (t === 'post') {
    const pid = parseInt(att.post_id, 10);
    if (!Number.isFinite(pid)) return null;
    return { type: 'post', post_id: pid };
  }
  if (t === 'reply') {
    const mid = parseInt(att.message_id, 10);
    if (!Number.isFinite(mid)) return null;
    return { type: 'reply', message_id: mid };
  }
  if (t === 'forward') {
    const mid = parseInt(att.message_id, 10);
    if (!Number.isFinite(mid)) return null;
    return { type: 'forward', message_id: mid };
  }
  return null;
}

// Enrich attachment with display data fetched fresh from the DB.
// We store only IDs in the encrypted blob; the rest is hydrated on read.
async function hydrateAttachment(att) {
  if (!att) return null;
  if (att.type === 'post') {
    try {
      const p = db.getPost(att.post_id);
      if (!p) return { type: 'post', missing: true };
      const pub = db.getPublic(p.public_id);
      return {
        type: 'post', post_id: p.id, public_id: p.public_id,
        public_name: pub?.name || null, public_avatar: pub?.avatar || null,
        title: p.title || '', body_preview: String(p.body || '').slice(0, 200),
        image: p.image || null
      };
    } catch (_) { return { type: 'post', missing: true }; }
  }
  if (att.type === 'reply' || att.type === 'forward') {
    try {
      const m = db.getMessage(att.message_id);
      if (!m) return { type: att.type, missing: true };
      const text = decryptMessage(m.body_enc);
      let author = null;
      try { author = await fetchProfile(m.sender_steam_id); } catch (_) {}
      return {
        type: att.type, message_id: m.id,
        author_steam_id: m.sender_steam_id,
        author_name: author?.personaname || m.sender_steam_id,
        author_avatar: author?.avatar || null,
        text_preview: String(text || '').slice(0, 280),
        created_at: m.created_at
      };
    } catch (_) { return { type: att.type, missing: true }; }
  }
  return null;
}

// Returns combined activity status: { online, last_seen, in_game }
// Respects target user's privacy: if show_activity is off, last_seen + online are hidden.
// Steam in_game is always public (it's Steam-side, we just relay).
function buildPresence(steamId, steamProfile) {
  const settings = steamId ? db.getSettings(steamId) : null;
  const showActivity = !settings || settings.show_activity !== 0;
  const lastSeen = showActivity ? db.getLastSeen(steamId) : null;
  let online = false;
  if (lastSeen) {
    const diffMs = Date.now() - Date.parse(lastSeen);
    online = diffMs >= 0 && diffMs < 2 * 60 * 1000; // <2min ago = online
  }
  let inGame = null;
  if (steamProfile?.gameid) {
    inGame = { id: String(steamProfile.gameid),
      name: steamProfile.gameextrainfo || (steamProfile.gameid === '730' ? 'Counter-Strike 2' : 'игра') };
  }
  return { online, last_seen: lastSeen, in_game: inGame, hidden: !showActivity, role: db.getUserRole(steamId) };
}

function renderOgTags({ title, desc, image, url }) {
  const t = escapeHtml(title || 'SOKOLENOK');
  const d = escapeHtml(desc || '');
  const i = escapeHtml(image || '');
  const u = escapeHtml(url || '');
  return [
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    i ? `<meta property="og:image" content="${i}">` : '',
    `<meta property="og:url" content="${u}">`,
    `<meta property="og:type" content="profile">`,
    `<meta property="og:site_name" content="SOKOLENOK">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    i ? `<meta name="twitter:image" content="${i}">` : '',
  ].filter(Boolean).join('\n  ');
}

function readBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let len = 0; const chunks = [];
    req.on('data', c => {
      len += c.length;
      if (len > maxBytes) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  try { const t = await readBody(req); return t ? JSON.parse(t) : {}; }
  catch (_) { return {}; }
}

// Read the full request body as a Buffer (for file uploads), with a hard size cap.
function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let len = 0; const chunks = [];
    req.on('data', c => {
      len += c.length;
      if (len > maxBytes) { req.destroy(); reject(new Error('too-large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Minimal multipart/form-data parser — extracts the first file part.
// Returns { filename, contentType, data: Buffer } or null.
function parseMultipartFile(buffer, contentTypeHeader) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader || '');
  const boundary = m && (m[1] || m[2]);
  if (!boundary) return null;
  const delim = Buffer.from('--' + boundary);
  // Split on boundary
  const parts = [];
  let start = buffer.indexOf(delim);
  if (start < 0) return null;
  start += delim.length;
  while (start < buffer.length) {
    // skip CRLF after boundary
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break; // closing --
    if (buffer[start] === 0x0d) start += 2;
    const next = buffer.indexOf(delim, start);
    if (next < 0) break;
    parts.push(buffer.slice(start, next - 2)); // strip trailing CRLF
    start = next + delim.length;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const header = part.slice(0, headerEnd).toString('utf8');
    if (!/filename="/i.test(header)) continue; // not a file part
    const fnMatch = /filename="([^"]*)"/i.exec(header);
    const ctMatch = /content-type:\s*([^\r\n]+)/i.exec(header);
    const data = part.slice(headerEnd + 4);
    return {
      filename: fnMatch ? fnMatch[1] : 'upload',
      contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
      data
    };
  }
  return null;
}

// Allowed image types -> extension
const IMAGE_TYPES = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp'
};
// Verify magic bytes match an image (defence beyond the declared content-type)
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return null;
}

function htmlDecode(s = '') {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s = '') {
  return htmlDecode(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return '';
  // Trim CDATA wrappers
  return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally { clearTimeout(t); }
}

function normalizeCurrency(input) {
  const code = String(input || '').toUpperCase();
  return CURRENCIES[code] || CURRENCIES.RUB;
}

function formatPrice(value, currency) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const c = normalizeCurrency(currency);
  const n = Number(value);
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: c.frac,
    maximumFractionDigits: c.frac
  }).format(n);
  return c.code === 'RUB' ? `${formatted} ${c.symbol}` : `${c.symbol}${formatted}`;
}

// Parse text like "157,50 руб." / "$0.47" / "1 234,00 ₽"
function parsePriceText(text = '') {
  if (!text) return null;
  const m = String(text).match(/[\d.,\s]+/);
  if (!m) return null;
  let n = m[0].replace(/\s/g, '');
  // Detect decimal separator: prefer last separator as decimal if both present
  const hasComma = n.includes(',');
  const hasDot = n.includes('.');
  if (hasComma && hasDot) {
    if (n.lastIndexOf(',') > n.lastIndexOf('.')) n = n.replace(/\./g, '').replace(',', '.');
    else n = n.replace(/,/g, '');
  } else if (hasComma) {
    n = n.replace(',', '.');
  }
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

// Resolve any kind of Steam input to a 17-digit SteamID64
function extractSteamTarget(input = '') {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const sid = raw.match(/\b(7656119\d{10})\b/);
  if (sid) return { type: 'steamid', value: sid[1] };
  const profile = raw.match(/steamcommunity\.com\/profiles\/(\d{17})/);
  if (profile) return { type: 'steamid', value: profile[1] };
  const vanity = raw.match(/steamcommunity\.com\/id\/([^\/?#]+)/);
  if (vanity) return { type: 'vanity', value: vanity[1] };
  if (/^[a-zA-Z0-9_-]{2,32}$/.test(raw)) return { type: 'vanity', value: raw };
  return null;
}

async function resolveVanityToSteamId(vanity) {
  if (!STEAM_API_KEY) return null;
  try {
    const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_API_KEY}&vanityurl=${encodeURIComponent(vanity)}`;
    const r = await fetchWithTimeout(url);
    if (!r.ok) return null;
    const j = await r.json();
    if (j?.response?.success === 1) return j.response.steamid;
  } catch (_) {}
  return null;
}

async function resolveSteamId(target) {
  if (!target) return null;
  if (target.type === 'steamid') return target.value;
  if (target.type === 'vanity') {
    const fromApi = await resolveVanityToSteamId(target.value);
    if (fromApi) return fromApi;
    // Fallback: fetch /id/<vanity>?xml=1 and read <steamID64>
    try {
      const r = await fetchWithTimeout(`https://steamcommunity.com/id/${encodeURIComponent(target.value)}/?xml=1`);
      if (r.ok) {
        const xml = await r.text();
        const sid = xmlTag(xml, 'steamID64');
        if (sid) return sid;
      }
    } catch (_) {}
  }
  return null;
}

// ---------- profile fetch ----------
function profileSkeleton(steamid, source) {
  return {
    steamid,
    personaname: '',
    avatar: '',
    avatarfull: '',
    profileurl: `https://steamcommunity.com/profiles/${steamid}/`,
    communityvisibilitystate: 0,
    profilestate: 0,
    realname: '',
    country: '',
    state: 'unknown',
    source,
    fetched_at: db.nowIso()
  };
}

async function fetchProfile(steamid) {
  // Try Steam API first (richer data)
  if (STEAM_API_KEY) {
    try {
      const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamid}`;
      const r = await fetchWithTimeout(url);
      if (r.ok) {
        const j = await r.json();
        const p = j?.response?.players?.[0];
        if (p) {
          return {
            steamid: p.steamid,
            personaname: p.personaname,
            avatar: p.avatar,
            avatarfull: p.avatarfull || p.avatarmedium || p.avatar,
            profileurl: p.profileurl,
            communityvisibilitystate: p.communityvisibilitystate,
            profilestate: p.profilestate,
            realname: p.realname || '',
            country: p.loccountrycode || '',
            timecreated: p.timecreated || null,
            state: 'ok',
            source: 'steam-api',
            fetched_at: db.nowIso()
          };
        }
      }
    } catch (_) {}
  }
  // Public XML fallback (no key needed)
  try {
    const r = await fetchWithTimeout(`https://steamcommunity.com/profiles/${steamid}/?xml=1`);
    if (r.ok) {
      const xml = await r.text();
      const visibility = xmlTag(xml, 'privacyState') === 'public' ? 3 : 1;
      return {
        steamid,
        personaname: stripTags(xmlTag(xml, 'steamID')) || '',
        avatar: stripTags(xmlTag(xml, 'avatarIcon')) || '',
        avatarfull: stripTags(xmlTag(xml, 'avatarFull')) || stripTags(xmlTag(xml, 'avatarMedium')) || '',
        profileurl: stripTags(xmlTag(xml, 'customURL'))
          ? `https://steamcommunity.com/id/${stripTags(xmlTag(xml, 'customURL'))}/`
          : `https://steamcommunity.com/profiles/${steamid}/`,
        communityvisibilitystate: visibility,
        profilestate: 1,
        realname: stripTags(xmlTag(xml, 'realname')),
        country: stripTags(xmlTag(xml, 'location')),
        state: 'ok',
        source: 'steam-xml',
        fetched_at: db.nowIso()
      };
    }
  } catch (_) {}
  return { ...profileSkeleton(steamid, 'fallback'), state: 'unreachable' };
}

// ---------- inventory fetch ----------
function classifyInventoryError(status, body = '') {
  if (status === 403) return 'private';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'steam-error';
  if (status === 404) return 'not-found';
  return body ? 'unknown-error' : 'empty';
}

function normalizeInventory(j) {
  const descs = new Map();
  for (const d of (j.descriptions || [])) {
    descs.set(`${d.classid}_${d.instanceid}`, d);
  }
  const items = [];
  for (const a of (j.assets || [])) {
    const d = descs.get(`${a.classid}_${a.instanceid}`);
    if (!d) continue;
    const name = d.market_hash_name || d.name || '';
    if (!name) continue;
    items.push({
      assetid: a.assetid,
      classid: a.classid,
      instanceid: a.instanceid,
      market_hash_name: name,
      market_name: d.market_name || name,
      name: d.name || name,
      type: d.type || '',
      tradable: !!d.tradable,
      marketable: !!d.marketable,
      icon_url: d.icon_url ? `https://community.akamai.steamstatic.com/economy/image/${d.icon_url}/256fx256f` : '',
      tags: (d.tags || []).map(t => ({ category: t.category, name: t.localized_tag_name || t.name, internal_name: t.internal_name })),
      color: d.name_color || ''
    });
  }
  return items;
}

async function fetchInventoryItems(steamid) {
  // Try newer steamcommunity inventory endpoint
  const url = `https://steamcommunity.com/inventory/${steamid}/730/2?l=russian&count=2000`;
  try {
    const r = await fetchWithTimeout(url);
    const text = await r.text();
    if (!r.ok) {
      const reason = classifyInventoryError(r.status, text);
      return { items: [], status: reason, http_status: r.status };
    }
    let j;
    try { j = JSON.parse(text); } catch (_) { return { items: [], status: 'parse-error' }; }
    if (!j || j.success === false) return { items: [], status: 'private' };
    if (!Array.isArray(j.assets) || !Array.isArray(j.descriptions)) {
      return { items: [], status: 'empty' };
    }
    return { items: normalizeInventory(j), status: 'ok' };
  } catch (e) {
    return { items: [], status: 'network-error', error: String(e?.message || e) };
  }
}

// ---------- pricing ----------
async function fetchSteamMarketPrice(marketHashName, currency) {
  const c = normalizeCurrency(currency);
  const url = `https://steamcommunity.com/market/priceoverview/?currency=${c.steam}&appid=730&market_hash_name=${encodeURIComponent(marketHashName)}`;
  try {
    const r = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }, 6000);
    if (r.status === 429) return { ok: false, reason: 'rate-limited' };
    if (!r.ok) return { ok: false, reason: `http-${r.status}` };
    const j = await r.json();
    if (!j || j.success !== true) return { ok: false, reason: 'no-data' };
    const text = j.lowest_price || j.median_price || '';
    const value = parsePriceText(text);
    if (value == null) return { ok: false, reason: 'unparseable' };
    return { ok: true, value, text };
  } catch (e) {
    return { ok: false, reason: 'network', error: String(e?.message || e) };
  }
}

async function getPriceWithCache(marketHashName, currency) {
  const c = normalizeCurrency(currency);
  const cached = db.getPrice(marketHashName, c.code, 'steam');
  if (cached && (Date.now() - new Date(cached.fetched_at).getTime() < PRICE_CACHE_TTL_MS)) {
    return { ...cached, cached: true };
  }
  const fresh = await fetchSteamMarketPrice(marketHashName, c.code);
  if (fresh.ok) {
    db.setPrice({
      market_name: marketHashName,
      currency: c.code,
      source: 'steam',
      price_value: fresh.value,
      price_text: fresh.text
    });
    return {
      market_name: marketHashName, currency: c.code, source: 'steam',
      price_value: fresh.value, price_text: fresh.text,
      fetched_at: db.nowIso(), cached: false
    };
  }
  // If fresh failed but we have any cached, return stale
  if (cached) return { ...cached, cached: true, stale: true, reason: fresh.reason };
  return { market_name: marketHashName, currency: c.code, source: 'steam',
    price_value: null, price_text: null, fetched_at: null, cached: false, reason: fresh.reason };
}

async function pricedInventory(items, currency) {
  const c = normalizeCurrency(currency);
  // Unique market_hash_names, but keep the items list intact (multiple of same item = stack)
  const uniqueNames = Array.from(new Set(items.map(i => i.market_hash_name))).slice(0, PRICE_FETCH_LIMIT);
  const skippedDueToLimit = Math.max(0, new Set(items.map(i => i.market_hash_name)).size - uniqueNames.length);
  const priceMap = new Map();
  let unpricedCount = 0;
  // Limited concurrency
  const queue = uniqueNames.slice();
  async function worker() {
    while (queue.length) {
      const name = queue.shift();
      const p = await getPriceWithCache(name, c.code);
      priceMap.set(name, p);
      if (p.price_value == null) unpricedCount++;
    }
  }
  await Promise.all(Array.from({ length: INVENTORY_CONCURRENCY }, worker));

  // For names beyond fetch limit, try cache only
  const overflowNames = Array.from(new Set(items.map(i => i.market_hash_name))).slice(PRICE_FETCH_LIMIT);
  for (const name of overflowNames) {
    const cached = db.getPrice(name, c.code, 'steam');
    if (cached) priceMap.set(name, { ...cached, cached: true });
  }

  // Attach prices to items
  let totalValue = 0; let pricedItems = 0;
  const enriched = items.map(it => {
    const p = priceMap.get(it.market_hash_name) || null;
    const priceValue = p && p.price_value != null ? Number(p.price_value) : null;
    if (priceValue != null) { totalValue += priceValue; pricedItems++; }
    return {
      ...it,
      price_value: priceValue,
      price_text: p?.price_text || (priceValue != null ? formatPrice(priceValue, c.code) : null),
      price_source: p?.source || null,
      price_currency: c.code,
      price_cached: p?.cached || false,
      price_stale: !!p?.stale,
      price_reason: p && p.price_value == null ? (p.reason || 'no-data') : null
    };
  });

  return {
    items: enriched,
    currency: c.code,
    total_value: pricedItems > 0 ? Number(totalValue.toFixed(c.frac)) : null,
    total_value_text: pricedItems > 0 ? formatPrice(totalValue, c.code) : null,
    priced_items: pricedItems,
    unpriced_items: enriched.length - pricedItems,
    unique_names: new Set(items.map(i => i.market_hash_name)).size,
    fetched_unique_names: uniqueNames.length,
    skipped_due_to_limit: skippedDueToLimit,
    fetch_limit: PRICE_FETCH_LIMIT
  };
}

// ---------- news ----------
function extractFirstImage(html = '') {
  if (!html) return null;
  // Steam mixes raw HTML and BBCode in contents.
  // 1) <img src="...">
  const imgTag = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgTag) return imgTag[1];
  // 2) [img]...[/img] BBCode
  const bb = html.match(/\[img\]([^\[]+)\[\/img\]/i);
  if (bb) return bb[1];
  // 3) bare URL ending in image extension
  const bareUrl = html.match(/https?:\/\/[^\s"'<>\]\)]+\.(?:jpg|jpeg|png|gif|webp)/i);
  if (bareUrl) return bareUrl[0];
  return null;
}

function stripBBCode(s = '') {
  return String(s)
    .replace(/\[img\][^\[]*\[\/img\]/gi, '')          // remove images
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1') // keep link text
    .replace(/\[\/?(b|i|u|h\d|list|\*|previewyoutube)[^\]]*\]/gi, '') // strip formatting
    .replace(/\[[^\]]*\]/g, '');                       // catch-all leftover tags
}

async function fetchSteamNews(count = 8) {
  // GetNewsForApp doesn't need API key.
  // tags=patchnotes filters to actual patch notes; feeds=steam_community_announcements
  // gives the official announcements. We ask for a few extra and trim client-side.
  const url = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=${Math.max(count * 2, 12)}&maxlength=600&format=json`;
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) return { ok: false, status: `http-${r.status}`, items: [] };
    const j = await r.json();
    const raw = j?.appnews?.newsitems || [];
    const items = raw
      // Prefer official Steam Community announcements; fall back to any.
      .map(n => {
        const image = extractFirstImage(n.contents || '');
        const cleanText = stripTags(stripBBCode(n.contents || '')).slice(0, 280);
        const feedScore =
          n.feedname === 'steam_community_announcements' ? 3 :
          n.feedlabel === 'Community Announcements' ? 3 :
          n.feedname === 'cs2_blog' ? 2 :
          n.feedlabel === 'Counter-Strike 2' ? 2 :
          1;
        return {
          gid: n.gid,
          title: stripTags(n.title || ''),
          url: n.url,
          author: n.author || '',
          contents: cleanText,
          image,
          feedlabel: n.feedlabel || n.feedname || '',
          date: n.date ? new Date(n.date * 1000).toISOString() : null,
          _score: feedScore + (image ? 1 : 0)
        };
      })
      .sort((a, b) => {
        // Newer + officialer first
        const ta = a.date ? Date.parse(a.date) : 0;
        const tb = b.date ? Date.parse(b.date) : 0;
        if (b._score !== a._score) return b._score - a._score;
        return tb - ta;
      })
      .slice(0, count)
      .map(({ _score, ...rest }) => rest);
    return { ok: true, items };
  } catch (e) {
    return { ok: false, status: 'network', items: [], error: String(e?.message || e) };
  }
}

// 15-minute in-memory cache for news (avoids hammering Steam on every refresh)
const NEWS_CACHE_TTL_MS = 15 * 60 * 1000;
let _newsCache = null; // { fetchedAt, count, data }

async function getCachedNews(count) {
  const now = Date.now();
  if (_newsCache && _newsCache.count >= count && (now - _newsCache.fetchedAt) < NEWS_CACHE_TTL_MS) {
    return { ...(_newsCache.data), items: _newsCache.data.items.slice(0, count), cached: true };
  }
  const data = await fetchSteamNews(Math.max(count, 8));
  if (data.ok) {
    _newsCache = { fetchedAt: now, count: data.items.length, data };
  } else if (_newsCache) {
    // Fetch failed but we have something — return stale rather than 0 items
    return { ...(_newsCache.data), items: _newsCache.data.items.slice(0, count), cached: true, stale: true };
  }
  return { ...data, items: (data.items || []).slice(0, count), cached: false };
}

// ---------- Faceit (Data API v4) ----------
// Docs: https://developers.faceit.com/docs/tools/data-api
// All endpoints require Bearer token in Authorization header.
const FACEIT_API_BASE = 'https://open.faceit.com/data/v4';

// In-memory cache: { key: { fetchedAt, data } } — different TTLs per data kind
const _faceitCache = new Map();
const FACEIT_PROFILE_TTL_MS = 15 * 60 * 1000; // profile changes rarely
const FACEIT_HISTORY_TTL_MS = 3 * 60 * 1000;  // history might have new matches
const FACEIT_STATS_TTL_MS   = 10 * 60 * 1000; // aggregate stats

async function faceitFetch(pathAndQuery, ttlMs) {
  if (!FACEIT_API_KEY) return { ok: false, reason: 'no-api-key' };
  const cacheKey = pathAndQuery;
  const cached = _faceitCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < ttlMs) {
    return { ok: true, data: cached.data, cached: true };
  }
  try {
    const r = await fetchWithTimeout(FACEIT_API_BASE + pathAndQuery, {
      headers: { 'Authorization': `Bearer ${FACEIT_API_KEY}`, 'Accept': 'application/json' }
    });
    if (r.status === 404) return { ok: false, reason: 'not-found' };
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'auth-error', status: r.status };
    if (r.status === 429) return { ok: false, reason: 'rate-limited' };
    if (!r.ok) return { ok: false, reason: `http-${r.status}` };
    const data = await r.json();
    _faceitCache.set(cacheKey, { fetchedAt: Date.now(), data });
    return { ok: true, data, cached: false };
  } catch (e) {
    return { ok: false, reason: 'network', error: String(e?.message || e) };
  }
}

// Find Faceit player by SteamID64 (preferred) or nickname.
async function faceitFindPlayer({ steamid, nickname }) {
  if (steamid && /^\d{17}$/.test(steamid)) {
    return faceitFetch(`/players?game=cs2&game_player_id=${encodeURIComponent(steamid)}`, FACEIT_PROFILE_TTL_MS);
  }
  if (nickname) {
    return faceitFetch(`/players?nickname=${encodeURIComponent(nickname)}`, FACEIT_PROFILE_TTL_MS);
  }
  return { ok: false, reason: 'no-identifier' };
}

async function faceitMatchHistory(playerId, limit = 20) {
  const lim = Math.min(50, Math.max(1, Number(limit) || 20));
  return faceitFetch(`/players/${encodeURIComponent(playerId)}/history?game=cs2&limit=${lim}&offset=0`, FACEIT_HISTORY_TTL_MS);
}

async function faceitLifetimeStats(playerId) {
  return faceitFetch(`/players/${encodeURIComponent(playerId)}/stats/cs2`, FACEIT_STATS_TTL_MS);
}

async function faceitMatchStats(matchId) {
  return faceitFetch(`/matches/${encodeURIComponent(matchId)}/stats`, FACEIT_STATS_TTL_MS);
}

// Pull per-match Faceit stats for each item in the history, in parallel with a small concurrency window.
// Returns the merged list ready for the frontend.
async function enrichMatchesWithStats(rawMatches, playerId) {
  // Build base entries (synchronous data from history endpoint)
  const base = rawMatches.map(m => {
    const teams = m.teams || {};
    const ourTeamKey = Object.keys(teams).find(k => (teams[k].players || []).some(pl => pl.player_id === playerId));
    const ourTeam = ourTeamKey ? teams[ourTeamKey] : null;
    const otherTeamKey = Object.keys(teams).find(k => k !== ourTeamKey);
    const otherTeam = otherTeamKey ? teams[otherTeamKey] : null;
    const winner = m.results?.winner;
    const isWin = winner && winner === ourTeamKey;
    const score = m.results?.score;
    return {
      match_id: m.match_id,
      started_at: m.started_at ? new Date(m.started_at * 1000).toISOString() : null,
      finished_at: m.finished_at ? new Date(m.finished_at * 1000).toISOString() : null,
      map: (m.voting?.map?.pick && m.voting.map.pick[0]) || (m.i1 || ''),
      game_mode: m.game_mode || '5v5',
      competition_name: m.competition_name || 'Matchmaking',
      our_team_name: ourTeam?.nickname || '',
      our_score: ourTeamKey && score ? score[ourTeamKey] : null,
      opp_team_name: otherTeam?.nickname || '',
      opp_score: otherTeamKey && score ? score[otherTeamKey] : null,
      is_win: isWin,
      faceit_url: m.faceit_url ? m.faceit_url.replace('{lang}', 'ru') : null,
      // Stats placeholders — filled by enrichment below
      kills: null, deaths: null, assists: null, kd: null, kr: null,
      hs: null, hs_pct: null, adr: null, mvps: null, rounds: null,
      stats_ok: false
    };
  });

  // Concurrency: 3 parallel match-stats requests at a time
  const CONCURRENCY = 3;
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= base.length) return;
      const item = base[idx];
      if (!item.match_id) continue;
      const r = await faceitMatchStats(item.match_id);
      if (!r.ok) continue;
      // Faceit returns rounds[0].teams[].players[] with per-player stat objects
      try {
        const round = r.data?.rounds?.[0];
        if (!round) continue;
        item.rounds = Number(round.round_stats?.Rounds || null) || null;
        // Try to fill the map from round_stats — voting.map.pick in history is often empty
        if (!item.map) {
          const m1 = round.round_stats?.Map || round.round_stats?.['Map'];
          if (m1) item.map = String(m1);
        }
        // Find the player in either team
        let stats = null;
        for (const t of (round.teams || [])) {
          const pl = (t.players || []).find(p => p.player_id === playerId);
          if (pl) { stats = pl.player_stats || {}; break; }
        }
        if (!stats) continue;
        const num = v => (v == null || v === '' ? null : Number(v));
        item.kills    = num(stats['Kills']);
        item.deaths   = num(stats['Deaths']);
        item.assists  = num(stats['Assists']);
        item.kd       = num(stats['K/D Ratio']);
        item.kr       = num(stats['K/R Ratio']);
        item.hs       = num(stats['Headshots']);
        item.hs_pct   = num(stats['Headshots %']);
        item.adr      = num(stats['ADR']) || num(stats['Average Damage per Round']);
        item.mvps     = num(stats['MVPs']);
        item.triple   = num(stats['Triple Kills']);
        item.quad     = num(stats['Quadro Kills']);
        item.ace      = num(stats['Penta Kills']);
        item.stats_ok = true;
      } catch (_) { /* ignore individual failures */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, base.length) }, worker));
  return base;
}

// Build a unified summary that the frontend can render directly.
// Combines: profile, lifetime stats, last N matches (with per-match metrics).
async function buildFaceitSummary({ steamid, nickname, matchCount = 10 }) {
  const playerRes = await faceitFindPlayer({ steamid, nickname });
  if (!playerRes.ok) return { ok: false, reason: playerRes.reason || 'lookup-failed' };
  const p = playerRes.data;
  const cs2 = p?.games?.cs2 || {};
  const playerId = p?.player_id;
  if (!playerId) return { ok: false, reason: 'no-cs2-data' };

  // Parallel pulls for stats + history
  const [statsRes, histRes] = await Promise.all([
    faceitLifetimeStats(playerId),
    faceitMatchHistory(playerId, matchCount)
  ]);

  const lifetime = statsRes.ok ? (statsRes.data?.lifetime || {}) : {};
  const segments = statsRes.ok ? (statsRes.data?.segments || []) : [];

  // Faceit lifetime keys come as strings — coerce common ones to numbers
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const headline = {
    matches:        num(lifetime['Matches']),
    wins:           num(lifetime['Wins']),
    winrate:        num(lifetime['Win Rate %']),
    kdRatio:        num(lifetime['Average K/D Ratio']),
    headshotsPct:   num(lifetime['Average Headshots %']),
    longestWinStreak: num(lifetime['Longest Win Streak']),
    currentWinStreak: num(lifetime['Current Win Streak']),
    recentResults:    lifetime['Recent Results'] || [],
    totalMatches:   num(lifetime['Total Matches']) || num(lifetime['Matches'])
  };

  // Per-map breakdown
  const maps = segments
    .filter(s => s.type === 'Map')
    .map(s => ({
      map: s.label || s.mode || '',
      matches: num(s.stats['Matches']),
      wins:    num(s.stats['Wins']),
      winrate: num(s.stats['Win Rate %']),
      kd:      num(s.stats['Average K/D Ratio']),
      hsPct:   num(s.stats['Average Headshots %']),
      kills:   num(s.stats['Kills']),
      deaths:  num(s.stats['Deaths'])
    }))
    .filter(m => m.matches && m.matches > 0)
    .filter(m => isCs2Map(m.map))   // drop legacy CS:GO-only maps (Office, ar_monastery, etc.)
    .sort((a, b) => (b.matches || 0) - (a.matches || 0));

  // Last matches list — enrich each with per-match stats (K/D, HS%, ADR, etc.)
  // We cap concurrency to avoid hitting Faceit rate limits.
  const rawMatches = histRes.ok ? (histRes.data?.items || []).slice(0, matchCount) : [];
  const recentMatches = await enrichMatchesWithStats(rawMatches, playerId);

  // Aggregate teammates across the full history window: who you played with most,
  // how many games together and win rate in those games.
  const teammates = aggregateTeammates(histRes.ok ? (histRes.data?.items || []) : [], playerId);

  return {
    ok: true,
    profile: {
      player_id: playerId,
      nickname: p.nickname,
      country: p.country || null,
      avatar: p.avatar || null,
      faceit_url: p.faceit_url ? p.faceit_url.replace('{lang}', 'ru') : null,
      verified: !!p.verified,
      memberships: p.memberships || [],
      cs2: {
        skill_level: cs2.skill_level || null,
        faceit_elo:  cs2.faceit_elo  || null,
        game_player_name: cs2.game_player_name || null,
        region: cs2.region || null
      }
    },
    headline,
    maps,
    recentMatches,
    teammates,
    notes: { source: 'Faceit Data API v4', scope: 'cs2' }
  };
}

// Build a "played with" list from match history. For each other player on the user's team,
// count games together and wins together.
function aggregateTeammates(items, playerId) {
  const acc = {}; // player_id -> { nickname, avatar, games, wins }
  for (const m of items) {
    const teams = m.teams || {};
    const ourKey = Object.keys(teams).find(k => (teams[k].players || []).some(pl => pl.player_id === playerId));
    if (!ourKey) continue;
    const won = m.results?.winner === ourKey;
    for (const pl of (teams[ourKey].players || [])) {
      if (pl.player_id === playerId) continue; // skip self
      const id = pl.player_id;
      if (!acc[id]) acc[id] = { player_id: id, nickname: pl.nickname || '—', avatar: pl.avatar || null, games: 0, wins: 0 };
      acc[id].games += 1;
      if (won) acc[id].wins += 1;
    }
  }
  return Object.values(acc)
    .map(t => ({ ...t, winrate: t.games ? Math.round((t.wins / t.games) * 100) : null }))
    .filter(t => t.games >= 2) // only people you played with more than once
    .sort((a, b) => b.games - a.games)
    .slice(0, 8);
}

// CS2 map pool (active duty + commonly played). Legacy CS:GO maps like Office,
// ar_monastery, Cobblestone, etc. are filtered out of stats.
const CS2_MAPS = new Set([
  'de_mirage', 'de_inferno', 'de_nuke', 'de_overpass', 'de_vertigo', 'de_ancient',
  'de_anubis', 'de_dust2', 'de_train', 'de_cache', 'de_cbble', 'de_tuscan',
  'mirage', 'inferno', 'nuke', 'overpass', 'vertigo', 'ancient', 'anubis',
  'dust2', 'dust ii', 'dust 2', 'train', 'cache'
]);
function isCs2Map(name) {
  if (!name) return false;
  const k = String(name).toLowerCase().trim();
  if (CS2_MAPS.has(k)) return true;
  // Be lenient: accept any de_ map we don't explicitly know, but block known legacy/AR/CS maps
  const legacy = ['office', 'monastery', 'ar_', 'cs_', 'baggage', 'shoots', 'lake', 'house', 'assault', 'militia', 'agency', 'italy', 'cbble', 'cobblestone', 'canals', 'zoo', 'abbey'];
  if (legacy.some(l => k.includes(l))) return false;
  return k.startsWith('de_') || CS2_MAPS.has(k);
}

// ---------- stats (CS2 UserStats) ----------
function pickStat(map, names) {
  for (const n of names) {
    if (n in map) return Number(map[n]);
  }
  return null;
}

function buildStatsSummary(stats = []) {
  const map = {};
  for (const s of stats) map[s.name] = s.value;
  const kills = pickStat(map, ['total_kills']);
  const deaths = pickStat(map, ['total_deaths']);
  const time = pickStat(map, ['total_time_played']);
  // Steam tracks competitive wins per map and total played count.
  // GetUserStatsForGame DOES NOT return a clean "matches played" — total_matches_played
  // is actually competitive-only and includes pre-CS2 data. The 'wins' counter is per-map
  // wins (so wins/matches can exceed 100%). We expose the caveat in `notes`.
  const winsByMap = pickStat(map, ['total_wins']);
  const matchesPlayed = pickStat(map, ['total_matches_played']);
  const matchesWon = pickStat(map, ['total_matches_won']);
  const mvps = pickStat(map, ['total_mvps']);
  const planted = pickStat(map, ['total_planted_bombs']);
  const defused = pickStat(map, ['total_defused_bombs']);
  const headshots = pickStat(map, ['total_kills_headshot']);
  const shotsFired = pickStat(map, ['total_shots_fired']);
  const shotsHit = pickStat(map, ['total_shots_hit']);
  const kd = (kills && deaths) ? Number((kills / deaths).toFixed(2)) : null;
  const hsRate = (kills && headshots) ? Number(((headshots / kills) * 100).toFixed(1)) : null;
  const accuracy = (shotsFired && shotsHit) ? Number(((shotsHit / shotsFired) * 100).toFixed(1)) : null;
  // Use the proper matches_won / matches_played pair for winrate — clamp to 100 just in case.
  let winrate = null;
  if (matchesPlayed && matchesWon) {
    winrate = Number(((matchesWon / matchesPlayed) * 100).toFixed(1));
    if (winrate > 100) winrate = 100;
  }
  const hours = time != null ? Number((time / 3600).toFixed(1)) : null;
  return {
    headline: {
      kills, deaths, kd, hsRate, accuracy, winrate,
      matches: matchesPlayed, wins: matchesWon, winsByMap,
      hours, mvps, planted, defused
    },
    weapons: extractWeapons(map),
    maps: extractMaps(map),
    raw: map,
    // Caveats — frontend can show these so users understand what these numbers represent
    notes: {
      source: 'Steam GetUserStatsForGame',
      scope: 'cs:go + cs2 lifetime',
      explanation: 'Steam отдаёт суммарные значения за всю историю CS (CS:GO + CS2). ' +
                   'Детальная статистика «только CS2» доступна через парсинг матчей через Game Coordinator — в этом MVP не подключено.',
      winrate_basis: 'competitive matches only'
    }
  };
}

function extractWeapons(map) {
  const re = /^total_kills_(\w+)$/;
  const out = [];
  for (const [k, v] of Object.entries(map)) {
    const m = k.match(re);
    if (!m) continue;
    const weapon = m[1];
    if (weapon === 'headshot' || weapon === 'enemy_weapon' || weapon === 'against_zoomed_sniper'
        || weapon === 'knife_fight' || weapon === 'enemy_blinded' || weapon === 'while_blinded') continue;
    const hits = map[`total_hits_${weapon}`] || 0;
    const shots = map[`total_shots_${weapon}`] || 0;
    out.push({
      weapon,
      kills: Number(v) || 0,
      hits: Number(hits) || 0,
      shots: Number(shots) || 0,
      accuracy: shots ? Number(((hits / shots) * 100).toFixed(1)) : null
    });
  }
  return out.sort((a, b) => b.kills - a.kills).slice(0, 20);
}

function extractMaps(map) {
  const re = /^total_wins_map_(\w+)$/;
  const out = [];
  for (const [k, v] of Object.entries(map)) {
    const m = k.match(re); if (!m) continue;
    const name = m[1];
    const rounds = map[`total_rounds_map_${name}`] || 0;
    out.push({
      map: name,
      wins: Number(v) || 0,
      rounds: Number(rounds) || 0,
      winrate: rounds ? Number(((Number(v) / Number(rounds)) * 100).toFixed(1)) : null
    });
  }
  return out.sort((a, b) => b.rounds - a.rounds).slice(0, 12);
}

async function fetchCs2Stats(steamid) {
  if (!STEAM_API_KEY) {
    return { ok: false, reason: 'no-api-key', items: [], summary: null };
  }
  try {
    const url = `https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?appid=730&key=${STEAM_API_KEY}&steamid=${steamid}`;
    const r = await fetchWithTimeout(url);
    if (!r.ok) return { ok: false, reason: `http-${r.status}`, items: [], summary: null };
    const j = await r.json();
    const stats = j?.playerstats?.stats || [];
    if (!stats.length) return { ok: false, reason: 'private-or-empty', items: [], summary: null };
    return { ok: true, items: stats, summary: buildStatsSummary(stats), persona_name: j?.playerstats?.playerName || null };
  } catch (e) {
    return { ok: false, reason: 'network', items: [], summary: null, error: String(e?.message || e) };
  }
}

// ---------- Leetify (public profile API) ----------
// No API key required. Returns 200+data if the player has a public Leetify profile
// linked to this SteamID. Returns 404 / empty if not.
const _leetifyCache = new Map();
const LEETIFY_CACHE_TTL_MS = 15 * 60 * 1000;

async function fetchLeetifyProfile(steamid) {
  const cached = _leetifyCache.get(steamid);
  if (cached && (Date.now() - cached.fetchedAt) < LEETIFY_CACHE_TTL_MS) {
    return { ok: true, data: cached.data, cached: true };
  }
  try {
    const r = await fetchWithTimeout(`https://api.leetify.com/api/profile/id/${encodeURIComponent(steamid)}`);
    if (r.status === 404) return { ok: false, reason: 'not-found' };
    if (!r.ok) return { ok: false, reason: `http-${r.status}` };
    const j = await r.json();
    // Their schema varies; we normalize what's useful for our UI
    const out = {
      steam64Id: j.steam64Id || j.steam_id || steamid,
      meta: {
        name: j.meta?.name || j.name || null,
        steamProfileUrl: j.meta?.steamProfileUrl || null,
        platformBans: j.meta?.platformBans || null,
        faceitNickname: j.meta?.faceitNickname || null
      },
      ranks: j.ranks || j.recentGameRatings || null,
      stats: j.stats || j.recentTeammates || null,
      total_matches: j.total_matches || j.totalMatchesPlayed || null,
      // Recent matches (CS2 + Premier + Faceit etc — they merge sources)
      games: Array.isArray(j.games) ? j.games.slice(0, 25) : (Array.isArray(j.matches) ? j.matches.slice(0, 25) : []),
      raw_keys: Object.keys(j) // for debugging during dev
    };
    _leetifyCache.set(steamid, { fetchedAt: Date.now(), data: out });
    return { ok: true, data: out, cached: false };
  } catch (e) {
    return { ok: false, reason: 'network', error: String(e?.message || e) };
  }
}

// ---------- bans (Steam GetPlayerBans) ----------
// Cached in memory for 10 minutes — bans don't change often
const _bansCache = new Map();
const BANS_CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchPlayerBans(steamid) {
  if (!STEAM_API_KEY) return { ok: false, reason: 'no-api-key' };
  const cached = _bansCache.get(steamid);
  if (cached && (Date.now() - cached.fetchedAt) < BANS_CACHE_TTL_MS) {
    return { ok: true, data: cached.data, cached: true };
  }
  try {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${STEAM_API_KEY}&steamids=${steamid}`;
    const r = await fetchWithTimeout(url);
    if (!r.ok) return { ok: false, reason: `http-${r.status}` };
    const j = await r.json();
    const entry = (j?.players || [])[0];
    if (!entry) return { ok: false, reason: 'not-found' };
    const data = {
      community_banned:    !!entry.CommunityBanned,
      vac_banned:          !!entry.VACBanned,
      number_of_vac_bans:  Number(entry.NumberOfVACBans || 0),
      days_since_last_ban: Number(entry.DaysSinceLastBan || 0),
      number_of_game_bans: Number(entry.NumberOfGameBans || 0),
      economy_ban:         String(entry.EconomyBan || 'none')
    };
    _bansCache.set(steamid, { fetchedAt: Date.now(), data });
    return { ok: true, data, cached: false };
  } catch (e) {
    return { ok: false, reason: 'network', error: String(e?.message || e) };
  }
}

// ---------- request handler ----------
const _lastSeenCache = new Map(); // steam_id -> ms timestamp of last DB write
const LAST_SEEN_THROTTLE_MS = 60 * 1000;

function getRequestSteamId(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const s = db.getSession(token);
  const sid = s?.steam_id || null;
  if (sid) {
    const now = Date.now();
    const last = _lastSeenCache.get(sid) || 0;
    if (now - last > LAST_SEEN_THROTTLE_MS) {
      _lastSeenCache.set(sid, now);
      try { db.touchLastSeen(sid); } catch (_) {}
    }
  }
  return sid;
}

async function handleSteamOpenId(req, res, parsedUrl) {
  const base = getBaseUrl(req);
  if (parsedUrl.pathname === '/auth/steam') {
    const returnTo = `${base}/auth/steam/callback`;
    const params = new URLSearchParams({
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'checkid_setup',
      'openid.return_to': returnTo,
      'openid.realm': base,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
    });
    return redirect(res, `https://steamcommunity.com/openid/login?${params.toString()}`);
  }
  if (parsedUrl.pathname === '/auth/steam/callback') {
    const q = parsedUrl.searchParams;
    const claimed = q.get('openid.claimed_id') || '';
    const match = claimed.match(/https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})/);
    if (!match) return redirect(res, '/?auth=failed');

    // Verify with Steam (recommended). If verification fails (e.g. network), still accept the claimed_id
    // — fail-open here is acceptable because we only use the steamid as a public identifier.
    const steamid = match[1];
    try {
      const verifyParams = new URLSearchParams();
      for (const [k, v] of q) verifyParams.set(k, v);
      verifyParams.set('openid.mode', 'check_authentication');
      const r = await fetchWithTimeout('https://steamcommunity.com/openid/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: verifyParams.toString()
      }, 6000);
      const t = r.ok ? await r.text() : '';
      if (t && !/is_valid\s*:\s*true/.test(t)) {
        // explicit failure
        return redirect(res, '/?auth=invalid');
      }
    } catch (_) { /* fail open */ }

    const profile = await fetchProfile(steamid);
    db.upsertUser(profile);
    const { token } = db.createSession(steamid);
    setSessionCookie(res, token);
    db.logEvent('login', steamid, { source: profile.source });
    return redirect(res, '/dashboard');
  }
  if (parsedUrl.pathname === '/auth/logout') {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (token) { db.deleteSession(token); db.logEvent('logout', null, { token: token.slice(0, 6) + '…' }); }
    clearSessionCookie(res);
    return redirect(res, '/');
  }
  return false;
}

async function handleApi(req, res, pathname, query) {
  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      version: APP_VERSION,
      node: process.version,
      has_steam_api_key: Boolean(STEAM_API_KEY),
      storage: db.storageHealth()
    });
  }

  // ---------- file upload (images) ----------
  if (pathname === '/api/upload' && req.method === 'POST') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    if (db.isUserBanned(me)) return sendJson(res, 403, { ok: false, error: 'banned' });
    let buf;
    try { buf = await readBodyBuffer(req, MAX_UPLOAD_BYTES + 64 * 1024); }
    catch (e) { return sendJson(res, 413, { ok: false, error: 'too-large' }); }
    const file = parseMultipartFile(buf, req.headers['content-type']);
    if (!file || !file.data || !file.data.length) return sendJson(res, 400, { ok: false, error: 'no-file' });
    if (file.data.length > MAX_UPLOAD_BYTES) return sendJson(res, 413, { ok: false, error: 'too-large' });
    // Validate it's really an image by magic bytes
    const ext = sniffImage(file.data);
    if (!ext) return sendJson(res, 400, { ok: false, error: 'not-an-image' });
    // Save
    try {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, name), file.data);
      db.logEvent('upload', me, { name, bytes: file.data.length });
      return sendJson(res, 200, { ok: true, url: `/uploads/${name}` });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: 'save-failed' });
    }
  }

  // List my notifications. GET marks them all as read.
  if (pathname === '/api/notifications' && req.method === 'GET') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const rows = db.listNotifications(me, 50);
    // Hydrate with actor profile info
    const out = [];
    for (const n of rows) {
      let actor = null;
      if (n.actor_steam_id) {
        try { actor = await fetchProfile(n.actor_steam_id); } catch (_) {}
      }
      let data = null;
      if (n.data_json) { try { data = JSON.parse(n.data_json); } catch (_) {} }
      out.push({
        id: n.id, kind: n.kind, data,
        actor: actor ? {
          steam_id: n.actor_steam_id,
          name: actor.personaname || n.actor_steam_id,
          avatar: actor.avatar || null,
          role: db.getUserRole(n.actor_steam_id)
        } : (n.actor_steam_id ? { steam_id: n.actor_steam_id, name: n.actor_steam_id } : null),
        created_at: n.created_at,
        read: !!n.read_at
      });
    }
    // Mark unread as read after delivering them
    db.markNotificationsRead(me);
    return sendJson(res, 200, { ok: true, notifications: out });
  }

  // Quick count for badge — no side effects
  if (pathname === '/api/notifications/count' && req.method === 'GET') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 200, { ok: true, unread: 0 });
    return sendJson(res, 200, { ok: true, unread: db.countUnreadNotifications(me) });
  }

  // ---------- Web Push ----------
  // Public VAPID key — frontend needs it to call PushManager.subscribe(). No auth required.
  if (pathname === '/api/push/key' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, publicKey: VAPID_PUBLIC_KEY || null });
  }
  // Save / refresh this device's subscription
  if (pathname === '/api/push/subscribe' && req.method === 'POST') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const body = await readJsonBody(req);
    const sub = body && body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return sendJson(res, 400, { ok: false, error: 'bad-subscription' });
    }
    db.savePushSubscription({
      endpoint: String(sub.endpoint),
      steam_id: me,
      p256dh: String(sub.keys.p256dh),
      auth: String(sub.keys.auth),
      user_agent: String(req.headers['user-agent'] || '').slice(0, 255)
    });
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/push/unsubscribe' && req.method === 'POST') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const body = await readJsonBody(req);
    const endpoint = body?.endpoint;
    if (!endpoint) return sendJson(res, 400, { ok: false, error: 'no-endpoint' });
    db.deletePushSubscription(String(endpoint));
    return sendJson(res, 200, { ok: true });
  }
  // Test push — send a sample notification to the calling user (debug / settings UI)
  if (pathname === '/api/push/test' && req.method === 'POST') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return sendJson(res, 503, { ok: false, error: 'push-not-configured' });
    }
    const sent = await pushToUser(me, {
      title: 'SOKOLENOK',
      body: 'Тестовое push-уведомление — всё работает!',
      url: '/dashboard'
    });
    return sendJson(res, 200, { ok: true, delivered: sent });
  }

  if (pathname === '/api/me') {
    const steamid = getRequestSteamId(req);
    if (!steamid) return sendJson(res, 200, { logged_in: false, profile: null, settings: null });
    const user = db.getUser(steamid);
    let profile = null;
    try { profile = user ? JSON.parse(user.profile_json) : null; } catch (_) {}
    if (!profile) profile = await fetchProfile(steamid);
    const settings = db.getSettings(steamid);
    return sendJson(res, 200, { logged_in: true, steamid, profile, settings,
      is_admin: canModerate(steamid),
      is_superadmin: isSuperAdmin(steamid),
      consented: !!settings.consent_at });
  }

  if (pathname === '/api/consent' && req.method === 'POST') {
    const steamid = getRequestSteamId(req);
    if (!steamid) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    db.setSettings(steamid, { consent_at: db.nowIso() });
    db.logEvent('consent', steamid, {});
    return sendJson(res, 200, { ok: true });
  }

  // ---------- user reports (complaints) ----------
  if (pathname === '/api/report' && req.method === 'POST') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const body = await readJsonBody(req);
    const types = ['user', 'post', 'public', 'reputation', 'message', 'support'];
    const target_type = String(body.target_type || '');
    let target_id = String(body.target_id || '');
    const reason = String(body.reason || '').slice(0, 1000);
    if (!types.includes(target_type)) return sendJson(res, 400, { ok: false, error: 'bad-target' });
    if (target_type === 'support') {
      if (!reason.trim()) return sendJson(res, 400, { ok: false, error: 'empty-message' });
      target_id = 'support'; // no object, it's a support request
    } else if (!target_id) {
      return sendJson(res, 400, { ok: false, error: 'bad-target' });
    }
    db.createReport({ reporter_steam_id: me, target_type, target_id, reason });
    db.logEvent('report', me, { target_type, target_id });
    return sendJson(res, 200, { ok: true });
  }

  // ---------- admin (gated by SteamID) ----------
  if (pathname.startsWith('/api/admin/')) {
    const me = getRequestSteamId(req);
    if (!canModerate(me)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    const sub = pathname.slice('/api/admin/'.length);

    // ----- moderator management (SUPERADMIN ONLY) -----
    if (sub === 'moderators' && req.method === 'GET') {
      if (!isSuperAdmin(me)) return sendJson(res, 403, { ok: false, error: 'superadmin-only' });
      const mods = db.listModerators();
      const enriched = [];
      for (const m of mods) {
        let p = null; try { p = await fetchProfile(m.steam_id); } catch (_) {}
        enriched.push({ ...m, name: p?.personaname || m.steam_id });
      }
      return sendJson(res, 200, { ok: true, moderators: enriched });
    }
    if (sub.startsWith('moderator/') && req.method === 'POST') {
      if (!isSuperAdmin(me)) return sendJson(res, 403, { ok: false, error: 'superadmin-only' });
      const parts = sub.slice('moderator/'.length).split('/');
      const target = parts[0];
      const action = parts[1];
      if (!/^\d{17}$/.test(target)) return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });
      if (action === 'add') { db.addModerator(target, me); db.logEvent('mod-grant', me, { target }); return sendJson(res, 200, { ok: true }); }
      if (action === 'remove') { db.removeModerator(target); db.logEvent('mod-revoke', me, { target }); return sendJson(res, 200, { ok: true }); }
      return sendJson(res, 400, { ok: false, error: 'bad-action' });
    }

    // ----- ROLES (SUPERADMIN ONLY) -----
    // GET    /api/admin/roles                      → list roles with members
    // POST   /api/admin/roles                      → create role  {name, color, sort_order}
    // PATCH  /api/admin/roles/:id                  → update role  {name?, color?, sort_order?}
    // DELETE /api/admin/roles/:id                  → delete role + memberships
    // POST   /api/admin/roles/:id/members/:sid     → add member
    // DELETE /api/admin/roles/:id/members/:sid     → remove member
    if (sub === 'roles' && req.method === 'GET') {
      if (!isSuperAdmin(me)) return sendJson(res, 403, { ok: false, error: 'superadmin-only' });
      const roles = db.listRoles();
      const enriched = [];
      for (const r of roles) {
        const members = db.listRoleMembers(r.id);
        const memberDetails = [];
        for (const m of members) {
          let p = null; try { p = await fetchProfile(m.steam_id); } catch (_) {}
          memberDetails.push({ steam_id: m.steam_id, name: p?.personaname || m.steam_id, avatar: p?.avatar || null, created_at: m.created_at });
        }
        enriched.push({ ...r, members: memberDetails });
      }
      return sendJson(res, 200, { ok: true, roles: enriched });
    }
    if (sub === 'roles' && req.method === 'POST') {
      if (!isSuperAdmin(me)) return sendJson(res, 403, { ok: false, error: 'superadmin-only' });
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { ok: false, error: 'name-required' });
      const role = db.createRole({ name, color: body.color, sort_order: body.sort_order });
      db.logEvent('role-create', me, { id: role.id, name: role.name });
      return sendJson(res, 200, { ok: true, role });
    }
    if (sub.startsWith('roles/')) {
      if (!isSuperAdmin(me)) return sendJson(res, 403, { ok: false, error: 'superadmin-only' });
      const parts = sub.slice('roles/'.length).split('/');
      const roleId = parseInt(parts[0], 10);
      if (!Number.isFinite(roleId)) return sendJson(res, 400, { ok: false, error: 'bad-id' });
      // /roles/:id  PATCH/DELETE
      if (parts.length === 1) {
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const body = await readJsonBody(req);
          const r = db.updateRole(roleId, body);
          if (r.error) return sendJson(res, 404, { ok: false, error: r.error });
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          db.deleteRole(roleId);
          db.logEvent('role-delete', me, { id: roleId });
          return sendJson(res, 200, { ok: true });
        }
      }
      // /roles/:id/members/:sid  POST/DELETE
      if (parts[1] === 'members' && parts[2]) {
        const sid = parts[2];
        if (!/^\d{17}$/.test(sid)) return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });
        if (req.method === 'POST') { db.addRoleMember(roleId, sid, me); db.logEvent('role-add-member', me, { role: roleId, sid }); return sendJson(res, 200, { ok: true }); }
        if (req.method === 'DELETE') { db.removeRoleMember(roleId, sid); return sendJson(res, 200, { ok: true }); }
      }
      return sendJson(res, 400, { ok: false, error: 'bad-action' });
    }

    if (sub === 'stats' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, stats: db.adminStats() });
    }
    if (sub === 'reports' && req.method === 'GET') {
      const status = query.get('status') || 'open';
      const reports = db.listReports(status);
      const enriched = [];
      for (const r of reports) {
        let rep = null;
        try { rep = await fetchProfile(r.reporter_steam_id); } catch (_) {}
        enriched.push({ ...r, reporter_name: rep?.personaname || r.reporter_steam_id });
      }
      return sendJson(res, 200, { ok: true, reports: enriched });
    }
    if (sub.startsWith('reports/') && req.method === 'POST') {
      const id = sub.slice('reports/'.length).split('/')[0];
      const body = await readJsonBody(req);
      const status = body.status === 'dismissed' ? 'dismissed' : 'resolved';
      db.resolveReport(id, status, me);
      return sendJson(res, 200, { ok: true });
    }
    if (sub === 'bans' && req.method === 'GET') {
      const bans = db.listBans();
      const enriched = [];
      for (const b of bans) {
        let p = null; try { p = await fetchProfile(b.steam_id); } catch (_) {}
        enriched.push({ ...b, name: p?.personaname || b.steam_id });
      }
      return sendJson(res, 200, { ok: true, bans: enriched });
    }
    if (sub.startsWith('ban/') && req.method === 'POST') {
      const target = sub.slice('ban/'.length).split('/')[0];
      if (!/^\d{17}$/.test(target)) return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });
      if (isAdminSteamId(target)) return sendJson(res, 400, { ok: false, error: 'cant-ban-admin' });
      const body = await readJsonBody(req);
      db.banUser(target, String(body.reason || '').slice(0, 300), me);
      db.logEvent('admin-ban', me, { target });
      return sendJson(res, 200, { ok: true });
    }
    if (sub.startsWith('unban/') && req.method === 'POST') {
      const target = sub.slice('unban/'.length).split('/')[0];
      db.unbanUser(target);
      db.logEvent('admin-unban', me, { target });
      return sendJson(res, 200, { ok: true });
    }
    if (sub === 'publics' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, publics: db.listPublics() });
    }
    if (sub.startsWith('public/') && req.method === 'POST') {
      const parts = sub.slice('public/'.length).split('/');
      const pid = decodeURIComponent(parts[0]);
      const action = parts[1];
      if (action === 'delete') { db.deletePublic(pid); db.logEvent('admin-del-public', me, { pid }); return sendJson(res, 200, { ok: true }); }
      if (action === 'verify') { db.setPublicVerified(pid, true); return sendJson(res, 200, { ok: true }); }
      if (action === 'unverify') { db.setPublicVerified(pid, false); return sendJson(res, 200, { ok: true }); }
    }
    if (sub === 'posts' && req.method === 'GET') {
      const posts = db.listPosts({ limit: 100 });
      return sendJson(res, 200, { ok: true, posts });
    }
    if (sub.startsWith('post/') && req.method === 'POST') {
      const parts = sub.slice('post/'.length).split('/');
      const postId = parts[0];
      if (parts[1] === 'delete') { db.deletePost(postId); db.logEvent('admin-del-post', me, { postId }); return sendJson(res, 200, { ok: true }); }
    }
    return sendJson(res, 404, { ok: false, error: 'unknown-admin-endpoint' });
  }

  // Search players by persona name (among users who logged in here at least once)
  if (pathname === '/api/search') {
    const q = (query.get('q') || '').trim();
    const kind = query.get('kind') || 'all';
    if (q.length < 2) return sendJson(res, 200, { ok: true, users: [], posts: [], publics: [], results: [] });
    const out = { ok: true };
    if (kind === 'all' || kind === 'users') {
      out.users = db.searchUsers(q, kind === 'users' ? 30 : 6);
    }
    if (kind === 'all' || kind === 'publics') {
      const pubs = db.searchPublics(q, kind === 'publics' ? 30 : 6);
      out.publics = pubs.map(p => ({
        id: p.id, name: p.name, description: p.description, avatar: p.avatar,
        verified: !!p.verified
      }));
    }
    if (kind === 'all' || kind === 'posts') {
      const posts = db.searchPosts(q, kind === 'posts' ? 30 : 6);
      out.posts = posts.map(p => {
        const pub = db.getPublic(p.public_id);
        const lower = (p.body || '').toLowerCase();
        const idx = lower.indexOf(q.toLowerCase());
        let snippet = '';
        if (idx >= 0) {
          const start = Math.max(0, idx - 40);
          const end = Math.min(p.body.length, idx + q.length + 60);
          snippet = (start > 0 ? '…' : '') + p.body.slice(start, end) + (end < p.body.length ? '…' : '');
        } else {
          snippet = (p.body || '').slice(0, 120);
        }
        return {
          id: p.id, title: p.title, snippet,
          public_id: p.public_id,
          public_name: pub?.name || p.public_id,
          public_avatar: pub?.avatar || null,
          created_at: p.created_at
        };
      });
    }
    out.results = out.users || [];
    return sendJson(res, 200, out);
  }

  if (pathname === '/api/resolve') {
    const raw = query.get('target') || '';
    const target = extractSteamTarget(raw);
    if (!target) return sendJson(res, 400, { ok: false, error: 'invalid-input' });
    const steamid = await resolveSteamId(target);
    if (!steamid) return sendJson(res, 404, { ok: false, error: 'not-found', target });
    return sendJson(res, 200, { ok: true, steamid, target });
  }

  // Batch presence lookup — list of steam_ids → presence objects.
  // POST /api/presence  { ids: ["7656...", ...] }
  if (pathname === '/api/presence' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.filter(x => /^\d{17}$/.test(x)).slice(0, 100) : [];
    const out = {};
    const now = Date.now();
    const FRESH_MS = 3 * 60 * 1000; // 3 min: how stale profile is allowed
    const refreshable = []; // IDs to refresh from Steam (active users with stale profile)
    for (const id of ids) {
      let p = null;
      let updatedAtMs = 0;
      try {
        const u = db.getUser(id);
        if (u?.profile_json) { try { p = JSON.parse(u.profile_json); } catch (_) {} }
        updatedAtMs = u?.updated_at ? Date.parse(u.updated_at) : 0;
      } catch (_) {}
      // Active = seen on the site in the last 2 min
      const lastSeen = db.getLastSeen(id);
      const isActive = lastSeen && (now - Date.parse(lastSeen)) < 2 * 60 * 1000;
      if (isActive && (now - updatedAtMs) > FRESH_MS) {
        refreshable.push(id);
      }
      out[id] = buildPresence(id, p);
    }
    // Refresh in background (don't block response); use Steam API for active users only.
    // Cap to 10 per request so we don't get rate-limited.
    if (refreshable.length) {
      const batch = refreshable.slice(0, 10);
      Promise.all(batch.map(id => fetchProfile(id).then(p => p && db.upsertUser(p)).catch(() => {})));
    }
    return sendJson(res, 200, { ok: true, presence: out });
  }

  if (pathname.match(/^\/api\/profile\/\d{17}\/activity$/)) {
    const steamid = pathname.split('/')[3];
    const posts = db.listPostsByAuthor(steamid, 30);
    const comments = db.listCommentsByAuthor(steamid, 30);
    const items = [];
    for (const p of posts) {
      const pub = db.getPublic(p.public_id);
      items.push({
        kind: 'post',
        post_id: p.id, public_id: p.public_id,
        public_name: pub?.name || p.public_id,
        public_avatar: pub?.avatar || null,
        title: p.title, body: (p.body || '').slice(0, 240),
        image: p.image, created_at: p.created_at
      });
    }
    for (const c of comments) {
      const pub = c.post_public_id ? db.getPublic(c.post_public_id) : null;
      items.push({
        kind: 'comment',
        post_id: c.post_id, public_id: c.post_public_id,
        public_name: pub?.name || c.post_public_id || '',
        public_avatar: pub?.avatar || null,
        post_title: c.post_title || null,
        body: (c.body || '').slice(0, 240),
        created_at: c.created_at
      });
    }
    items.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return sendJson(res, 200, { ok: true, steamid, items: items.slice(0, 40) });
  }

  if (pathname.startsWith('/api/profile/')) {
    const steamid = decodeURIComponent(pathname.slice('/api/profile/'.length).split('/')[0] || '').trim();
    if (!/^\d{17}$/.test(steamid)) return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });
    const profile = await fetchProfile(steamid);
    db.upsertUser(profile);
    const presence = buildPresence(steamid, profile);
    // Attach cover_url from user_settings (per-user banner image, optional)
    const userSettings = db.getSettings(steamid);
    const cover_url = userSettings?.cover_url || null;
    return sendJson(res, 200, { ok: true, profile, presence, cover_url });
  }

  if (pathname.startsWith('/api/inventory/history')) {
    const steamid = query.get('steamid') || getRequestSteamId(req);
    if (!steamid || !/^\d{17}$/.test(steamid)) return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });
    const snapshots = db.listInventorySnapshots(steamid, 30);
    return sendJson(res, 200, { ok: true, steamid, snapshots });
  }

  if (pathname.startsWith('/api/inventory/')) {
    const steamid = decodeURIComponent(pathname.slice('/api/inventory/'.length).split('/')[0] || '').trim();
    if (!/^\d{17}$/.test(steamid)) return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });

    const sessionSteamId = getRequestSteamId(req);
    const settings = sessionSteamId ? db.getSettings(sessionSteamId) : null;
    const currency = normalizeCurrency(query.get('currency') || settings?.currency || 'RUB');
    const skipPrices = query.get('no_prices') === '1';
    const cachedOk = query.get('cached_ok') === '1';
    const force = query.get('force') === '1';

    // Cache layer: serve a recent priced payload instantly when the client allows it.
    // Skipped when prices are not requested (cheap anyway) or a force refresh is asked.
    const INV_CACHE_FRESH_MS = 10 * 60 * 1000;  // ≤10 min → fresh
    const INV_CACHE_STALE_MS = 24 * 60 * 60 * 1000; // ≤24h → stale-but-serveable
    if (cachedOk && !skipPrices && !force) {
      try {
        const c = db.getInventoryCache(steamid, currency.code);
        if (c) {
          const age = Date.now() - Date.parse(c.fetched_at);
          if (age <= INV_CACHE_STALE_MS) {
            return sendJson(res, 200, {
              ...c.payload,
              cached: true,
              stale: age > INV_CACHE_FRESH_MS,
              cache_age_ms: age
            });
          }
        }
      } catch (_) { /* fall through to live fetch */ }
    }

    const fetched = await fetchInventoryItems(steamid);
    if (fetched.status !== 'ok') {
      return sendJson(res, 200, {
        ok: false,
        steamid,
        status: fetched.status,
        error: fetched.error || null,
        http_status: fetched.http_status || null,
        items: [],
        total_items: 0,
        pricing: null,
        currency: currency.code
      });
    }
    let pricing = null;
    if (skipPrices) {
      pricing = {
        items: fetched.items.map(i => ({ ...i, price_value: null, price_text: null, price_currency: currency.code })),
        currency: currency.code, total_value: null, total_value_text: null,
        priced_items: 0, unpriced_items: fetched.items.length,
        unique_names: new Set(fetched.items.map(i => i.market_hash_name)).size,
        fetched_unique_names: 0, skipped_due_to_limit: 0, fetch_limit: PRICE_FETCH_LIMIT
      };
    } else {
      pricing = await pricedInventory(fetched.items, currency.code);
    }

    // Save snapshot (only sample items for storage size)
    try {
      const top10 = pricing.items
        .filter(i => i.price_value != null)
        .sort((a, b) => b.price_value - a.price_value)
        .slice(0, 10)
        .map(i => ({ name: i.market_name, value: i.price_value, currency: currency.code }));
      db.saveInventorySnapshot({
        steam_id: steamid,
        currency: currency.code,
        total_items: pricing.items.length,
        total_value: pricing.total_value,
        total_value_text: pricing.total_value_text,
        status: 'ok',
        items: top10,
        pricing: {
          priced_items: pricing.priced_items,
          unpriced_items: pricing.unpriced_items,
          unique_names: pricing.unique_names,
          fetched_unique_names: pricing.fetched_unique_names,
          skipped_due_to_limit: pricing.skipped_due_to_limit
        }
      });
    } catch (_) {}

    const payload = {
      ok: true,
      steamid,
      status: 'ok',
      items: pricing.items,
      total_items: pricing.items.length,
      total_value: pricing.total_value,
      total_value_text: pricing.total_value_text,
      currency: currency.code,
      pricing: {
        priced_items: pricing.priced_items,
        unpriced_items: pricing.unpriced_items,
        unique_names: pricing.unique_names,
        fetched_unique_names: pricing.fetched_unique_names,
        skipped_due_to_limit: pricing.skipped_due_to_limit,
        fetch_limit: pricing.fetch_limit
      }
    };

    // Save to cache (only full priced payloads — skipPrices payloads aren't worth caching)
    if (!skipPrices) {
      try { db.setInventoryCache(steamid, currency.code, payload); } catch (_) {}
    }

    return sendJson(res, 200, { ...payload, cached: false });
  }

  if (pathname === '/api/news') {
    const count = Math.min(20, Math.max(3, Number(query.get('count') || 10)));
    const news = await getCachedNews(count);
    return sendJson(res, 200, news);
  }

  // Unified feed: official CS2 news (virtual public "official") + posts from publics
  // the user is subscribed to. Anonymous users see official news only.
  if (pathname === '/api/feed') {
    const me = getRequestSteamId(req);
    const scope = query.get('scope') || 'all'; // 'all' | 'subs' | 'official' | 'hot'
    const items = [];
    const _debug = { authed: !!me, scope, news_count: 0, posts_count: 0, posts_total: 0 };

    // Official news as feed items
    if (scope === 'all' || scope === 'official') {
      const news = await getCachedNews(10);
      for (const n of (news.items || [])) {
        items.push({
          kind: 'news',
          public_id: 'official',
          public_name: n.feedlabel && /counter-strike/i.test(n.feedlabel) ? 'Counter-Strike 2' : 'Counter-Strike 2',
          verified: true,
          title: n.title,
          body: n.contents || '',
          link: n.url,
          image: n.image || null,
          created_at: n.date || null   // already ISO string from fetchSteamNews
        });
      }
      _debug.news_count = (news.items || []).length;
    }

    // User posts from subscribed publics (or all publics if scope=all and not logged in we skip)
    if (scope !== 'official') {
      let publicIds = null;
      if (scope === 'subs') {
        publicIds = me ? db.listSubscriptions(me) : [];
      }
      // scope 'all' / 'hot': from all publics. For 'hot' we'll re-sort by engagement.
      const posts = db.listPosts({ publicIds: scope === 'subs' ? publicIds : null, limit: scope === 'hot' ? 200 : 50 });
      _debug.posts_total = posts.length;
      db.attachPostStats(posts, me);
      // For 'hot' scope: keep posts created in the last 7 days, score by engagement
      let usePosts = posts;
      if (scope === 'hot') {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        usePosts = posts
          .filter(p => (p.created_at || '') > weekAgo)
          .map(p => ({ ...p, _score: (p.likes || 0) * 3 + (p.comments || 0) * 2 + (p.views || 0) * 0.1 }))
          .sort((a, b) => b._score - a._score)
          .slice(0, 30);
      }
      for (const p of usePosts) {
        const pub = db.getPublic(p.public_id);
        items.push({
          kind: 'post',
          post_id: p.id,
          public_id: p.public_id,
          public_name: pub?.name || p.public_id,
          public_avatar: pub?.avatar || null,
          verified: !!pub?.verified,
          title: p.title,
          body: p.body,
          link: p.link,
          image: p.image,
          images: p.images_json ? (() => { try { return JSON.parse(p.images_json); } catch (_) { return null; } })() : null,
          author_steam_id: p.author_steam_id,
          likes: p.likes, views: p.views, comments: p.comments, liked: p.liked,
          poll: p.poll_json ? (() => {
            try {
              const pp = JSON.parse(p.poll_json);
              if (pp && Array.isArray(pp.options)) {
                pp.options = pp.options.map(o => {
                  // Heal poll items that were saved as String({text,votes}) → "[object Object]".
                  // We can't recover the original text, but at least show it as Variant N.
                  if (!o || typeof o !== 'object') return { text: String(o || ''), votes: [] };
                  let t = (typeof o.text === 'string') ? o.text : '';
                  if (t === '[object Object]' || !t) t = '(вариант)';
                  return { text: t, votes: Array.isArray(o.votes) ? o.votes : [] };
                });
              }
              return pp;
            } catch (_) { return null; }
          })() : null,
          edited_at: p.edited_at || null,
          pinned_at: p.pinned_at || null,
          created_at: p.created_at,
          hot_score: scope === 'hot' ? Math.round(p._score) : undefined
        });
      }
    }

    // Sort: for 'hot' keep server order (by score). For others — by date.
    if (scope !== 'hot') items.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    _debug.returned = items.length;
    return sendJson(res, 200, { ok: true, scope, items: items.slice(0, 60), _debug });
  }

  // Recommended publics — those subscribed to by my friends but not by me.
  // Sorted by how many friends are subscribed (descending), then by total subscribers.
  if (pathname === '/api/publics/recommend' && req.method === 'GET') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const mySubs = new Set(db.listSubscriptions(me));
    const friends = db.listFriends(me).map(f => f.steam_id);
    // Tally: { public_id: friend_count }
    const tally = new Map();
    for (const fid of friends) {
      for (const pid of db.listSubscriptions(fid)) {
        if (mySubs.has(pid)) continue; // already subscribed
        tally.set(pid, (tally.get(pid) || 0) + 1);
      }
    }
    // Hydrate publics with their full info + friend count
    const all = db.listPublics();
    const byId = new Map(all.map(p => [p.id, p]));
    const recommendations = Array.from(tally.entries())
      .map(([pid, friendCount]) => {
        const p = byId.get(pid);
        if (!p) return null;
        return {
          id: p.id, name: p.name, description: p.description, avatar: p.avatar,
          verified: !!p.verified, owner: p.owner_steam_id,
          friend_subscribers: friendCount,
          total_subscribers: db.countSubscribers(p.id)
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.friend_subscribers - a.friend_subscribers || b.total_subscribers - a.total_subscribers)
      .slice(0, 12);
    return sendJson(res, 200, { ok: true, recommendations });
  }

  if (pathname === '/api/publics') {
    const me = getRequestSteamId(req);

    // Create a public (logged-in users; max 5 per user)
    if (req.method === 'POST') {
      if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
      if (db.isUserBanned(me)) return sendJson(res, 403, { ok: false, error: 'banned' });
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim().slice(0, 60);
      const description = String(body.description || '').trim().slice(0, 300);
      const avatar = String(body.avatar || '').trim().slice(0, 500) || null;
      const cover = String(body.cover || '').trim().slice(0, 500) || null;
      if (name.length < 3) return sendJson(res, 400, { ok: false, error: 'name-too-short' });
      if (db.countPublicsByOwner(me) >= 5) return sendJson(res, 400, { ok: false, error: 'too-many' });
      const pub = db.createPublic({ owner_steam_id: me, name, description, avatar, cover });
      db.subscribe(me, pub.id); // owner auto-subscribes
      db.logEvent('public-create', me, { id: pub.id, name });
      return sendJson(res, 200, { ok: true, public: pub });
    }

    const subs = me ? db.listSubscriptions(me) : [];
    const publics = db.listPublics().map(p => ({
      id: p.id, name: p.name, description: p.description, avatar: p.avatar,
      verified: !!p.verified, subscribed: subs.includes(p.id),
      owner: p.owner_steam_id, is_owner: me === p.owner_steam_id,
      can_post: me === p.owner_steam_id || (me ? db.isPublicEditor(p.id, me) : false)
    }));
    return sendJson(res, 200, { ok: true, publics, subscriptions: subs });
  }

  // Public stats — only the owner (or editor/moderator) can see analytics
  if (pathname.startsWith('/api/publics/') && pathname.endsWith('/stats')) {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const pid = decodeURIComponent(pathname.slice('/api/publics/'.length).split('/')[0] || '').trim();
    const pub = db.getPublic(pid);
    if (!pub) return sendJson(res, 404, { ok: false, error: 'not-found' });
    const allowed = pub.owner_steam_id === me || db.isPublicEditor(pid, me) || canModerate(me);
    if (!allowed) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    return sendJson(res, 200, { ok: true, stats: db.getPublicStats(pid) });
  }

  if (pathname.startsWith('/api/publics/') && pathname.endsWith('/subscribe')) {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const pid = decodeURIComponent(pathname.slice('/api/publics/'.length).split('/')[0] || '').trim();
    const pub = db.getPublic(pid);
    if (!pub) return sendJson(res, 404, { ok: false, error: 'no-such-public' });
    if (req.method === 'POST') {
      db.subscribe(me, pid);
      // Notify owner (skipped silently if me === owner)
      db.createNotification({ recipient: pub.owner_steam_id, actor: me, kind: 'subscribe',
        data: { public_id: pid, public_name: pub.name } });
      return sendJson(res, 200, { ok: true, subscribed: true });
    }
    if (req.method === 'DELETE') { db.unsubscribe(me, pid); return sendJson(res, 200, { ok: true, subscribed: false }); }
    return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  }

  // Public editors (co-owners) — owner only
  if (/^\/api\/publics\/[^/]+\/editors/.test(pathname)) {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const pid = decodeURIComponent(pathname.slice('/api/publics/'.length).split('/')[0]);
    const pub = db.getPublic(pid);
    if (!pub) return sendJson(res, 404, { ok: false, error: 'no-such-public' });
    if (me !== pub.owner_steam_id) return sendJson(res, 403, { ok: false, error: 'not-owner' });

    // GET list
    if (req.method === 'GET') {
      const eds = db.listPublicEditors(pid);
      const enriched = [];
      for (const e of eds) {
        let p = null; try { p = await fetchProfile(e.steam_id); } catch (_) {}
        enriched.push({ steam_id: e.steam_id, name: p?.personaname || e.steam_id, avatar: p?.avatar || null });
      }
      return sendJson(res, 200, { ok: true, editors: enriched });
    }
    // POST add  /editors/:steamid
    const parts = pathname.slice('/api/publics/'.length).split('/');
    const target = parts[2] ? decodeURIComponent(parts[2]) : '';
    if (req.method === 'POST') {
      if (!/^\d{17}$/.test(target)) return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });
      if (target === pub.owner_steam_id) return sendJson(res, 400, { ok: false, error: 'already-owner' });
      db.addPublicEditor(pid, target, me);
      db.logEvent('public-editor-add', me, { pid, target });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      db.removePublicEditor(pid, target);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  }

  // Public detail + its posts; DELETE removes own public
  if (pathname.startsWith('/api/publics/')) {
    const me = getRequestSteamId(req);
    const pid = decodeURIComponent(pathname.slice('/api/publics/'.length).split('/')[0] || '').trim();
    const pub = db.getPublic(pid);
    if (!pub) return sendJson(res, 404, { ok: false, error: 'no-such-public' });

    if (req.method === 'GET') {
      const subs = me ? db.listSubscriptions(me) : [];
      const posts = db.listPosts({ publicIds: [pid], limit: 50 });
      db.attachPostStats(posts, me);
      // Parse poll + images JSON for each post
      for (const p of posts) {
        if (p.poll_json) { try { p.poll = JSON.parse(p.poll_json); } catch (_) { p.poll = null; } }
        if (p.images_json) { try { p.images = JSON.parse(p.images_json); } catch (_) { p.images = null; } }
        delete p.poll_json; delete p.images_json;
      }
      const isEditor = me === pub.owner_steam_id || db.isPublicEditor(pid, me);
      return sendJson(res, 200, { ok: true,
        public: { id: pub.id, name: pub.name, description: pub.description, avatar: pub.avatar, cover: pub.cover,
          verified: !!pub.verified, owner: pub.owner_steam_id,
          is_owner: me === pub.owner_steam_id, can_post: isEditor, subscribed: subs.includes(pid) },
        posts
      });
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      if (me !== pub.owner_steam_id) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const body = await readJsonBody(req);
      const patch = {};
      if (body.name !== undefined) { const n = String(body.name).trim().slice(0, 60); if (n.length >= 3) patch.name = n; }
      if (body.description !== undefined) patch.description = String(body.description).trim().slice(0, 300) || null;
      if (body.avatar !== undefined) patch.avatar = String(body.avatar).trim().slice(0, 500) || null;
      if (body.cover !== undefined) patch.cover = String(body.cover).trim().slice(0, 500) || null;
      db.updatePublic(pid, patch);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      if (me !== pub.owner_steam_id && !canModerate(me)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      db.deletePublic(pid);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  }

  // Posts: create (owner only) / delete (author or admin)
  if (pathname === '/api/posts' && req.method === 'POST') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    if (db.isUserBanned(me)) return sendJson(res, 403, { ok: false, error: 'banned' });
    const body = await readJsonBody(req);
    const public_id = String(body.public_id || '').trim();
    const pub = db.getPublic(public_id);
    if (!pub) return sendJson(res, 404, { ok: false, error: 'no-such-public' });
    if (pub.owner_steam_id !== me && !db.isPublicEditor(public_id, me)) return sendJson(res, 403, { ok: false, error: 'not-owner' });
    const title = String(body.title || '').trim().slice(0, 200) || null;
    const text = String(body.body || '').trim().slice(0, 5000);
    const link = String(body.link || '').trim().slice(0, 500) || null;
    const image = String(body.image || '').trim().slice(0, 500) || null;
    const images = Array.isArray(body.images) ? body.images.filter(s => typeof s === 'string' && s.trim()).slice(0, 6) : null;
    if (!text && !title) return sendJson(res, 400, { ok: false, error: 'empty' });
    const post = db.createPost({ public_id, author_steam_id: me, title, body: text, link, image, images });
    // Optional poll: { question, options: ["A","B",...] } — 2 to 6 options, each ≤80 chars
    if (body.poll && Array.isArray(body.poll.options) && body.poll.options.length >= 2) {
      const opts = body.poll.options.slice(0, 6).map(o => ({
        text: String(o || '').trim().slice(0, 80),
        votes: []
      })).filter(o => o.text);
      if (opts.length >= 2) {
        const question = String(body.poll.question || '').trim().slice(0, 200);
        db.setPostPoll(post.id, { question, options: opts, created_at: new Date().toISOString() });
      }
    }
    db.logEvent('post-create', me, { public_id, post_id: post.id });
    return sendJson(res, 200, { ok: true, post });
  }

  if (pathname.startsWith('/api/posts/')) {
    const me = getRequestSteamId(req);
    const parts = pathname.slice('/api/posts/'.length).split('/');
    const postId = parts[0];
    const action = parts[1] || '';
    const post = db.getPost(postId);
    if (!post) return sendJson(res, 404, { ok: false, error: 'no-such-post' });

    // Like / unlike
    if (action === 'like') {
      if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
      if (db.isUserBanned(me)) return sendJson(res, 403, { ok: false, error: 'banned' });
      if (req.method === 'POST') {
        db.likePost(postId, me);
        // Notify author (de-dupes itself if liked/unliked quickly)
        db.createNotification({ recipient: post.author_steam_id, actor: me, kind: 'post_like',
          data: { post_id: post.id, public_id: post.public_id, post_title: post.title } });
        return sendJson(res, 200, { ok: true, liked: true, likes: db.countLikes(postId) });
      }
      if (req.method === 'DELETE') { db.unlikePost(postId, me); return sendJson(res, 200, { ok: true, liked: false, likes: db.countLikes(postId) }); }
    }
    // View (idempotent)
    if (action === 'view' && req.method === 'POST') {
      if (me) db.viewPost(postId, me);
      return sendJson(res, 200, { ok: true, views: db.countViews(postId) });
    }
    // Comments: GET list, POST add
    if (action === 'comments') {
      if (req.method === 'GET') {
        const rows = db.listComments(postId, 200);
        const enriched = [];
        for (const c of rows) {
          let p = null; try { p = await fetchProfile(c.author_steam_id); } catch (_) {}
          enriched.push({ id: c.id, author_steam_id: c.author_steam_id, body: c.body, created_at: c.created_at,
            author_name: p?.personaname || c.author_steam_id, author_avatar: p?.avatar || null,
            author_role: db.getUserRole(c.author_steam_id) });
        }
        return sendJson(res, 200, { ok: true, comments: enriched });
      }
      if (req.method === 'POST') {
        if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
        if (db.isUserBanned(me)) return sendJson(res, 403, { ok: false, error: 'banned' });
        const body = await readJsonBody(req);
        const text = String(body.body || '').trim();
        if (!text) return sendJson(res, 400, { ok: false, error: 'empty' });
        if (text.length > 1000) return sendJson(res, 400, { ok: false, error: 'too-long' });
        const c = db.addComment(postId, me, text);
        let p = null; try { p = await fetchProfile(me); } catch (_) {}
        db.logEvent('comment', me, { post_id: post.id });
        db.createNotification({ recipient: post.author_steam_id, actor: me, kind: 'post_comment',
          data: { post_id: post.id, public_id: post.public_id, post_title: post.title, snippet: text.slice(0, 80) } });
        return sendJson(res, 200, { ok: true, comment: {
          id: c.id, author_steam_id: me, body: c.body, created_at: c.created_at,
          author_name: p?.personaname || me, author_avatar: p?.avatar || null,
          author_role: db.getUserRole(me)
        }});
      }
    }
    // Delete comment: /api/posts/:id/comments/:cid
    if (parts[1] === 'comments' && parts[2] && req.method === 'DELETE') {
      if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
      const cid = parts[2];
      const c = db.getComment(cid);
      if (!c || c.post_id !== Number(postId)) return sendJson(res, 404, { ok: false, error: 'no-such-comment' });
      // Author of comment, post author, or moderator can delete
      if (c.author_steam_id !== me && post.author_steam_id !== me && !canModerate(me))
        return sendJson(res, 403, { ok: false, error: 'forbidden' });
      db.deleteComment(cid);
      return sendJson(res, 200, { ok: true });
    }
    // Edit post (PATCH/PUT) — only author or moderator
    if ((req.method === 'PATCH' || req.method === 'PUT') && !action) {
      if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
      if (post.author_steam_id !== me && !canModerate(me)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      const body = await readJsonBody(req);
      const patch = {};
      if (body.title !== undefined) patch.title = body.title;
      if (body.body !== undefined) patch.body = body.body;
      if (body.link !== undefined) patch.link = body.link;
      if (body.image !== undefined) patch.image = body.image;
      if (body.images !== undefined) patch.images = body.images;
      const r = db.updatePost(postId, patch);
      if (r.error) return sendJson(res, 404, { ok: false, error: r.error });
      if (body.poll !== undefined) db.setPostPoll(postId, body.poll);
      db.logEvent('post-edit', me, { postId });
      return sendJson(res, 200, { ok: true, edited_at: r.edited_at });
    }
    // Poll vote: POST /api/posts/:id/vote  { option: N }
    if (action === 'vote' && req.method === 'POST') {
      if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
      const body = await readJsonBody(req);
      const optionIdx = parseInt(body.option, 10);
      if (!Number.isFinite(optionIdx)) return sendJson(res, 400, { ok: false, error: 'bad-option' });
      const r = db.voteOnPoll(postId, me, optionIdx);
      if (r.error) return sendJson(res, 400, { ok: false, error: r.error });
      return sendJson(res, 200, { ok: true, poll: r.poll });
    }
    // Pin / unpin — only public owner/editor or moderators. One pin per public.
    if (action === 'pin' && req.method === 'POST') {
      if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
      const pub = db.getPublic(post.public_id);
      const allowed = pub && (pub.owner_steam_id === me || db.isPublicEditor(post.public_id, me) || canModerate(me));
      if (!allowed) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      db.pinPost(post.public_id, postId);
      db.logEvent('post-pin', me, { postId, publicId: post.public_id });
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'unpin' && req.method === 'POST') {
      if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
      const pub = db.getPublic(post.public_id);
      const allowed = pub && (pub.owner_steam_id === me || db.isPublicEditor(post.public_id, me) || canModerate(me));
      if (!allowed) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      db.unpinPost(postId);
      db.logEvent('post-unpin', me, { postId });
      return sendJson(res, 200, { ok: true });
    }
    // Delete
    if (req.method === 'DELETE' && !action) {
      if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
      if (post.author_steam_id !== me && !canModerate(me)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      db.deletePost(postId);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  }

  // Friend recommendations: friends-of-my-friends
  if (pathname === '/api/friends/recommend' && req.method === 'GET') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const recs = db.recommendFriends(me, 24);
    const enriched = [];
    for (const r of recs) {
      let prof = null; try { prof = await fetchProfile(r.steam_id); } catch (_) {}
      enriched.push({ steam_id: r.steam_id, mutuals: r.mutuals,
        name: prof?.personaname || r.steam_id, avatar: prof?.avatar || null });
    }
    return sendJson(res, 200, { ok: true, recommendations: enriched });
  }

  if (pathname.startsWith('/api/stats/')) {
    const steamid = decodeURIComponent(pathname.slice('/api/stats/'.length).split('/')[0] || '').trim();
    if (!/^\d{17}$/.test(steamid)) return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });
    const s = await fetchCs2Stats(steamid);
    return sendJson(res, 200, { ...s, steamid });
  }

  if (pathname.startsWith('/api/playerbans/')) {
    const steamid = decodeURIComponent(pathname.slice('/api/playerbans/'.length).split('/')[0] || '').trim();
    if (!/^\d{17}$/.test(steamid)) return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });
    const r = await fetchPlayerBans(steamid);
    return sendJson(res, 200, r);
  }

  if (pathname.startsWith('/api/leetify/')) {
    const steamid = decodeURIComponent(pathname.slice('/api/leetify/'.length).split('/')[0] || '').trim();
    if (!/^\d{17}$/.test(steamid)) return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });
    const r = await fetchLeetifyProfile(steamid);
    return sendJson(res, 200, r);
  }

  if (pathname.startsWith('/api/faceit/')) {
    // /api/faceit/{steamid}  — look up by Steam, optionally ?nickname= to override
    const idPart = decodeURIComponent(pathname.slice('/api/faceit/'.length).split('/')[0] || '').trim();
    const nickname = (query.get('nickname') || '').trim();
    const matchCount = Math.min(20, Math.max(1, Number(query.get('matches') || 10)));
    if (!idPart && !nickname) {
      return sendJson(res, 400, { ok: false, error: 'no-identifier' });
    }
    const steamid = /^\d{17}$/.test(idPart) ? idPart : null;
    if (!steamid && !nickname) {
      return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });
    }
    const result = await buildFaceitSummary({ steamid, nickname: nickname || undefined, matchCount });
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/prices') {
    const names = (query.get('names') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
    if (!names.length) return sendJson(res, 400, { ok: false, error: 'no-names' });
    const currency = normalizeCurrency(query.get('currency') || 'RUB');
    const out = {};
    for (const name of names) {
      out[name] = await getPriceWithCache(name, currency.code);
    }
    return sendJson(res, 200, { ok: true, currency: currency.code, prices: out });
  }

  if (pathname === '/api/price-history') {
    const name = query.get('name') || '';
    const currency = normalizeCurrency(query.get('currency') || 'RUB');
    const days = Math.min(90, Math.max(1, Number(query.get('days') || 30)));
    if (!name) return sendJson(res, 400, { ok: false, error: 'no-name' });
    const history = db.getPriceHistory(name, currency.code, 'steam', days);
    return sendJson(res, 200, { ok: true, name, currency: currency.code, days, history });
  }

  if (pathname === '/api/watchlist') {
    const steamid = getRequestSteamId(req);
    if (!steamid) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    if (req.method === 'GET') {
      const items = db.listWatchlist(steamid);
      // enrich with latest price
      const settings = db.getSettings(steamid);
      const currency = normalizeCurrency(settings.currency || 'RUB');
      const enriched = items.map(it => {
        const p = db.getPrice(it.market_name, currency.code, 'steam');
        return { ...it,
          price_value: p?.price_value ?? null,
          price_text: p?.price_text ?? null,
          price_fetched_at: p?.fetched_at ?? null,
          currency: currency.code };
      });
      return sendJson(res, 200, { ok: true, items: enriched });
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const name = String(body.market_name || '').trim();
      if (!name) return sendJson(res, 400, { ok: false, error: 'no-market-name' });
      const row = db.addWatch({
        steam_id: steamid,
        market_name: name,
        threshold_above: body.threshold_above != null ? Number(body.threshold_above) : null,
        threshold_below: body.threshold_below != null ? Number(body.threshold_below) : null
      });
      db.logEvent('watchlist-add', steamid, { market_name: name });
      return sendJson(res, 200, { ok: true, item: row });
    }
    if (req.method === 'DELETE') {
      const body = await readJsonBody(req);
      const name = String(body.market_name || query.get('name') || '').trim();
      if (!name) return sendJson(res, 400, { ok: false, error: 'no-market-name' });
      db.removeWatch(steamid, name);
      db.logEvent('watchlist-remove', steamid, { market_name: name });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  }

  if (pathname.startsWith('/api/reputation/')) {
    const target = decodeURIComponent(pathname.slice('/api/reputation/'.length).split('/')[0] || '').trim();
    if (!/^\d{17}$/.test(target)) return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });
    const voter = getRequestSteamId(req);

    if (req.method === 'GET') {
      const agg = db.aggregateReputation(target);
      const myVote = voter ? db.getReputationVote(voter, target) : null;
      return sendJson(res, 200, {
        ok: true, target,
        ...agg,
        my_vote: myVote ? { categories: myVote.categories, comment: myVote.comment, sentiment: myVote.sentiment } : null,
        can_vote: !!voter && voter !== target
      });
    }

    if (req.method === 'POST') {
      if (!voter) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
      if (db.isUserBanned(voter)) return sendJson(res, 403, { ok: false, error: 'banned' });
      if (voter === target) return sendJson(res, 400, { ok: false, error: 'self-vote' });
      const body = await readJsonBody(req);
      const categories = Array.isArray(body.categories)
        ? body.categories.filter(c => c in db.REP_CATEGORIES)
        : (body.category && body.category in db.REP_CATEGORIES ? [body.category] : []);
      const comment = body.comment != null ? String(body.comment) : null;
      if (categories.length === 0 && !(comment && comment.trim())) {
        return sendJson(res, 400, { ok: false, error: 'empty-vote' });
      }

      // Rate limit: max 30 votes per hour per voter
      const recent = db.countRecentVotes(voter, 60 * 60 * 1000);
      if (recent >= 30) return sendJson(res, 429, { ok: false, error: 'rate-limited' });

      // Anti-bot weighting: account younger than 30 days has weight 0 (counted but not shown)
      let weight = 1;
      try {
        const prof = await fetchProfile(voter);
        const tc = Number(prof?.timecreated || 0);
        if (tc > 0) {
          const ageDays = (Date.now() - tc * 1000) / (1000 * 60 * 60 * 24);
          if (ageDays < 30) weight = 0;
        }
      } catch (_) { /* if we can't tell, default weight 1 */ }

      const r = db.castReputation({ voterSteamId: voter, targetSteamId: target, categories, comment, weight });
      if (r.error) return sendJson(res, 400, { ok: false, error: r.error });
      db.logEvent('reputation-vote', voter, { target, categories, has_comment: !!r.comment, weight });
      const agg = db.aggregateReputation(target);
      return sendJson(res, 200, { ok: true, ...agg,
        my_vote: { categories: r.categories, comment: r.comment, sentiment: r.sentiment },
        weight_applied: weight });
    }

    if (req.method === 'DELETE') {
      if (!voter) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
      db.removeReputation(voter, target);
      db.logEvent('reputation-remove', voter, { target });
      const agg = db.aggregateReputation(target);
      return sendJson(res, 200, { ok: true, ...agg, my_vote: null });
    }

    return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  }

  // ---------- friends ----------
  async function enrichSteamList(arr) {
    const out = [];
    for (const e of arr) {
      let prof = null;
      try { prof = await fetchProfile(e.steam_id); } catch (_) {}
      out.push({ ...e,
        name: prof?.personaname || e.steam_id,
        avatar: prof?.avatar || prof?.avatarfull || null });
    }
    return out;
  }

  if (pathname === '/api/friends') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const lists = db.listFriends(me);
    const [friends, incoming, outgoing] = await Promise.all([
      enrichSteamList(lists.friends),
      enrichSteamList(lists.incoming),
      enrichSteamList(lists.outgoing)
    ]);
    return sendJson(res, 200, { ok: true, friends, incoming, outgoing });
  }

  // Public: list of confirmed friends-on-site for any steamid (used on profile pages)
  if (/^\/api\/friends\/\d{17}\/list$/.test(pathname) && req.method === 'GET') {
    const target = pathname.slice('/api/friends/'.length, -'/list'.length);
    const lists = db.listFriends(target);
    const friends = await enrichSteamList(lists.friends);
    return sendJson(res, 200, { ok: true, friends, count: friends.length });
  }

  if (pathname.startsWith('/api/friends/')) {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const parts = pathname.slice('/api/friends/'.length).split('/');
    const other = decodeURIComponent(parts[0] || '').trim();
    const action = parts[1] || '';
    if (!/^\d{17}$/.test(other)) return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });

    if (req.method === 'POST' && action === 'request') {
      const r = db.sendFriendRequest(me, other);
      if (r.error) return sendJson(res, 400, { ok: false, error: r.error });
      db.logEvent('friend-request', me, { other });
      db.createNotification({ recipient: other, actor: me, kind: 'friend_request', data: {} });
      return sendJson(res, 200, { ok: true, status: db.friendStatus(me, other) });
    }
    if (req.method === 'POST' && action === 'accept') {
      const r = db.acceptFriendRequest(me, other);
      if (r.error) return sendJson(res, 400, { ok: false, error: r.error });
      db.logEvent('friend-accept', me, { other });
      db.createNotification({ recipient: other, actor: me, kind: 'friend_accept', data: {} });
      return sendJson(res, 200, { ok: true, status: 'friends' });
    }
    if (req.method === 'DELETE') {
      db.removeFriend(me, other);
      return sendJson(res, 200, { ok: true, status: db.friendStatus(me, other) });
    }
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, status: db.friendStatus(me, other) });
    }
    return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  }

  // ---------- blocks ----------
  if (pathname === '/api/blocks') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const ids = db.listBlocks(me).map(id => ({ steam_id: id }));
    const blocked = await enrichSteamList(ids);
    return sendJson(res, 200, { ok: true, blocked });
  }

  if (pathname.startsWith('/api/blocks/')) {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const other = decodeURIComponent(pathname.slice('/api/blocks/'.length).split('/')[0] || '').trim();
    if (!/^\d{17}$/.test(other)) return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });
    if (req.method === 'POST') {
      const r = db.blockUser(me, other);
      if (r.error) return sendJson(res, 400, { ok: false, error: r.error });
      db.logEvent('block', me, { other });
      return sendJson(res, 200, { ok: true, blocked: true });
    }
    if (req.method === 'DELETE') {
      db.unblockUser(me, other);
      return sendJson(res, 200, { ok: true, blocked: false });
    }
    return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  }

  // ---------- messages ----------
  if (pathname === '/api/conversations') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const convos = db.listConversations(me);
    const enriched = [];
    for (const c of convos) {
      let prof = null;
      try { prof = await fetchProfile(c.steam_id); } catch (_) {}
      let preview = '';
      if (c.last) {
        if (c.last.deleted_at) {
          preview = '🗑 сообщение удалено';
        } else {
          const text = decryptMessage(c.last.body_enc);
          if (text) preview = text.slice(0, 80);
          else if (c.last.attachment_enc) {
            try {
              const att = JSON.parse(decryptMessage(c.last.attachment_enc));
              if (att.type === 'post') preview = '📎 Пост';
              else if (att.type === 'forward') preview = '↪ Пересланное сообщение';
              else if (att.type === 'reply') preview = '↩ Ответ';
              else preview = '📎 Вложение';
            } catch (_) { preview = '📎 Вложение'; }
          }
        }
      }
      enriched.push({
        steam_id: c.steam_id,
        name: prof?.personaname || c.steam_id,
        avatar: prof?.avatar || prof?.avatarfull || null,
        unread: c.unread,
        last_text: preview,
        last_at: c.last?.created_at || null,
        last_from_me: c.last ? c.last.sender_steam_id === me : false
      });
    }
    return sendJson(res, 200, { ok: true, conversations: enriched, unread_total: db.countUnread(me) });
  }

  // Soft-delete a single message: DELETE /api/messages/msg/:msgId
  // Only the sender (or moderators) can delete. Row is kept; text is hidden.
  if (pathname.startsWith('/api/messages/msg/') && req.method === 'DELETE') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const msgId = parseInt(pathname.slice('/api/messages/msg/'.length), 10);
    if (!Number.isFinite(msgId)) return sendJson(res, 400, { ok: false, error: 'bad-id' });
    const m = db.getMessage(msgId);
    if (!m) return sendJson(res, 404, { ok: false, error: 'no-such-message' });
    if (m.sender_steam_id !== me && !canModerate(me)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    db.softDeleteMessage(msgId);
    return sendJson(res, 200, { ok: true });
  }

  // Message reactions: POST /api/messages/reactions/:msgId  { emoji }
  if (pathname.startsWith('/api/messages/reactions/') && req.method === 'POST') {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const msgId = parseInt(pathname.slice('/api/messages/reactions/'.length), 10);
    if (!Number.isFinite(msgId)) return sendJson(res, 400, { ok: false, error: 'bad-id' });
    const m = db.getMessage(msgId);
    if (!m) return sendJson(res, 404, { ok: false, error: 'no-such-message' });
    // Only participants can react
    if (m.sender_steam_id !== me && m.recipient_steam_id !== me)
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    const body = await readJsonBody(req);
    // Whitelist: small set of emojis only, avoid arbitrary text
    const allowed = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
    const emoji = String(body.emoji || '');
    if (!allowed.includes(emoji)) return sendJson(res, 400, { ok: false, error: 'bad-emoji' });
    const r = db.toggleMessageReaction(msgId, me, emoji);
    return sendJson(res, 200, { ok: true, reactions: r.reactions });
  }

  if (pathname.startsWith('/api/messages/')) {
    const me = getRequestSteamId(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    const other = decodeURIComponent(pathname.slice('/api/messages/'.length).split('/')[0] || '').trim();
    if (!/^\d{17}$/.test(other)) return sendJson(res, 400, { ok: false, error: 'invalid-steamid' });

    if (req.method === 'GET') {
      const rows = db.listMessages(me, other, 200);
      const messages = [];
      for (const m of rows) {
        const isDeleted = !!m.deleted_at;
        let attachment = null;
        if (!isDeleted && m.attachment_enc) {
          try { attachment = JSON.parse(decryptMessage(m.attachment_enc)); } catch (_) {}
          if (attachment) attachment = await hydrateAttachment(attachment);
        }
        messages.push({
          id: m.id, from_me: m.sender_steam_id === me,
          text: isDeleted ? '' : decryptMessage(m.body_enc),
          attachment,
          reactions: !isDeleted && m.reactions_json ? (() => { try { return JSON.parse(m.reactions_json); } catch (_) { return {}; } })() : {},
          deleted: isDeleted,
          created_at: m.created_at,
          read: !!m.read_at
        });
      }
      db.markRead(me, other);
      // Tell the other party their messages were seen — UI can flip the "✓" to "✓✓".
      wsHub.sendTo(other, { type: 'message:read', by: me, ts: Date.now() });
      let prof = null;
      try { prof = await fetchProfile(other); } catch (_) {}
      return sendJson(res, 200, { ok: true, other: {
        steam_id: other, name: prof?.personaname || other,
        avatar: prof?.avatar || prof?.avatarfull || null
      }, messages, friend: db.areFriends(me, other) });
    }

    if (req.method === 'POST') {
      if (db.isUserBanned(me)) return sendJson(res, 403, { ok: false, error: 'banned' });
      if (db.eitherBlocked(me, other)) return sendJson(res, 403, { ok: false, error: 'blocked' });
      // Friends-only rule applies to regular users. Moderators and the
      // superadmin can DM anyone — they're handling support, abuse reports,
      // and ban appeals where there's no pre-existing friendship.
      if (!canModerate(me) && !db.areFriends(me, other)) {
        return sendJson(res, 403, { ok: false, error: 'not-friends' });
      }
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      const attachment = body.attachment && typeof body.attachment === 'object' ? sanitizeAttachment(body.attachment) : null;
      if (!text && !attachment) return sendJson(res, 400, { ok: false, error: 'empty' });
      if (text.length > 2000) return sendJson(res, 400, { ok: false, error: 'too-long' });
      const enc = encryptMessage(text);
      const attEnc = attachment ? encryptMessage(JSON.stringify(attachment)) : null;
      const saved = db.insertMessage(me, other, enc, attEnc);
      db.logEvent('message-send', me, { to: other, attachment_type: attachment?.type });
      const hydratedAtt = attachment ? await hydrateAttachment(attachment) : null;

      // Realtime push. Recipient sees the message instantly; sender's other
      // tabs/devices also get it so they stay in sync.
      let senderProfile = null;
      try { senderProfile = await fetchProfile(me); } catch (_) {}
      const senderName = senderProfile?.personaname || me;
      const senderAvatar = senderProfile?.avatar || senderProfile?.avatarfull || null;

      wsHub.sendTo(other, { type: 'message:new', message: {
        id: saved.id, from_me: false, peer: me, peer_name: senderName, peer_avatar: senderAvatar,
        text, attachment: hydratedAtt, created_at: saved.created_at, read: false
      }});
      wsHub.sendTo(me, { type: 'message:sent', message: {
        id: saved.id, from_me: true, peer: other,
        text, attachment: hydratedAtt, created_at: saved.created_at, read: false
      }});

      // Web Push to OS tray. Always sent — the service worker is smart enough
      // to suppress the OS notification if the user has the chat already open
      // and focused (see sw.js). Sending unconditionally is the only way to
      // cover "tab open in background", "browser minimized", "phone locked",
      // which all still report a live WebSocket connection.
      const preview = text ? text.slice(0, 140) : (attachment ? '[вложение]' : '');
      pushToUser(other, {
        title: senderName,
        body: preview,
        url: `/messages?to=${me}`,
        kind: 'message',
        peer: me,
        avatar: senderAvatar
      }).catch(() => {});

      return sendJson(res, 200, { ok: true, message: {
        id: saved.id, from_me: true, text, attachment: hydratedAtt, created_at: saved.created_at, read: false
      } });
    }
    return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  }

  if (pathname === '/api/settings') {
    const steamid = getRequestSteamId(req);
    if (!steamid) return sendJson(res, 401, { ok: false, error: 'not-authenticated' });
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, settings: db.getSettings(steamid) });
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const allowed = {};
      if (body.currency && CURRENCIES[String(body.currency).toUpperCase()]) {
        allowed.currency = String(body.currency).toUpperCase();
      }
      if (body.language && ['ru', 'en'].includes(String(body.language))) {
        allowed.language = String(body.language);
      }
      if (body.telegram_id !== undefined) {
        allowed.telegram_id = body.telegram_id ? String(body.telegram_id).slice(0, 32) : null;
      }
      if (body.faceit_nickname !== undefined) {
        // Faceit nicknames are 3–25 chars, allow letters/digits/underscore/dash
        const raw = body.faceit_nickname ? String(body.faceit_nickname).trim().slice(0, 32) : '';
        allowed.faceit_nickname = raw && /^[A-Za-z0-9_.\-]+$/.test(raw) ? raw : null;
      }
      if (body.show_activity !== undefined) {
        allowed.show_activity = body.show_activity ? 1 : 0;
      }
      if (body.cover_url !== undefined) {
        // Allow URLs from our uploads dir or full HTTPS URLs, max 500 chars
        const raw = body.cover_url ? String(body.cover_url).trim().slice(0, 500) : '';
        allowed.cover_url = raw || null;
      }
      const next = db.setSettings(steamid, allowed);
      db.logEvent('settings-update', steamid, allowed);
      return sendJson(res, 200, { ok: true, settings: next });
    }
    return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  }

  return sendJson(res, 404, { ok: false, error: 'not-found', path: pathname });
}

// ---------- static ----------
function safeJoin(base, target) {
  const r = path.resolve(base, '.' + target);
  if (!r.startsWith(base)) return null;
  return r;
}

function serveStatic(req, res, pathname) {
  // Uploaded user files live in the data dir (persistent), served read-only.
  if (pathname.startsWith('/uploads/')) {
    const rel = pathname.slice('/uploads/'.length);
    // only allow a flat safe filename
    if (!/^[a-z0-9._-]+$/i.test(rel)) { sendText(res, 403, 'Forbidden'); return; }
    const file = path.join(UPLOADS_DIR, rel);
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) { sendText(res, 404, 'Not found'); return; }
      const ext = path.extname(file).toLowerCase();
      const ctype = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(file).pipe(res);
    });
    return;
  }

  // OG meta-tag injection for richer link previews in Telegram/Discord/VK.
  // Replaces a <!--OG--> placeholder in the HTML with generated tags based on URL params.
  // No Accept-header filter — crawlers send various Accept values and we want to serve them OG too.
  // /og-debug — diagnostic endpoint to help debug OG injection on production.
  // Shows the base URL we resolved, the headers we got, and a sample OG block.
  if (pathname === '/og-debug') {
    const base = getBaseUrl(req);
    const sample = renderOgTags({
      title: 'Тестовый заголовок',
      desc: 'Тестовое описание',
      image: `${base}/assets/logo-full-dark.png`,
      url: `${base}/og-debug`
    });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end([
      `Base URL resolved: ${base}`,
      `BASE_URL env var: ${process.env.BASE_URL || '(not set)'}`,
      `Host header: ${req.headers.host || '(none)'}`,
      `X-Forwarded-Host: ${req.headers['x-forwarded-host'] || '(none)'}`,
      `X-Forwarded-Proto: ${req.headers['x-forwarded-proto'] || '(none)'}`,
      `User-Agent: ${req.headers['user-agent'] || '(none)'}`,
      '',
      'Sample OG block that would be injected:',
      sample,
      '',
      'Test commands:',
      `curl -s '${base}/u/76561198197947702' | grep -E 'og:|twitter:'`,
      `curl -s -I '${base}/u/76561198197947702'`,
    ].join('\n'));
    return;
  }

  if (pathname === '/lookup' || pathname === '/feed') {
    const file = path.join(PUBLIC_DIR, pathname === '/lookup' ? 'lookup.html' : 'feed.html');
    const query = new URL(req.url, 'http://x').searchParams;
    fs.readFile(file, 'utf8', async (err, html) => {
      if (err) return sendText(res, 404, 'Not found');
      try {
        const base = getBaseUrl(req);
        const defaultImage = `${base}/assets/logo-full-dark.png`;
        let og = '';
        if (pathname === '/lookup' && /^\d{17}$/.test(query.get('steamid') || '')) {
          const sid = query.get('steamid');
          const p = await fetchProfile(sid).catch(() => null);
          const name = escapeHtml(p?.personaname || 'Игрок');
          const avatar = p?.avatarfull || p?.avatar || defaultImage;
          const title = `${name} — профиль CS2 на SOKOLENOK`;
          const desc = `Проверьте статистику, репутацию и инвентарь игрока ${p?.personaname || ''} на SOKOLENOK.`.trim();
          og = renderOgTags({ title, desc, image: avatar, url: `${base}/lookup?steamid=${sid}` });
        } else if (pathname === '/feed' && query.get('public')) {
          const pid = query.get('public');
          const pub = db.getPublic(pid);
          if (pub) {
            const name = escapeHtml(pub.name || 'Сообщество');
            const desc = escapeHtml((pub.description || 'Сообщество CS2 на SOKOLENOK').slice(0, 160));
            og = renderOgTags({ title: `${name} — SOKOLENOK`, desc, image: pub.avatar || defaultImage,
              url: `${base}/feed?public=${encodeURIComponent(pid)}` });
          }
        } else {
          // Default OG tags for plain /lookup and /feed
          og = renderOgTags({
            title: pathname === '/lookup' ? 'Найти игрока — SOKOLENOK' : 'Лента CS2 — SOKOLENOK',
            desc: 'SOKOLENOK — экосистема для игроков CS2: статистика, репутация, инвентарь и сообщество.',
            image: defaultImage,
            url: `${base}${pathname}`
          });
        }
        const out = html.replace('<!--OG-->', og);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(out);
      } catch (_) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      }
    });
    return;
  }

  // Short profile URL: /u/<steamid> — serves lookup HTML with OG tags directly
  // (no redirect, because crawlers like Telegram don't follow 302 for previews).
  // The page then rewrites its URL via history.replaceState so the frontend sees ?steamid=
  if (pathname.startsWith('/u/')) {
    const sid = pathname.slice(3).split('/')[0];
    if (!/^\d{17}$/.test(sid)) { sendText(res, 404, 'Not found'); return; }
    const file = path.join(PUBLIC_DIR, 'lookup.html');
    fs.readFile(file, 'utf8', async (err, html) => {
      if (err) return sendText(res, 404, 'Not found');
      try {
        const base = getBaseUrl(req);
        const defaultImage = `${base}/assets/logo-full-dark.png`;
        const p = await fetchProfile(sid).catch(() => null);
        const name = escapeHtml(p?.personaname || 'Игрок');
        const avatar = p?.avatarfull || p?.avatar || defaultImage;
        const title = `${name} — профиль CS2 на SOKOLENOK`;
        const desc = `Проверьте статистику, репутацию и инвентарь игрока ${p?.personaname || ''} на SOKOLENOK.`.trim();
        const og = renderOgTags({ title, desc, image: avatar, url: `${base}/u/${sid}` });
        // Inject a tiny script that rewrites the URL to the canonical ?steamid= form,
        // so existing frontend logic (which reads URLSearchParams) keeps working.
        const rewrite = `<script>try{history.replaceState({},'','/lookup?steamid=${sid}');}catch(_){}</script>`;
        const out = html.replace('<!--OG-->', og + rewrite);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(out);
      } catch (_) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      }
    });
    return;
  }

  // Pretty routes
  const routeMap = {
    '/': 'index.html',
    '/dashboard': 'dashboard.html',
    '/inventory': 'inventory.html',
    '/lookup': 'lookup.html',
    '/settings': 'settings.html',
    '/feed': 'feed.html',
    '/messages': 'messages.html',
    '/privacy': 'privacy.html',
    '/terms': 'terms.html',
    '/rules': 'rules.html',
    '/admin': 'admin.html',
    '/me': 'me.html',
    '/friends': 'friends.html',
    '/communities': 'communities.html',
    '/notifications': 'notifications.html'
  };
  const rel = routeMap[pathname] ? `/${routeMap[pathname]}` : pathname;
  const file = safeJoin(PUBLIC_DIR, rel);
  if (!file) { sendText(res, 403, 'Forbidden'); return; }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback to index.html for unknown HTML routes
      if (req.headers.accept && req.headers.accept.includes('text/html')) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e, d) => {
          if (e) return sendText(res, 404, 'Not found');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(d);
        });
      }
      return sendText(res, 404, 'Not found');
    }
    const ext = path.extname(file).toLowerCase();
    const ctype = MIME[ext] || 'application/octet-stream';
    const cache = (ext === '.html') ? 'no-store' : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': cache });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- main ----------
const server = http.createServer(async (req, res) => {
  let parsedUrl;
  try { parsedUrl = new URL(req.url, getBaseUrl(req)); }
  catch (_) { return sendText(res, 400, 'Bad request'); }

  const pathname = parsedUrl.pathname;

  // CORS for /api (basic)
  if (pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }

  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, parsedUrl.searchParams);
    if (pathname.startsWith('/auth/')) {
      const handled = await handleSteamOpenId(req, res, parsedUrl);
      if (handled !== false) return;
      return sendText(res, 404, 'Not found');
    }
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal', message: String(e?.message || e) });
  }
});

// ---------- WebSocket setup ----------
// One WS endpoint, /ws. Authentication is by the same session cookie used
// elsewhere — no extra token needed. Steam IDs in the URL are ignored;
// the only source of truth is the cookie.
if (WebSocketServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (_) {}
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const steamId = getRequestSteamId(req);
    if (!steamId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wsHub.attachPongHandler(ws);
      wsHub.register(ws, steamId);
      try { ws.send(JSON.stringify({ type: 'hello', steamid: steamId, ts: Date.now() })); } catch (_) {}

      // Inbound messages are small control frames (ping, typing). All real
      // mutations still go through the HTTP API — WS is one-way push for now,
      // so we don't dispatch arbitrary client→server commands here.
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(String(raw)); } catch (_) { return; }
        if (!m || typeof m !== 'object') return;

        if (m.type === 'ping') {
          try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch (_) {}
          return;
        }
        if (m.type === 'typing' && m.to) {
          // Forward typing notification to recipient(s). Validate `to` is a steamId-shape string.
          const to = String(m.to);
          if (/^\d{17}$/.test(to)) {
            wsHub.sendTo(to, { type: 'typing', from: steamId, ts: Date.now() });
          }
        }
      });
    });
  });

  wsHub.startHeartbeat();
}

server.listen(PORT, () => {
  console.log(`SOKOLENOK ${APP_VERSION} → http://localhost:${PORT}`);
  console.log(`Storage backend: ${db.storageHealth().backend}`);
  console.log(`Steam API key:   ${STEAM_API_KEY ? 'configured' : 'NOT SET (XML fallback only, public endpoints will still work)'}`);
  console.log(`Faceit API key:  ${FACEIT_API_KEY ? 'configured' : 'NOT SET (Faceit endpoints will return ok:false)'}`);
  console.log(`WebSocket:       ${WebSocketServer ? 'enabled at /ws' : 'DISABLED (ws module not installed) — clients will use polling'}`);
});
