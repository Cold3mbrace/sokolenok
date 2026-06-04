// storage/db.js
// Простой слой хранения. Использует node:sqlite (встроенный в Node 22+),
// если по какой-то причине sqlite недоступен — падает на JSON-файл.
// Намеренно никаких внешних npm-зависимостей.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.SOKOLENOK_DATA_DIR
  ? path.resolve(process.env.SOKOLENOK_DATA_DIR)
  : path.join(ROOT, '.data');
const SQLITE_FILE = path.join(DATA_DIR, 'sokolenok.sqlite');
const JSON_FILE = path.join(DATA_DIR, 'sokolenok.json');

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function nowIso() { return new Date().toISOString(); }
function uuid() { return crypto.randomUUID(); }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  steam_id TEXT PRIMARY KEY,
  persona_name TEXT,
  avatar TEXT,
  steam_url TEXT,
  visibility TEXT,
  profile_json TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  steam_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- auth_methods: maps external auth identities (Steam, Telegram, …) to our
-- internal user id (stored in users.steam_id). A single user can have many
-- methods bound — e.g. Steam + Telegram for redundancy / mom-without-Steam.
-- The "provider" + "external_id" pair is unique: same Telegram can't bind
-- to two different users.
CREATE TABLE IF NOT EXISTS auth_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  steam_id TEXT NOT NULL,            -- internal user id (FK to users.steam_id)
  provider TEXT NOT NULL,            -- 'steam' | 'telegram'
  external_id TEXT NOT NULL,         -- e.g. Steam ID, Telegram user id
  external_username TEXT,            -- Telegram @username if any
  external_name TEXT,                -- Display name from provider
  external_avatar TEXT,              -- Avatar URL from provider
  verified INTEGER NOT NULL DEFAULT 1, -- 1 if provider verified identity (OpenID, HMAC)
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_provider_extid ON auth_methods(provider, external_id);
CREATE INDEX IF NOT EXISTS idx_auth_user ON auth_methods(steam_id);

CREATE TABLE IF NOT EXISTS inventory_snapshots (
  id TEXT PRIMARY KEY,
  steam_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  total_items INTEGER NOT NULL DEFAULT 0,
  total_value REAL,
  total_value_text TEXT,
  status TEXT,
  items_json TEXT,
  pricing_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inv_snap_steam_created
  ON inventory_snapshots(steam_id, created_at DESC);

CREATE TABLE IF NOT EXISTS prices (
  market_name TEXT NOT NULL,
  currency TEXT NOT NULL,
  source TEXT NOT NULL,
  price_value REAL,
  price_text TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (market_name, currency, source)
);
CREATE INDEX IF NOT EXISTS idx_prices_fetched ON prices(fetched_at);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_name TEXT NOT NULL,
  currency TEXT NOT NULL,
  source TEXT NOT NULL,
  price_value REAL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_price_hist_name
  ON price_history(market_name, currency, recorded_at DESC);

CREATE TABLE IF NOT EXISTS watchlist (
  id TEXT PRIMARY KEY,
  steam_id TEXT NOT NULL,
  market_name TEXT NOT NULL,
  threshold_above REAL,
  threshold_below REAL,
  created_at TEXT NOT NULL,
  UNIQUE (steam_id, market_name)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_steam ON watchlist(steam_id);

CREATE TABLE IF NOT EXISTS user_settings (
  steam_id TEXT PRIMARY KEY,
  currency TEXT NOT NULL DEFAULT 'RUB',
  language TEXT NOT NULL DEFAULT 'ru',
  telegram_id TEXT,
  faceit_nickname TEXT,
  consent_at TEXT,
  show_activity INTEGER NOT NULL DEFAULT 1,
  onboarding_done INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_cache (
  steam_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (steam_id, currency)
);

-- Social reputation: one row per (voter -> target) pair, perpetual upsert.
-- categories_json holds the selected category keys; comment is optional free text.
-- sentiment/category kept for backward compat (net sign + primary category).
CREATE TABLE IF NOT EXISTS reputation (
  voter_steam_id  TEXT NOT NULL,
  target_steam_id TEXT NOT NULL,
  sentiment       INTEGER NOT NULL DEFAULT 0,
  category        TEXT,
  categories_json TEXT NOT NULL DEFAULT '[]',
  comment         TEXT,
  weight          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (voter_steam_id, target_steam_id)
);
CREATE INDEX IF NOT EXISTS idx_rep_target ON reputation(target_steam_id);
CREATE INDEX IF NOT EXISTS idx_rep_voter_time ON reputation(voter_steam_id, updated_at DESC);

-- Feed foundation: publics (channels), posts, and subscriptions.
-- Official news is injected virtually under a reserved public_id = 'official'.
CREATE TABLE IF NOT EXISTS publics (
  id          TEXT PRIMARY KEY,        -- slug-like id
  owner_steam_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  avatar      TEXT,
  cover       TEXT,
  verified    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id   TEXT NOT NULL,
  author_steam_id TEXT NOT NULL,
  title       TEXT,
  body        TEXT NOT NULL,
  link        TEXT,
  image       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_public_time ON posts(public_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_time ON posts(created_at DESC);
CREATE TABLE IF NOT EXISTS subscriptions (
  steam_id    TEXT NOT NULL,
  public_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (steam_id, public_id)
);
CREATE INDEX IF NOT EXISTS idx_subs_steam ON subscriptions(steam_id);

-- Friendships: a request row with status. (a,b) stored with a = requester.
-- status: 'pending' | 'accepted'. Unfriend / decline = row deleted.
CREATE TABLE IF NOT EXISTS friendships (
  requester_steam_id TEXT NOT NULL,
  addressee_steam_id TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (requester_steam_id, addressee_steam_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_addressee ON friendships(addressee_steam_id, status);
CREATE INDEX IF NOT EXISTS idx_friend_requester ON friendships(requester_steam_id, status);

-- Block list: blocker -> blocked. Blocks override everything.
CREATE TABLE IF NOT EXISTS blocks (
  blocker_steam_id TEXT NOT NULL,
  blocked_steam_id TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (blocker_steam_id, blocked_steam_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_steam_id);

-- Direct messages between friends. body is encrypted at rest (see crypto in server.js).
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_steam_id   TEXT NOT NULL,
  recipient_steam_id TEXT NOT NULL,
  body_enc    TEXT NOT NULL,
  attachment_enc TEXT,
  created_at  TEXT NOT NULL,
  read_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender_steam_id, recipient_steam_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_recipient ON messages(recipient_steam_id, read_at);

-- User reports (complaints) sent to moderators.
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_steam_id TEXT NOT NULL,
  target_type TEXT NOT NULL,    -- 'user' | 'post' | 'public' | 'reputation' | 'message'
  target_id   TEXT NOT NULL,    -- steamid or row id
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'resolved' | 'dismissed'
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);

-- Site-level bans (separate from per-user blocks). Banned users can't post / message / vote.
CREATE TABLE IF NOT EXISTS user_bans (
  steam_id    TEXT PRIMARY KEY,
  reason      TEXT,
  banned_by   TEXT,
  created_at  TEXT NOT NULL
);

-- Site moderators (granted via the panel by the env superadmin).
-- They get moderation powers but cannot grant/revoke other moderators.
CREATE TABLE IF NOT EXISTS moderators (
  steam_id    TEXT PRIMARY KEY,
  granted_by  TEXT,
  created_at  TEXT NOT NULL
);

-- Public co-owners / editors: can post into a public they don't own.
CREATE TABLE IF NOT EXISTS public_editors (
  public_id   TEXT NOT NULL,
  steam_id    TEXT NOT NULL,
  added_by    TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (public_id, steam_id)
);
CREATE INDEX IF NOT EXISTS idx_pubed_steam ON public_editors(steam_id);

-- Custom team roles ("Команда SOKOLENOK"): admin-defined labels with colors
CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT 'green',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

-- Assignments of users to roles
CREATE TABLE IF NOT EXISTS role_members (
  role_id     INTEGER NOT NULL,
  steam_id    TEXT NOT NULL,
  added_by    TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (role_id, steam_id)
);
CREATE INDEX IF NOT EXISTS idx_rolemb_steam ON role_members(steam_id);

-- Likes on posts (unique per user per post)
CREATE TABLE IF NOT EXISTS post_likes (
  post_id    INTEGER NOT NULL,
  steam_id   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, steam_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_post ON post_likes(post_id);

-- Unique views (one per user per post)
CREATE TABLE IF NOT EXISTS post_views (
  post_id    INTEGER NOT NULL,
  steam_id   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, steam_id)
);
CREATE INDEX IF NOT EXISTS idx_views_post ON post_views(post_id);

-- Comments on posts
CREATE TABLE IF NOT EXISTS post_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  author_steam_id TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_steam_id TEXT NOT NULL,
  actor_steam_id     TEXT,
  kind        TEXT NOT NULL,
  data_json   TEXT,
  created_at  TEXT NOT NULL,
  read_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications(recipient_steam_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(recipient_steam_id, read_at);

-- Web Push subscriptions. One user can have many devices/browsers, each
-- generates its own endpoint. We dedupe by endpoint (PRIMARY KEY) — same
-- browser re-subscribing just refreshes its keys/timestamp.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  steam_id    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(steam_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  steam_id TEXT,
  data_json TEXT
);
`;

// ----------------------- sqlite path -----------------------
let sqliteMod = null;
let db = null;
try { sqliteMod = require('node:sqlite'); } catch (_) { sqliteMod = null; }

function openSqlite() {
  if (!sqliteMod) return null;
  if (db) return db;
  ensureDir();
  const { DatabaseSync } = sqliteMod;
  db = new DatabaseSync(SQLITE_FILE);
  db.exec(SCHEMA);
  // Migrations for older DBs missing newer columns
  try {
    const cols = db.prepare("PRAGMA table_info(user_settings)").all();
    const colNames = new Set(cols.map(c => c.name));
    if (!colNames.has('faceit_nickname')) {
      db.exec('ALTER TABLE user_settings ADD COLUMN faceit_nickname TEXT');
    }
    if (!colNames.has('consent_at')) {
      db.exec('ALTER TABLE user_settings ADD COLUMN consent_at TEXT');
    }
    if (!colNames.has('show_activity')) {
      // SQLite ALTER doesn't allow NOT NULL DEFAULT in some versions of node:sqlite;
      // add as nullable and treat NULL as 1 in reads.
      db.exec('ALTER TABLE user_settings ADD COLUMN show_activity INTEGER DEFAULT 1');
    }
    if (!colNames.has('cover_url')) {
      db.exec('ALTER TABLE user_settings ADD COLUMN cover_url TEXT');
    }
    if (!colNames.has('onboarding_done')) {
      db.exec('ALTER TABLE user_settings ADD COLUMN onboarding_done INTEGER DEFAULT 0');
    }
  } catch (_) { /* best-effort */ }
  try {
    const cols = db.prepare("PRAGMA table_info(reputation)").all();
    const colNames = new Set(cols.map(c => c.name));
    if (!colNames.has('categories_json')) {
      db.exec("ALTER TABLE reputation ADD COLUMN categories_json TEXT DEFAULT '[]'");
      try { db.exec("UPDATE reputation SET categories_json = '[\"' || category || '\"]' WHERE category IS NOT NULL"); } catch (_) {}
    }
    if (!colNames.has('comment')) {
      db.exec('ALTER TABLE reputation ADD COLUMN comment TEXT');
    }
  } catch (_) { /* best-effort */ }
  try {
    const cols = db.prepare("PRAGMA table_info(publics)").all();
    if (!new Set(cols.map(c => c.name)).has('cover')) {
      db.exec('ALTER TABLE publics ADD COLUMN cover TEXT');
    }
  } catch (_) { /* best-effort */ }
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all();
    if (!new Set(cols.map(c => c.name)).has('last_seen_at')) {
      db.exec('ALTER TABLE users ADD COLUMN last_seen_at TEXT');
    }
  } catch (_) { /* best-effort */ }
  try {
    const cols = db.prepare("PRAGMA table_info(messages)").all();
    const names = new Set(cols.map(c => c.name));
    if (!names.has('attachment_enc')) db.exec('ALTER TABLE messages ADD COLUMN attachment_enc TEXT');
    if (!names.has('reactions_json')) db.exec('ALTER TABLE messages ADD COLUMN reactions_json TEXT');
  } catch (_) { /* best-effort */ }
  try {
    const cols = db.prepare("PRAGMA table_info(posts)").all();
    const names = new Set(cols.map(c => c.name));
    if (!names.has('edited_at')) db.exec('ALTER TABLE posts ADD COLUMN edited_at TEXT');
    if (!names.has('poll_json')) db.exec('ALTER TABLE posts ADD COLUMN poll_json TEXT');
    if (!names.has('pinned_at')) db.exec('ALTER TABLE posts ADD COLUMN pinned_at TEXT');
    if (!names.has('images_json')) db.exec('ALTER TABLE posts ADD COLUMN images_json TEXT');
  } catch (_) { /* best-effort */ }
  try {
    const cols = db.prepare("PRAGMA table_info(messages)").all();
    if (!new Set(cols.map(c => c.name)).has('deleted_at')) {
      db.exec('ALTER TABLE messages ADD COLUMN deleted_at TEXT');
    }
  } catch (_) { /* best-effort */ }
  // One-time backfill: every existing Steam user gets a corresponding
  // auth_methods row, so the new multi-provider login UI works for them
  // immediately and they can bind Telegram without re-logging-in.
  try {
    const existing = db.prepare("SELECT COUNT(*) AS n FROM auth_methods WHERE provider = 'steam'").get();
    const userCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE steam_id NOT LIKE 'tg:%'").get();
    if ((existing?.n || 0) < (userCount?.n || 0)) {
      const now = new Date().toISOString();
      db.exec('BEGIN');
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO auth_methods (steam_id, provider, external_id, external_name, external_avatar, verified, created_at, last_login_at)
         VALUES (?, 'steam', ?, ?, ?, 1, ?, ?)`
      );
      const users = db.prepare("SELECT steam_id, persona_name, avatar FROM users WHERE steam_id NOT LIKE 'tg:%'").all();
      for (const u of users) {
        stmt.run(u.steam_id, u.steam_id, u.persona_name || null, u.avatar || null, now, now);
      }
      db.exec('COMMIT');
      console.log(`[migrate] backfilled auth_methods for ${users.length} existing Steam user(s)`);
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.warn('[migrate] auth_methods backfill failed:', e?.message);
  }
  return db;
}

// ----------------------- json fallback ---------------------
function emptyFallback() {
  return {
    version: 1,
    users: {},
    sessions: {},
    inventory_snapshots: [],
    prices: {},
    price_history: [],
    watchlist: {},
    user_settings: {},
    inventory_cache: {},
    reputation: {},
    publics: {},
    posts: [],
    subscriptions: {},
    friendships: {},
    blocks: {},
    messages: [],
    reports: [],
    user_bans: {},
    moderators: {},
    public_editors: {},
    post_likes: {},
    post_views: {},
    post_comments: [],
    roles: [],
    role_members: {},
    events: []
  };
}
function readFallback() {
  ensureDir();
  if (!fs.existsSync(JSON_FILE)) return emptyFallback();
  try { return { ...emptyFallback(), ...JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')) }; }
  catch (_) { return emptyFallback(); }
}
function writeFallback(state) {
  ensureDir();
  fs.writeFileSync(JSON_FILE, JSON.stringify(state, null, 2));
}

// ----------------------- common API ------------------------
function useSqlite() { return openSqlite() !== null; }

// ----- users -----
function upsertUser(profile) {
  const steamId = profile.steamid || profile.steam_id;
  if (!steamId) return null;
  const now = nowIso();
  const personaName = profile.personaname || profile.persona_name || '';
  const avatar = profile.avatarfull || profile.avatar || '';
  const steamUrl = profile.profileurl || profile.steam_url || '';
  const visibility = String(profile.communityvisibilitystate || profile.visibility || '');
  if (useSqlite()) {
    const d = openSqlite();
    const existing = d.prepare('SELECT created_at FROM users WHERE steam_id = ?').get(steamId);
    const createdAt = existing ? existing.created_at : now;
    d.prepare(`INSERT INTO users (steam_id, persona_name, avatar, steam_url, visibility, profile_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(steam_id) DO UPDATE SET
        persona_name = excluded.persona_name,
        avatar = excluded.avatar,
        steam_url = excluded.steam_url,
        visibility = excluded.visibility,
        profile_json = excluded.profile_json,
        updated_at = excluded.updated_at`)
      .run(steamId, personaName, avatar, steamUrl, visibility, JSON.stringify(profile), createdAt, now);
    return { steam_id: steamId, persona_name: personaName, avatar, steam_url: steamUrl, visibility, updated_at: now };
  }
  const state = readFallback();
  const existing = state.users[steamId];
  state.users[steamId] = {
    steam_id: steamId,
    persona_name: personaName,
    avatar,
    steam_url: steamUrl,
    visibility,
    profile_json: JSON.stringify(profile),
    created_at: existing?.created_at || now,
    updated_at: now
  };
  writeFallback(state);
  return state.users[steamId];
}

function getUser(steamId) {
  if (!steamId) return null;
  if (useSqlite()) {
    return openSqlite().prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId) || null;
  }
  return readFallback().users[steamId] || null;
}

// Update last activity timestamp; called by middleware on every authed request.
// Throttle externally — this method itself just writes.
function touchLastSeen(steamId, iso) {
  if (!steamId) return;
  const at = iso || nowIso();
  if (useSqlite()) {
    openSqlite().prepare('UPDATE users SET last_seen_at = ? WHERE steam_id = ?').run(at, steamId);
  } else {
    const state = readFallback();
    if (state.users[steamId]) { state.users[steamId].last_seen_at = at; writeFallback(state); }
  }
}

function getLastSeen(steamId) {
  if (!steamId) return null;
  if (useSqlite()) {
    const r = openSqlite().prepare('SELECT last_seen_at FROM users WHERE steam_id = ?').get(steamId);
    return r?.last_seen_at || null;
  }
  return readFallback().users[steamId]?.last_seen_at || null;
}

// Case-insensitive search by persona_name among users who logged in at least once.
function searchUsers(query, limit = 20) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || q.length < 2) return [];
  const like = `%${q}%`;
  if (useSqlite()) {
    return openSqlite().prepare(
      `SELECT steam_id, persona_name, avatar FROM users
       WHERE LOWER(persona_name) LIKE ? ORDER BY updated_at DESC LIMIT ?`
    ).all(like, limit);
  }
  const rows = Object.values(readFallback().users || {});
  return rows
    .filter(u => (u.persona_name || '').toLowerCase().includes(q))
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, limit)
    .map(u => ({ steam_id: u.steam_id, persona_name: u.persona_name, avatar: u.avatar }));
}

function searchPosts(query, limit = 10) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || q.length < 2) return [];
  const like = `%${q}%`;
  if (useSqlite()) {
    return openSqlite().prepare(
      `SELECT * FROM posts WHERE LOWER(title) LIKE ? OR LOWER(body) LIKE ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(like, like, limit);
  }
  return (readFallback().posts || [])
    .filter(p => (p.title || '').toLowerCase().includes(q) || (p.body || '').toLowerCase().includes(q))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, limit);
}

function searchPublics(query, limit = 10) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || q.length < 2) return [];
  const like = `%${q}%`;
  if (useSqlite()) {
    return openSqlite().prepare(
      `SELECT * FROM publics WHERE LOWER(name) LIKE ? OR LOWER(description) LIKE ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(like, like, limit);
  }
  return (readFallback().publics || [])
    .filter(p => (p.name || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q))
    .slice(0, limit);
}

// Posts authored by a user (for profile activity)
function listPostsByAuthor(steamId, limit = 20) {
  if (useSqlite()) {
    return openSqlite().prepare(
      `SELECT * FROM posts WHERE author_steam_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(steamId, limit);
  }
  return (readFallback().posts || [])
    .filter(p => p.author_steam_id === steamId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, limit);
}

// Comments authored by a user, joined with post info (for profile activity)
function listCommentsByAuthor(steamId, limit = 20) {
  if (useSqlite()) {
    return openSqlite().prepare(
      `SELECT c.*, p.title AS post_title, p.public_id AS post_public_id
       FROM post_comments c LEFT JOIN posts p ON p.id = c.post_id
       WHERE c.author_steam_id = ? ORDER BY c.created_at DESC LIMIT ?`
    ).all(steamId, limit);
  }
  const comments = Object.values(readFallback().post_comments || {})
    .filter(c => c.author_steam_id === steamId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, limit);
  const posts = readFallback().posts || [];
  return comments.map(c => {
    const p = posts.find(x => x.id === c.post_id);
    return { ...c, post_title: p?.title, post_public_id: p?.public_id };
  });
}

// ----- sessions -----
function createSession(steamId, ttlMs = 1000 * 60 * 60 * 24 * 30) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const created = new Date(now).toISOString();
  const expires = new Date(now + ttlMs).toISOString();
  if (useSqlite()) {
    openSqlite().prepare(
      'INSERT INTO sessions (token, steam_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).run(token, steamId, created, expires);
  } else {
    const state = readFallback();
    state.sessions[token] = { token, steam_id: steamId, created_at: created, expires_at: expires };
    writeFallback(state);
  }
  return { token, expires };
}

function getSession(token) {
  if (!token) return null;
  let row = null;
  if (useSqlite()) {
    row = openSqlite().prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  } else {
    row = readFallback().sessions[token] || null;
  }
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    deleteSession(token);
    return null;
  }
  return row;
}

function deleteSession(token) {
  if (!token) return;
  if (useSqlite()) {
    openSqlite().prepare('DELETE FROM sessions WHERE token = ?').run(token);
  } else {
    const state = readFallback();
    delete state.sessions[token];
    writeFallback(state);
  }
}

// ----- inventory snapshots -----
function saveInventorySnapshot(payload) {
  const id = uuid();
  const row = {
    id,
    steam_id: payload.steam_id,
    currency: payload.currency || 'RUB',
    total_items: Number(payload.total_items || 0),
    total_value: payload.total_value == null ? null : Number(payload.total_value),
    total_value_text: payload.total_value_text || null,
    status: payload.status || 'ok',
    items_json: JSON.stringify(payload.items || []),
    pricing_json: JSON.stringify(payload.pricing || {}),
    created_at: nowIso()
  };
  if (useSqlite()) {
    openSqlite().prepare(`INSERT INTO inventory_snapshots
      (id, steam_id, currency, total_items, total_value, total_value_text, status, items_json, pricing_json, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        row.id, row.steam_id, row.currency, row.total_items, row.total_value,
        row.total_value_text, row.status, row.items_json, row.pricing_json, row.created_at
      );
  } else {
    const state = readFallback();
    state.inventory_snapshots.push(row);
    // keep last 50 per user
    const byUser = {};
    for (const r of state.inventory_snapshots) {
      (byUser[r.steam_id] = byUser[r.steam_id] || []).push(r);
    }
    state.inventory_snapshots = Object.values(byUser).flatMap(arr =>
      arr.sort((a,b) => b.created_at.localeCompare(a.created_at)).slice(0, 50));
    writeFallback(state);
  }
  return row;
}

function listInventorySnapshots(steamId, limit = 30) {
  if (!steamId) return [];
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT id, steam_id, currency, total_items, total_value, total_value_text, status, created_at
      FROM inventory_snapshots WHERE steam_id = ? ORDER BY created_at DESC LIMIT ?`).all(steamId, limit);
  }
  const state = readFallback();
  return state.inventory_snapshots
    .filter(r => r.steam_id === steamId)
    .sort((a,b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map(r => ({ id: r.id, steam_id: r.steam_id, currency: r.currency, total_items: r.total_items,
      total_value: r.total_value, total_value_text: r.total_value_text, status: r.status, created_at: r.created_at }));
}

function latestInventorySnapshot(steamId) {
  const arr = listInventorySnapshots(steamId, 1);
  return arr[0] || null;
}

// ----- prices -----
function priceKey(name, currency, source) { return `${name}::${currency}::${source}`; }

function setPrice({ market_name, currency, source, price_value, price_text }) {
  const now = nowIso();
  if (useSqlite()) {
    const d = openSqlite();
    d.prepare(`INSERT INTO prices (market_name, currency, source, price_value, price_text, fetched_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(market_name, currency, source) DO UPDATE SET
        price_value = excluded.price_value,
        price_text = excluded.price_text,
        fetched_at = excluded.fetched_at`)
      .run(market_name, currency, source, price_value, price_text, now);
    d.prepare(`INSERT INTO price_history (market_name, currency, source, price_value, recorded_at)
      VALUES (?,?,?,?,?)`).run(market_name, currency, source, price_value, now);
  } else {
    const state = readFallback();
    state.prices[priceKey(market_name, currency, source)] = {
      market_name, currency, source, price_value, price_text, fetched_at: now
    };
    state.price_history.push({ market_name, currency, source, price_value, recorded_at: now });
    if (state.price_history.length > 20000) state.price_history = state.price_history.slice(-20000);
    writeFallback(state);
  }
}

function getPrice(market_name, currency, source = 'steam') {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM prices WHERE market_name = ? AND currency = ? AND source = ?`)
      .get(market_name, currency, source) || null;
  }
  return readFallback().prices[priceKey(market_name, currency, source)] || null;
}

function getPriceHistory(market_name, currency, source = 'steam', days = 30) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT recorded_at, price_value FROM price_history
      WHERE market_name = ? AND currency = ? AND source = ? AND recorded_at >= ?
      ORDER BY recorded_at ASC`).all(market_name, currency, source, cutoff);
  }
  return readFallback().price_history
    .filter(r => r.market_name === market_name && r.currency === currency && r.source === source && r.recorded_at >= cutoff)
    .sort((a,b) => a.recorded_at.localeCompare(b.recorded_at));
}

// ----- watchlist -----
function listWatchlist(steamId) {
  if (!steamId) return [];
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM watchlist WHERE steam_id = ? ORDER BY created_at DESC`).all(steamId);
  }
  return Object.values(readFallback().watchlist)
    .filter(r => r.steam_id === steamId)
    .sort((a,b) => b.created_at.localeCompare(a.created_at));
}

function addWatch({ steam_id, market_name, threshold_above, threshold_below }) {
  const id = uuid();
  const row = { id, steam_id, market_name, threshold_above: threshold_above ?? null,
    threshold_below: threshold_below ?? null, created_at: nowIso() };
  if (useSqlite()) {
    try {
      openSqlite().prepare(`INSERT INTO watchlist (id, steam_id, market_name, threshold_above, threshold_below, created_at)
        VALUES (?,?,?,?,?,?)`).run(row.id, row.steam_id, row.market_name, row.threshold_above, row.threshold_below, row.created_at);
    } catch (e) {
      if (String(e).includes('UNIQUE')) {
        const existing = openSqlite().prepare(`SELECT * FROM watchlist WHERE steam_id = ? AND market_name = ?`).get(steam_id, market_name);
        return existing;
      }
      throw e;
    }
  } else {
    const state = readFallback();
    const dup = Object.values(state.watchlist).find(r => r.steam_id === steam_id && r.market_name === market_name);
    if (dup) return dup;
    state.watchlist[id] = row;
    writeFallback(state);
  }
  return row;
}

function removeWatch(steamId, marketName) {
  if (useSqlite()) {
    openSqlite().prepare(`DELETE FROM watchlist WHERE steam_id = ? AND market_name = ?`).run(steamId, marketName);
  } else {
    const state = readFallback();
    for (const [k, v] of Object.entries(state.watchlist)) {
      if (v.steam_id === steamId && v.market_name === marketName) delete state.watchlist[k];
    }
    writeFallback(state);
  }
}

// ----- user settings -----
function getSettings(steamId) {
  if (!steamId) return null;
  const empty = { steam_id: steamId, currency: 'RUB', language: 'ru',
    telegram_id: null, faceit_nickname: null, consent_at: null, show_activity: 1, cover_url: null, onboarding_done: 0, updated_at: null };
  let row;
  if (useSqlite()) {
    row = openSqlite().prepare(`SELECT * FROM user_settings WHERE steam_id = ?`).get(steamId) || empty;
  } else {
    row = readFallback().user_settings[steamId] || empty;
  }
  // Treat NULL/undefined as default ON for show_activity
  if (row.show_activity == null) row.show_activity = 1;
  if (row.onboarding_done == null) row.onboarding_done = 0;
  return row;
}

function setSettings(steamId, patch = {}) {
  const cur = getSettings(steamId);
  const next = {
    steam_id: steamId,
    currency: patch.currency || cur.currency || 'RUB',
    language: patch.language || cur.language || 'ru',
    telegram_id: patch.telegram_id !== undefined ? patch.telegram_id : cur.telegram_id,
    faceit_nickname: patch.faceit_nickname !== undefined ? patch.faceit_nickname : cur.faceit_nickname,
    consent_at: patch.consent_at !== undefined ? patch.consent_at : cur.consent_at,
    show_activity: patch.show_activity !== undefined ? (patch.show_activity ? 1 : 0) : (cur.show_activity ?? 1),
    cover_url: patch.cover_url !== undefined ? patch.cover_url : cur.cover_url,
    onboarding_done: patch.onboarding_done !== undefined ? (patch.onboarding_done ? 1 : 0) : (cur.onboarding_done ?? 0),
    updated_at: nowIso()
  };
  if (useSqlite()) {
    openSqlite().prepare(`INSERT INTO user_settings (steam_id, currency, language, telegram_id, faceit_nickname, consent_at, show_activity, cover_url, onboarding_done, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(steam_id) DO UPDATE SET
        currency = excluded.currency,
        language = excluded.language,
        telegram_id = excluded.telegram_id,
        faceit_nickname = excluded.faceit_nickname,
        consent_at = excluded.consent_at,
        show_activity = excluded.show_activity,
        cover_url = excluded.cover_url,
        onboarding_done = excluded.onboarding_done,
        updated_at = excluded.updated_at`)
      .run(next.steam_id, next.currency, next.language, next.telegram_id, next.faceit_nickname, next.consent_at, next.show_activity, next.cover_url, next.onboarding_done, next.updated_at);
  } else {
    const state = readFallback();
    state.user_settings[steamId] = next;
    writeFallback(state);
  }
  return next;
}

// ----- inventory cache (full priced payload, keyed by steam_id + currency) -----
function getInventoryCache(steamId, currency) {
  if (!steamId) return null;
  if (useSqlite()) {
    const row = openSqlite()
      .prepare(`SELECT payload_json, fetched_at FROM inventory_cache WHERE steam_id = ? AND currency = ?`)
      .get(steamId, currency);
    if (!row) return null;
    try { return { payload: JSON.parse(row.payload_json), fetched_at: row.fetched_at }; }
    catch (_) { return null; }
  }
  const row = (readFallback().inventory_cache || {})[`${steamId}:${currency}`];
  if (!row) return null;
  try { return { payload: JSON.parse(row.payload_json), fetched_at: row.fetched_at }; }
  catch (_) { return null; }
}

function setInventoryCache(steamId, currency, payload) {
  const fetched_at = nowIso();
  const payload_json = JSON.stringify(payload);
  if (useSqlite()) {
    openSqlite().prepare(`INSERT INTO inventory_cache (steam_id, currency, payload_json, fetched_at)
      VALUES (?,?,?,?)
      ON CONFLICT(steam_id, currency) DO UPDATE SET
        payload_json = excluded.payload_json,
        fetched_at = excluded.fetched_at`)
      .run(steamId, currency, payload_json, fetched_at);
  } else {
    const state = readFallback();
    if (!state.inventory_cache) state.inventory_cache = {};
    state.inventory_cache[`${steamId}:${currency}`] = { payload_json, fetched_at };
    writeFallback(state);
  }
  return fetched_at;
}

// ----- reputation (social credit) -----
const REP_CATEGORIES = {
  cheater:   -1,
  toxic:     -1,
  griefer:   -1,
  good_mate: +1,
  caller:    +1,
  clutch:    +1
};
const REP_COMMENT_MAX = 280;

function sanitizeComment(s) {
  if (!s) return null;
  let t = String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (t.length > REP_COMMENT_MAX) t = t.slice(0, REP_COMMENT_MAX);
  return t || null;
}

// Cast or update a vote. categories is an array of category keys; comment is optional free text.
function castReputation({ voterSteamId, targetSteamId, categories = [], comment = null, weight = 1 }) {
  if (!voterSteamId || !targetSteamId) return { error: 'missing-ids' };
  if (voterSteamId === targetSteamId) return { error: 'self-vote' };
  const cats = Array.isArray(categories) ? categories.filter(c => c in REP_CATEGORIES) : [];
  const cleanComment = sanitizeComment(comment);
  if (cats.length === 0 && !cleanComment) return { error: 'empty-vote' };
  // Net sentiment + a representative primary category (for legacy columns)
  let net = 0;
  for (const c of cats) net += REP_CATEGORIES[c];
  const sentiment = net > 0 ? 1 : net < 0 ? -1 : 0;
  const primary = cats[0] || null;
  const categories_json = JSON.stringify(cats);
  const now = nowIso();

  if (useSqlite()) {
    const d = openSqlite();
    const existing = d.prepare(`SELECT created_at FROM reputation WHERE voter_steam_id = ? AND target_steam_id = ?`)
      .get(voterSteamId, targetSteamId);
    const created = existing?.created_at || now;
    d.prepare(`INSERT INTO reputation (voter_steam_id, target_steam_id, sentiment, category, categories_json, comment, weight, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(voter_steam_id, target_steam_id) DO UPDATE SET
        sentiment = excluded.sentiment,
        category = excluded.category,
        categories_json = excluded.categories_json,
        comment = excluded.comment,
        weight = excluded.weight,
        updated_at = excluded.updated_at`)
      .run(voterSteamId, targetSteamId, sentiment, primary, categories_json, cleanComment, weight, created, now);
  } else {
    const state = readFallback();
    if (!state.reputation) state.reputation = {};
    const key = `${voterSteamId}:${targetSteamId}`;
    const created = state.reputation[key]?.created_at || now;
    state.reputation[key] = { voter_steam_id: voterSteamId, target_steam_id: targetSteamId,
      sentiment, category: primary, categories_json, comment: cleanComment, weight,
      created_at: created, updated_at: now };
    writeFallback(state);
  }
  return { ok: true, sentiment, categories: cats, comment: cleanComment };
}

// Remove a voter's vote on a target
function removeReputation(voterSteamId, targetSteamId) {
  if (useSqlite()) {
    openSqlite().prepare(`DELETE FROM reputation WHERE voter_steam_id = ? AND target_steam_id = ?`)
      .run(voterSteamId, targetSteamId);
  } else {
    const state = readFallback();
    delete (state.reputation || {})[`${voterSteamId}:${targetSteamId}`];
    writeFallback(state);
  }
  return { ok: true };
}

// Parse a row's categories (supports both new categories_json and legacy single category)
function rowCategories(r) {
  if (r.categories_json) {
    try { const a = JSON.parse(r.categories_json); if (Array.isArray(a) && a.length) return a; } catch (_) {}
  }
  // Fallback to legacy single-category column (covers pre-migration rows whose
  // categories_json defaulted to '[]')
  return r.category ? [r.category] : [];
}

function getReputationFor(targetSteamId) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM reputation WHERE target_steam_id = ?`).all(targetSteamId);
  }
  return Object.values(readFallback().reputation || {}).filter(r => r.target_steam_id === targetSteamId);
}

function getReputationVote(voterSteamId, targetSteamId) {
  let row;
  if (useSqlite()) {
    row = openSqlite().prepare(`SELECT * FROM reputation WHERE voter_steam_id = ? AND target_steam_id = ?`)
      .get(voterSteamId, targetSteamId) || null;
  } else {
    row = (readFallback().reputation || {})[`${voterSteamId}:${targetSteamId}`] || null;
  }
  if (!row) return null;
  return { categories: rowCategories(row), comment: row.comment || null, sentiment: row.sentiment };
}

function countRecentVotes(voterSteamId, sinceMs) {
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT COUNT(*) AS c FROM reputation WHERE voter_steam_id = ? AND updated_at >= ?`)
      .get(voterSteamId, cutoff).c;
  }
  return Object.values(readFallback().reputation || {})
    .filter(r => r.voter_steam_id === voterSteamId && r.updated_at >= cutoff).length;
}

// Aggregate reputation for display
function aggregateReputation(targetSteamId) {
  const rows = getReputationFor(targetSteamId).filter(r => (r.weight ?? 1) > 0);
  const byCat = {};
  let praise = 0, reports = 0;     // direct sums of positive / negative category marks
  let posVoters = 0, negVoters = 0; // voter-level lean (used only for the verdict label)
  const comments = [];
  for (const r of rows) {
    const cats = rowCategories(r);
    let good = 0, bad = 0;
    for (const c of cats) {
      byCat[c] = (byCat[c] || 0) + 1;
      if (REP_CATEGORIES[c] > 0) { good += 1; praise += 1; }
      else { bad += 1; reports += 1; }
    }
    if (good > bad) posVoters += 1;
    else if (bad > good) negVoters += 1;
    if (r.comment) {
      comments.push({ comment: r.comment, categories: cats, updated_at: r.updated_at });
    }
  }
  const total = rows.length;
  // Verdict label is based on how voters lean overall (not raw mark counts),
  // so a few mixed votes don't swing it.
  const score = posVoters - negVoters;
  let label = 'neutral';
  if (total >= 3) {
    if (score >= 3 && posVoters >= negVoters * 2) label = 'good';
    else if (score <= -3 && negVoters >= posVoters * 2) label = 'bad';
    else label = 'mixed';
  }
  comments.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return { total, praise, reports, score, byCat, label, comments: comments.slice(0, 20) };
}

// ----- feed: publics / posts / subscriptions -----
function listPublics() {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM publics ORDER BY verified DESC, name ASC`).all();
  }
  return Object.values(readFallback().publics || {});
}

function getPublic(id) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM publics WHERE id = ?`).get(id) || null;
  }
  return (readFallback().publics || {})[id] || null;
}

// Generate a url-safe slug id from a name, with a short random suffix for uniqueness
function makePublicId(name) {
  const base = String(name || 'public').toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'public';
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
}

function createPublic({ owner_steam_id, name, description, avatar, cover }) {
  const id = makePublicId(name);
  const created_at = nowIso();
  const row = { id, owner_steam_id, name, description: description || null, avatar: avatar || null, cover: cover || null, verified: 0, created_at };
  if (useSqlite()) {
    openSqlite().prepare(`INSERT INTO publics (id, owner_steam_id, name, description, avatar, cover, verified, created_at)
      VALUES (?,?,?,?,?,?,0,?)`).run(id, owner_steam_id, name, description || null, avatar || null, cover || null, created_at);
  } else {
    const state = readFallback();
    if (!state.publics) state.publics = {};
    state.publics[id] = row;
    writeFallback(state);
  }
  return row;
}

// Update editable fields of a public (owner only — caller checks)
function updatePublic(id, { name, description, avatar, cover }) {
  const cur = getPublic(id);
  if (!cur) return { error: 'not-found' };
  const next = {
    name: name !== undefined ? name : cur.name,
    description: description !== undefined ? description : cur.description,
    avatar: avatar !== undefined ? avatar : cur.avatar,
    cover: cover !== undefined ? cover : cur.cover
  };
  if (useSqlite()) {
    openSqlite().prepare(`UPDATE publics SET name=?, description=?, avatar=?, cover=? WHERE id=?`)
      .run(next.name, next.description, next.avatar, next.cover, id);
  } else {
    const state = readFallback();
    Object.assign(state.publics[id], next);
    writeFallback(state);
  }
  return { ok: true };
}

// How many publics this user already owns (to rate-limit creation)
function countPublicsByOwner(steamId) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT COUNT(*) AS c FROM publics WHERE owner_steam_id=?`).get(steamId).c;
  }
  return Object.values(readFallback().publics || {}).filter(p => p.owner_steam_id === steamId).length;
}

function getPost(id) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM posts WHERE id=?`).get(Number(id)) || null;
  }
  return (readFallback().posts || []).find(p => p.id === Number(id)) || null;
}

function createPost({ public_id, author_steam_id, title, body, link, image, images }) {
  const created_at = nowIso();
  // Normalize: prefer `images` array; fall back to single `image`
  let imageList = Array.isArray(images) ? images.filter(Boolean).slice(0, 6) : null;
  if (!imageList && image) imageList = [image];
  const primary = imageList?.[0] || null;
  const imagesJson = imageList && imageList.length > 1 ? JSON.stringify(imageList) : null;
  if (useSqlite()) {
    const info = openSqlite().prepare(`INSERT INTO posts (public_id, author_steam_id, title, body, link, image, images_json, created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(public_id, author_steam_id, title || null, body, link || null, primary, imagesJson, created_at);
    return { id: Number(info.lastInsertRowid), public_id, author_steam_id, title, body, link, image: primary, images: imageList, created_at };
  }
  const state = readFallback();
  if (!state.posts) state.posts = [];
  const id = (state.posts.reduce((m, p) => Math.max(m, p.id || 0), 0) || 0) + 1;
  const row = { id, public_id, author_steam_id, title: title || null, body, link: link || null,
    image: primary, images_json: imagesJson, created_at };
  state.posts.push(row);
  writeFallback(state);
  return row;
}

// Posts from a set of public_ids (for a personalized feed), newest first
function listPosts({ publicIds = null, limit = 50 } = {}) {
  if (useSqlite()) {
    const d = openSqlite();
    // Order: pinned-in-this-public first, then by recency. Pinned status is local to each public.
    if (publicIds && publicIds.length) {
      const ph = publicIds.map(() => '?').join(',');
      return d.prepare(`SELECT * FROM posts WHERE public_id IN (${ph})
        ORDER BY (CASE WHEN pinned_at IS NOT NULL THEN 0 ELSE 1 END), created_at DESC LIMIT ?`)
        .all(...publicIds, limit);
    }
    return d.prepare(`SELECT * FROM posts ORDER BY created_at DESC LIMIT ?`).all(limit);
  }
  let rows = (readFallback().posts || []).slice();
  if (publicIds && publicIds.length) rows = rows.filter(p => publicIds.includes(p.public_id));
  rows.sort((a, b) => {
    const pa = a.pinned_at ? 0 : 1, pb = b.pinned_at ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
  return rows.slice(0, limit);
}

// ----- post likes -----
function likePost(postId, steamId) {
  const created_at = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(`INSERT INTO post_likes (post_id, steam_id, created_at) VALUES (?,?,?)
      ON CONFLICT(post_id, steam_id) DO NOTHING`).run(Number(postId), steamId, created_at);
  } else {
    const state = readFallback();
    if (!state.post_likes) state.post_likes = {};
    state.post_likes[`${postId}:${steamId}`] = { post_id: Number(postId), steam_id: steamId, created_at };
    writeFallback(state);
  }
  return { ok: true };
}
function unlikePost(postId, steamId) {
  if (useSqlite()) {
    openSqlite().prepare(`DELETE FROM post_likes WHERE post_id=? AND steam_id=?`).run(Number(postId), steamId);
  } else {
    const state = readFallback();
    delete (state.post_likes || {})[`${postId}:${steamId}`];
    writeFallback(state);
  }
  return { ok: true };
}
function hasLiked(postId, steamId) {
  if (!steamId) return false;
  if (useSqlite()) {
    return !!openSqlite().prepare(`SELECT 1 FROM post_likes WHERE post_id=? AND steam_id=?`).get(Number(postId), steamId);
  }
  return !!(readFallback().post_likes || {})[`${postId}:${steamId}`];
}
function countLikes(postId) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT COUNT(*) AS c FROM post_likes WHERE post_id=?`).get(Number(postId)).c;
  }
  return Object.values(readFallback().post_likes || {}).filter(l => l.post_id === Number(postId)).length;
}

// ----- post views (one per user per post) -----
function viewPost(postId, steamId) {
  if (!steamId) return { ok: false };
  const created_at = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(`INSERT INTO post_views (post_id, steam_id, created_at) VALUES (?,?,?)
      ON CONFLICT(post_id, steam_id) DO NOTHING`).run(Number(postId), steamId, created_at);
  } else {
    const state = readFallback();
    if (!state.post_views) state.post_views = {};
    state.post_views[`${postId}:${steamId}`] = { post_id: Number(postId), steam_id: steamId, created_at };
    writeFallback(state);
  }
  return { ok: true };
}
function countViews(postId) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT COUNT(*) AS c FROM post_views WHERE post_id=?`).get(Number(postId)).c;
  }
  return Object.values(readFallback().post_views || {}).filter(v => v.post_id === Number(postId)).length;
}

// ----- post comments -----
function addComment(postId, authorSteamId, body) {
  const created_at = nowIso();
  const text = String(body || '').slice(0, 1000);
  if (useSqlite()) {
    const info = openSqlite().prepare(
      `INSERT INTO post_comments (post_id, author_steam_id, body, created_at) VALUES (?,?,?,?)`
    ).run(Number(postId), authorSteamId, text, created_at);
    return { id: Number(info.lastInsertRowid), post_id: Number(postId), author_steam_id: authorSteamId, body: text, created_at };
  }
  const state = readFallback();
  if (!state.post_comments) state.post_comments = [];
  const id = (state.post_comments.reduce((m, c) => Math.max(m, c.id || 0), 0) || 0) + 1;
  const row = { id, post_id: Number(postId), author_steam_id: authorSteamId, body: text, created_at };
  state.post_comments.push(row);
  writeFallback(state);
  return row;
}

function deleteComment(id) {
  if (useSqlite()) {
    openSqlite().prepare(`DELETE FROM post_comments WHERE id=?`).run(Number(id));
  } else {
    const state = readFallback();
    state.post_comments = (state.post_comments || []).filter(c => c.id !== Number(id));
    writeFallback(state);
  }
  return { ok: true };
}

function getComment(id) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM post_comments WHERE id=?`).get(Number(id)) || null;
  }
  return (readFallback().post_comments || []).find(c => c.id === Number(id)) || null;
}

function listComments(postId, limit = 200) {
  if (useSqlite()) {
    return openSqlite().prepare(
      `SELECT * FROM post_comments WHERE post_id=? ORDER BY created_at ASC LIMIT ?`
    ).all(Number(postId), limit);
  }
  return (readFallback().post_comments || [])
    .filter(c => c.post_id === Number(postId))
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .slice(0, limit);
}

function countComments(postId) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT COUNT(*) AS c FROM post_comments WHERE post_id=?`).get(Number(postId)).c;
  }
  return (readFallback().post_comments || []).filter(c => c.post_id === Number(postId)).length;
}

// Attach like/view counts to an array of posts; mark which I liked.
function attachPostStats(posts, mySteamId) {
  if (!posts?.length) return posts;
  const ids = posts.map(p => Number(p.id));
  let likeMap = {}, viewMap = {}, commentMap = {}, mineSet = new Set();
  if (useSqlite()) {
    const d = openSqlite();
    const ph = ids.map(() => '?').join(',');
    for (const r of d.prepare(`SELECT post_id, COUNT(*) AS c FROM post_likes WHERE post_id IN (${ph}) GROUP BY post_id`).all(...ids)) likeMap[r.post_id] = r.c;
    for (const r of d.prepare(`SELECT post_id, COUNT(*) AS c FROM post_views WHERE post_id IN (${ph}) GROUP BY post_id`).all(...ids)) viewMap[r.post_id] = r.c;
    for (const r of d.prepare(`SELECT post_id, COUNT(*) AS c FROM post_comments WHERE post_id IN (${ph}) GROUP BY post_id`).all(...ids)) commentMap[r.post_id] = r.c;
    if (mySteamId) for (const r of d.prepare(`SELECT post_id FROM post_likes WHERE post_id IN (${ph}) AND steam_id=?`).all(...ids, mySteamId)) mineSet.add(r.post_id);
  } else {
    const state = readFallback();
    for (const l of Object.values(state.post_likes || {})) { if (ids.includes(l.post_id)) { likeMap[l.post_id] = (likeMap[l.post_id] || 0) + 1; if (l.steam_id === mySteamId) mineSet.add(l.post_id); } }
    for (const v of Object.values(state.post_views || {})) { if (ids.includes(v.post_id)) viewMap[v.post_id] = (viewMap[v.post_id] || 0) + 1; }
    for (const c of (state.post_comments || [])) { if (ids.includes(c.post_id)) commentMap[c.post_id] = (commentMap[c.post_id] || 0) + 1; }
  }
  for (const p of posts) {
    p.likes = likeMap[p.id] || 0;
    p.views = viewMap[p.id] || 0;
    p.comments = commentMap[p.id] || 0;
    p.liked = mineSet.has(p.id);
  }
  return posts;
}

// ----- friend recommendations: friends-of-my-friends, excluding existing relations -----
function recommendFriends(steamId, limit = 20) {
  if (!steamId) return [];
  const my = listFriends(steamId);
  const myFriendIds = new Set(my.friends.map(f => f.steam_id));
  // Also exclude those with whom we have any pending request
  const excluded = new Set([
    steamId,
    ...myFriendIds,
    ...my.incoming.map(f => f.steam_id),
    ...my.outgoing.map(f => f.steam_id)
  ]);
  const myBlocked = new Set(listBlocks(steamId));
  for (const b of myBlocked) excluded.add(b);

  // Tally friends-of-friends
  const tally = {}; // steam_id -> count of mutual paths
  for (const fId of myFriendIds) {
    const sub = listFriends(fId);
    for (const ff of sub.friends) {
      if (excluded.has(ff.steam_id)) continue;
      if (isBlocked(ff.steam_id, steamId)) continue; // they blocked me
      tally[ff.steam_id] = (tally[ff.steam_id] || 0) + 1;
    }
  }
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([steam_id, mutuals]) => ({ steam_id, mutuals }));
}

function listSubscriptions(steamId) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT public_id FROM subscriptions WHERE steam_id = ?`).all(steamId).map(r => r.public_id);
  }
  return Object.values(readFallback().subscriptions || {})
    .filter(s => s.steam_id === steamId).map(s => s.public_id);
}

function countSubscribers(publicId) {
  if (useSqlite()) {
    const r = openSqlite().prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE public_id = ?`).get(publicId);
    return r?.n || 0;
  }
  return Object.values(readFallback().subscriptions || {})
    .filter(s => s.public_id === publicId).length;
}

// Stats overview for a community: subscriber count, daily growth (last 30 days),
// post count, total likes/comments/views, top posts by engagement.
function getPublicStats(publicId) {
  const now = Date.now();
  const thirtyDaysAgoISO = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgoISO = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  let subs = [];
  let posts = [];
  let likes = [];
  let comments = [];
  let views = [];

  if (useSqlite()) {
    const d = openSqlite();
    subs = d.prepare(`SELECT created_at FROM subscriptions WHERE public_id = ? ORDER BY created_at`).all(publicId);
    posts = d.prepare(`SELECT id, title, body, created_at, image FROM posts WHERE public_id = ? ORDER BY created_at DESC`).all(publicId);
    const postIds = posts.map(p => p.id);
    if (postIds.length) {
      const ph = postIds.map(() => '?').join(',');
      likes = d.prepare(`SELECT post_id, COUNT(*) AS n FROM post_likes WHERE post_id IN (${ph}) GROUP BY post_id`).all(...postIds);
      comments = d.prepare(`SELECT post_id, COUNT(*) AS n FROM post_comments WHERE post_id IN (${ph}) GROUP BY post_id`).all(...postIds);
      views = d.prepare(`SELECT post_id, COUNT(*) AS n FROM post_views WHERE post_id IN (${ph}) GROUP BY post_id`).all(...postIds);
    }
  } else {
    const state = readFallback();
    subs = Object.values(state.subscriptions || {}).filter(s => s.public_id === publicId);
    posts = (state.posts || []).filter(p => p.public_id === publicId);
    const postIds = new Set(posts.map(p => p.id));
    const groupBy = (arr, key) => {
      const m = new Map();
      for (const r of arr) if (postIds.has(r.post_id ?? r[key])) m.set(r.post_id ?? r[key], (m.get(r.post_id ?? r[key]) || 0) + 1);
      return Array.from(m, ([post_id, n]) => ({ post_id, n }));
    };
    likes = groupBy(Object.values(state.post_likes || {}), 'post_id');
    comments = groupBy(Object.values(state.post_comments || {}), 'post_id');
    views = groupBy(Object.values(state.post_views || {}), 'post_id');
  }

  // Daily subscriber growth over last 30 days (YYYY-MM-DD → cumulative count)
  const daily = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    daily[key] = 0;
  }
  let totalSubs = 0;
  for (const s of subs) {
    totalSubs++;
    if (s.created_at >= thirtyDaysAgoISO) {
      const day = s.created_at.slice(0, 10);
      if (day in daily) daily[day]++;
    }
  }
  const dailySeries = Object.entries(daily).map(([date, count]) => ({ date, new_subscribers: count }));

  // Build per-post stats map and totals
  const likesByPost = new Map(likes.map(r => [r.post_id, r.n]));
  const commentsByPost = new Map(comments.map(r => [r.post_id, r.n]));
  const viewsByPost = new Map(views.map(r => [r.post_id, r.n]));

  const enrichedPosts = posts.map(p => ({
    id: p.id,
    title: p.title,
    body_preview: (p.body || '').slice(0, 80),
    image: p.image || null,
    created_at: p.created_at,
    likes: likesByPost.get(p.id) || 0,
    comments: commentsByPost.get(p.id) || 0,
    views: viewsByPost.get(p.id) || 0,
    score: (likesByPost.get(p.id) || 0) * 3 + (commentsByPost.get(p.id) || 0) * 2 + (viewsByPost.get(p.id) || 0) * 0.1
  }));

  const recentPosts = enrichedPosts.filter(p => p.created_at >= sevenDaysAgoISO);
  const totalLikes = enrichedPosts.reduce((s, p) => s + p.likes, 0);
  const totalComments = enrichedPosts.reduce((s, p) => s + p.comments, 0);
  const totalViews = enrichedPosts.reduce((s, p) => s + p.views, 0);
  const weekLikes = recentPosts.reduce((s, p) => s + p.likes, 0);
  const weekComments = recentPosts.reduce((s, p) => s + p.comments, 0);
  const weekViews = recentPosts.reduce((s, p) => s + p.views, 0);
  const newSubs7d = subs.filter(s => s.created_at >= sevenDaysAgoISO).length;

  // Top 5 posts by engagement score
  const topPosts = enrichedPosts.slice().sort((a, b) => b.score - a.score).slice(0, 5);

  return {
    totals: {
      subscribers: totalSubs,
      posts: posts.length,
      likes: totalLikes,
      comments: totalComments,
      views: totalViews
    },
    week: {
      new_subscribers: newSubs7d,
      posts: recentPosts.length,
      likes: weekLikes,
      comments: weekComments,
      views: weekViews
    },
    daily_growth: dailySeries,
    top_posts: topPosts
  };
}

function subscribe(steamId, publicId) {
  const created_at = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(`INSERT INTO subscriptions (steam_id, public_id, created_at) VALUES (?,?,?)
      ON CONFLICT(steam_id, public_id) DO NOTHING`).run(steamId, publicId, created_at);
  } else {
    const state = readFallback();
    if (!state.subscriptions) state.subscriptions = {};
    state.subscriptions[`${steamId}:${publicId}`] = { steam_id: steamId, public_id: publicId, created_at };
    writeFallback(state);
  }
  return { ok: true };
}

function unsubscribe(steamId, publicId) {
  if (useSqlite()) {
    openSqlite().prepare(`DELETE FROM subscriptions WHERE steam_id = ? AND public_id = ?`).run(steamId, publicId);
  } else {
    const state = readFallback();
    delete (state.subscriptions || {})[`${steamId}:${publicId}`];
    writeFallback(state);
  }
  return { ok: true };
}

// ----- friends / blocks / messages -----

function _friendRow(a, b) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM friendships
      WHERE (requester_steam_id = ? AND addressee_steam_id = ?)
         OR (requester_steam_id = ? AND addressee_steam_id = ?)`).get(a, b, b, a) || null;
  }
  const f = readFallback().friendships || {};
  return f[`${a}:${b}`] || f[`${b}:${a}`] || null;
}

function isBlocked(blocker, blocked) {
  if (useSqlite()) {
    return !!openSqlite().prepare(`SELECT 1 FROM blocks WHERE blocker_steam_id = ? AND blocked_steam_id = ?`)
      .get(blocker, blocked);
  }
  return !!(readFallback().blocks || {})[`${blocker}:${blocked}`];
}

// Either side blocking the other
function eitherBlocked(a, b) {
  return isBlocked(a, b) || isBlocked(b, a);
}

function friendStatus(me, other) {
  if (eitherBlocked(me, other)) return 'blocked';
  const row = _friendRow(me, other);
  if (!row) return 'none';
  if (row.status === 'accepted') return 'friends';
  // pending — distinguish incoming vs outgoing
  return row.requester_steam_id === me ? 'outgoing' : 'incoming';
}

function sendFriendRequest(requester, addressee) {
  if (requester === addressee) return { error: 'self' };
  if (eitherBlocked(requester, addressee)) return { error: 'blocked' };
  const existing = _friendRow(requester, addressee);
  if (existing) {
    if (existing.status === 'accepted') return { error: 'already-friends' };
    // If the other side already requested, accept it instead of duplicating
    if (existing.requester_steam_id === addressee) {
      return acceptFriendRequest(requester, addressee);
    }
    return { error: 'already-pending' };
  }
  const now = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(`INSERT INTO friendships (requester_steam_id, addressee_steam_id, status, created_at, updated_at)
      VALUES (?,?,'pending',?,?)`).run(requester, addressee, now, now);
  } else {
    const state = readFallback();
    if (!state.friendships) state.friendships = {};
    state.friendships[`${requester}:${addressee}`] = { requester_steam_id: requester, addressee_steam_id: addressee, status: 'pending', created_at: now, updated_at: now };
    writeFallback(state);
  }
  return { ok: true, status: 'outgoing' };
}

function acceptFriendRequest(addressee, requester) {
  const row = _friendRow(addressee, requester);
  if (!row || row.status !== 'pending' || row.requester_steam_id !== requester) return { error: 'no-request' };
  const now = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(`UPDATE friendships SET status='accepted', updated_at=?
      WHERE requester_steam_id=? AND addressee_steam_id=?`).run(now, requester, addressee);
  } else {
    const state = readFallback();
    const r = state.friendships[`${requester}:${addressee}`];
    if (r) { r.status = 'accepted'; r.updated_at = now; writeFallback(state); }
  }
  return { ok: true, status: 'friends' };
}

// Decline a request or unfriend an existing friend — both just remove the row
function removeFriend(a, b) {
  if (useSqlite()) {
    openSqlite().prepare(`DELETE FROM friendships
      WHERE (requester_steam_id=? AND addressee_steam_id=?)
         OR (requester_steam_id=? AND addressee_steam_id=?)`).run(a, b, b, a);
  } else {
    const state = readFallback();
    delete state.friendships[`${a}:${b}`];
    delete state.friendships[`${b}:${a}`];
    writeFallback(state);
  }
  return { ok: true };
}

// List friends / incoming / outgoing for a user
function listFriends(steamId) {
  let rows;
  if (useSqlite()) {
    rows = openSqlite().prepare(`SELECT * FROM friendships
      WHERE requester_steam_id=? OR addressee_steam_id=?`).all(steamId, steamId);
  } else {
    rows = Object.values(readFallback().friendships || {})
      .filter(r => r.requester_steam_id === steamId || r.addressee_steam_id === steamId);
  }
  const friends = [], incoming = [], outgoing = [];
  for (const r of rows) {
    const other = r.requester_steam_id === steamId ? r.addressee_steam_id : r.requester_steam_id;
    if (eitherBlocked(steamId, other)) continue;
    if (r.status === 'accepted') friends.push({ steam_id: other, since: r.updated_at });
    else if (r.requester_steam_id === steamId) outgoing.push({ steam_id: other, at: r.created_at });
    else incoming.push({ steam_id: other, at: r.created_at });
  }
  return { friends, incoming, outgoing };
}

function areFriends(a, b) {
  const row = _friendRow(a, b);
  return !!row && row.status === 'accepted' && !eitherBlocked(a, b);
}

function blockUser(blocker, blocked) {
  if (blocker === blocked) return { error: 'self' };
  const now = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(`INSERT INTO blocks (blocker_steam_id, blocked_steam_id, created_at)
      VALUES (?,?,?) ON CONFLICT(blocker_steam_id, blocked_steam_id) DO NOTHING`).run(blocker, blocked, now);
  } else {
    const state = readFallback();
    if (!state.blocks) state.blocks = {};
    state.blocks[`${blocker}:${blocked}`] = { blocker_steam_id: blocker, blocked_steam_id: blocked, created_at: now };
    writeFallback(state);
  }
  // Blocking severs any friendship/requests
  removeFriend(blocker, blocked);
  return { ok: true };
}

function unblockUser(blocker, blocked) {
  if (useSqlite()) {
    openSqlite().prepare(`DELETE FROM blocks WHERE blocker_steam_id=? AND blocked_steam_id=?`).run(blocker, blocked);
  } else {
    const state = readFallback();
    delete state.blocks[`${blocker}:${blocked}`];
    writeFallback(state);
  }
  return { ok: true };
}

function listBlocks(steamId) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT blocked_steam_id FROM blocks WHERE blocker_steam_id=?`).all(steamId).map(r => r.blocked_steam_id);
  }
  return Object.values(readFallback().blocks || {}).filter(b => b.blocker_steam_id === steamId).map(b => b.blocked_steam_id);
}

// Store an (already-encrypted) message. Caller must verify friendship first.
function insertMessage(sender, recipient, bodyEnc, attachmentEnc) {
  const created_at = nowIso();
  if (useSqlite()) {
    const info = openSqlite().prepare(`INSERT INTO messages (sender_steam_id, recipient_steam_id, body_enc, attachment_enc, created_at)
      VALUES (?,?,?,?,?)`).run(sender, recipient, bodyEnc, attachmentEnc || null, created_at);
    return { id: Number(info.lastInsertRowid), created_at };
  }
  const state = readFallback();
  if (!state.messages) state.messages = [];
  const id = (state.messages.reduce((m, x) => Math.max(m, x.id || 0), 0) || 0) + 1;
  state.messages.push({ id, sender_steam_id: sender, recipient_steam_id: recipient, body_enc: bodyEnc, attachment_enc: attachmentEnc || null, created_at, read_at: null });
  writeFallback(state);
  return { id, created_at };
}

// Conversation between two users, oldest→newest
function listMessages(a, b, limit = 100) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM messages
      WHERE (sender_steam_id=? AND recipient_steam_id=?)
         OR (sender_steam_id=? AND recipient_steam_id=?)
      ORDER BY created_at ASC LIMIT ?`).all(a, b, b, a, limit);
  }
  return (readFallback().messages || [])
    .filter(m => (m.sender_steam_id === a && m.recipient_steam_id === b) || (m.sender_steam_id === b && m.recipient_steam_id === a))
    .sort((x, y) => (x.created_at || '').localeCompare(y.created_at || ''))
    .slice(-limit);
}

// Fetch a single message by id (for replies/forwards lookup)
function getMessage(id) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM messages WHERE id=?`).get(Number(id)) || null;
  }
  return (readFallback().messages || []).find(m => m.id === Number(id)) || null;
}

// Mark messages from `other` to `me` as read
function markRead(me, other) {
  const now = nowIso();
  let changed = 0;
  if (useSqlite()) {
    const info = openSqlite().prepare(`UPDATE messages SET read_at=? WHERE recipient_steam_id=? AND sender_steam_id=? AND read_at IS NULL`)
      .run(now, me, other);
    changed = Number(info?.changes || 0);
  } else {
    const state = readFallback();
    for (const m of state.messages || []) {
      if (m.recipient_steam_id === me && m.sender_steam_id === other && !m.read_at) {
        m.read_at = now;
        changed++;
      }
    }
    if (changed) writeFallback(state);
  }
  return { ok: true, changed };
}

// Build the list of conversations for a user, with last message + unread count
function listConversations(steamId) {
  let msgs;
  if (useSqlite()) {
    msgs = openSqlite().prepare(`SELECT * FROM messages WHERE sender_steam_id=? OR recipient_steam_id=? ORDER BY created_at ASC`)
      .all(steamId, steamId);
  } else {
    msgs = (readFallback().messages || [])
      .filter(m => m.sender_steam_id === steamId || m.recipient_steam_id === steamId)
      .sort((x, y) => (x.created_at || '').localeCompare(y.created_at || ''));
  }
  const convos = {};
  for (const m of msgs) {
    const other = m.sender_steam_id === steamId ? m.recipient_steam_id : m.sender_steam_id;
    if (eitherBlocked(steamId, other)) continue;
    if (!convos[other]) convos[other] = { steam_id: other, last: null, unread: 0 };
    convos[other].last = m; // since ordered asc, ends on newest
    if (m.recipient_steam_id === steamId && !m.read_at) convos[other].unread += 1;
  }
  return Object.values(convos).sort((a, b) => (b.last?.created_at || '').localeCompare(a.last?.created_at || ''));
}

function countUnread(steamId) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT COUNT(*) AS c FROM messages WHERE recipient_steam_id=? AND read_at IS NULL`).get(steamId).c;
  }
  return (readFallback().messages || []).filter(m => m.recipient_steam_id === steamId && !m.read_at).length;
}

// ----- moderation: reports, bans, admin listings -----
function createReport({ reporter_steam_id, target_type, target_id, reason }) {
  const created_at = nowIso();
  if (useSqlite()) {
    const info = openSqlite().prepare(`INSERT INTO reports (reporter_steam_id, target_type, target_id, reason, status, created_at)
      VALUES (?,?,?,?, 'open', ?)`).run(reporter_steam_id, target_type, String(target_id), reason || null, created_at);
    return { id: Number(info.lastInsertRowid) };
  }
  const state = readFallback();
  if (!state.reports) state.reports = [];
  const id = (state.reports.reduce((m, r) => Math.max(m, r.id || 0), 0) || 0) + 1;
  state.reports.push({ id, reporter_steam_id, target_type, target_id: String(target_id), reason: reason || null, status: 'open', created_at, resolved_at: null, resolved_by: null });
  writeFallback(state);
  return { id };
}

function listReports(status = 'open') {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT 200`).all(status);
  }
  return (readFallback().reports || []).filter(r => r.status === status)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

function resolveReport(id, status, bySteamId) {
  const now = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(`UPDATE reports SET status=?, resolved_at=?, resolved_by=? WHERE id=?`)
      .run(status, now, bySteamId, id);
  } else {
    const state = readFallback();
    const r = (state.reports || []).find(x => x.id === Number(id));
    if (r) { r.status = status; r.resolved_at = now; r.resolved_by = bySteamId; writeFallback(state); }
  }
  return { ok: true };
}

function countOpenReports() {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT COUNT(*) AS c FROM reports WHERE status='open'`).get().c;
  }
  return (readFallback().reports || []).filter(r => r.status === 'open').length;
}

// Site bans
function banUser(steamId, reason, bySteamId) {
  const created_at = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(`INSERT INTO user_bans (steam_id, reason, banned_by, created_at) VALUES (?,?,?,?)
      ON CONFLICT(steam_id) DO UPDATE SET reason=excluded.reason, banned_by=excluded.banned_by, created_at=excluded.created_at`)
      .run(steamId, reason || null, bySteamId || null, created_at);
  } else {
    const state = readFallback();
    if (!state.user_bans) state.user_bans = {};
    state.user_bans[steamId] = { steam_id: steamId, reason: reason || null, banned_by: bySteamId || null, created_at };
    writeFallback(state);
  }
  return { ok: true };
}
function unbanUser(steamId) {
  if (useSqlite()) {
    openSqlite().prepare(`DELETE FROM user_bans WHERE steam_id=?`).run(steamId);
  } else {
    const state = readFallback();
    delete (state.user_bans || {})[steamId];
    writeFallback(state);
  }
  return { ok: true };
}
function isUserBanned(steamId) {
  if (useSqlite()) {
    return !!openSqlite().prepare(`SELECT 1 FROM user_bans WHERE steam_id=?`).get(steamId);
  }
  return !!(readFallback().user_bans || {})[steamId];
}
function listBans() {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM user_bans ORDER BY created_at DESC LIMIT 200`).all();
  }
  return Object.values(readFallback().user_bans || {}).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

// ----- moderators -----
function addModerator(steamId, bySteamId) {
  const created_at = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(`INSERT INTO moderators (steam_id, granted_by, created_at) VALUES (?,?,?)
      ON CONFLICT(steam_id) DO NOTHING`).run(steamId, bySteamId || null, created_at);
  } else {
    const state = readFallback();
    if (!state.moderators) state.moderators = {};
    state.moderators[steamId] = { steam_id: steamId, granted_by: bySteamId || null, created_at };
    writeFallback(state);
  }
  return { ok: true };
}
function removeModerator(steamId) {
  if (useSqlite()) {
    openSqlite().prepare(`DELETE FROM moderators WHERE steam_id=?`).run(steamId);
  } else {
    const state = readFallback();
    delete (state.moderators || {})[steamId];
    writeFallback(state);
  }
  return { ok: true };
}
function isModerator(steamId) {
  if (!steamId) return false;
  if (useSqlite()) {
    return !!openSqlite().prepare(`SELECT 1 FROM moderators WHERE steam_id=?`).get(steamId);
  }
  return !!(readFallback().moderators || {})[steamId];
}
function listModerators() {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM moderators ORDER BY created_at DESC`).all();
  }
  return Object.values(readFallback().moderators || {}).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

// ----- custom roles ("Команда SOKOLENOK") -----
function createRole({ name, color, sort_order }) {
  const created_at = nowIso();
  const safeColor = String(color || 'green').slice(0, 16);
  const safeName = String(name || '').trim().slice(0, 32);
  const order = Number(sort_order) || 0;
  if (useSqlite()) {
    const info = openSqlite().prepare(
      `INSERT INTO roles (name, color, sort_order, created_at) VALUES (?,?,?,?)`
    ).run(safeName, safeColor, order, created_at);
    return { id: Number(info.lastInsertRowid), name: safeName, color: safeColor, sort_order: order, created_at };
  }
  const state = readFallback();
  if (!state.roles) state.roles = [];
  const id = (state.roles.reduce((m, r) => Math.max(m, r.id || 0), 0) || 0) + 1;
  const row = { id, name: safeName, color: safeColor, sort_order: order, created_at };
  state.roles.push(row);
  writeFallback(state);
  return row;
}

function updateRole(id, { name, color, sort_order }) {
  if (useSqlite()) {
    const cur = openSqlite().prepare(`SELECT * FROM roles WHERE id=?`).get(Number(id));
    if (!cur) return { error: 'not-found' };
    const next = {
      name: name !== undefined ? String(name).trim().slice(0, 32) : cur.name,
      color: color !== undefined ? String(color).slice(0, 16) : cur.color,
      sort_order: sort_order !== undefined ? Number(sort_order) || 0 : cur.sort_order
    };
    openSqlite().prepare(`UPDATE roles SET name=?, color=?, sort_order=? WHERE id=?`)
      .run(next.name, next.color, next.sort_order, Number(id));
    return { ok: true };
  }
  const state = readFallback();
  const r = (state.roles || []).find(x => x.id === Number(id));
  if (!r) return { error: 'not-found' };
  if (name !== undefined) r.name = String(name).trim().slice(0, 32);
  if (color !== undefined) r.color = String(color).slice(0, 16);
  if (sort_order !== undefined) r.sort_order = Number(sort_order) || 0;
  writeFallback(state);
  return { ok: true };
}

function deleteRole(id) {
  if (useSqlite()) {
    const d = openSqlite();
    d.prepare(`DELETE FROM roles WHERE id=?`).run(Number(id));
    d.prepare(`DELETE FROM role_members WHERE role_id=?`).run(Number(id));
  } else {
    const state = readFallback();
    state.roles = (state.roles || []).filter(r => r.id !== Number(id));
    for (const k of Object.keys(state.role_members || {})) {
      if (k.startsWith(id + ':')) delete state.role_members[k];
    }
    writeFallback(state);
  }
  return { ok: true };
}

function listRoles() {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM roles ORDER BY sort_order ASC, id ASC`).all();
  }
  return (readFallback().roles || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
}

function getRole(id) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM roles WHERE id=?`).get(Number(id)) || null;
  }
  return (readFallback().roles || []).find(r => r.id === Number(id)) || null;
}

function addRoleMember(roleId, steamId, bySteamId) {
  const created_at = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(
      `INSERT INTO role_members (role_id, steam_id, added_by, created_at) VALUES (?,?,?,?)
       ON CONFLICT(role_id, steam_id) DO NOTHING`
    ).run(Number(roleId), steamId, bySteamId || null, created_at);
  } else {
    const state = readFallback();
    if (!state.role_members) state.role_members = {};
    state.role_members[`${roleId}:${steamId}`] = { role_id: Number(roleId), steam_id: steamId, added_by: bySteamId || null, created_at };
    writeFallback(state);
  }
  return { ok: true };
}

function removeRoleMember(roleId, steamId) {
  if (useSqlite()) {
    openSqlite().prepare(`DELETE FROM role_members WHERE role_id=? AND steam_id=?`).run(Number(roleId), steamId);
  } else {
    const state = readFallback();
    delete (state.role_members || {})[`${roleId}:${steamId}`];
    writeFallback(state);
  }
  return { ok: true };
}

function listRoleMembers(roleId) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM role_members WHERE role_id=? ORDER BY created_at ASC`).all(Number(roleId));
  }
  return Object.values(readFallback().role_members || {})
    .filter(m => m.role_id === Number(roleId))
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
}

// Resolve the (first/primary) role for a given user.
// Returns { id, name, color } or null. Lowest sort_order wins.
function getUserRole(steamId) {
  if (!steamId) return null;
  if (useSqlite()) {
    return openSqlite().prepare(
      `SELECT r.id, r.name, r.color FROM role_members rm
       JOIN roles r ON r.id = rm.role_id
       WHERE rm.steam_id = ?
       ORDER BY r.sort_order ASC, r.id ASC LIMIT 1`
    ).get(steamId) || null;
  }
  const state = readFallback();
  const roleIds = Object.values(state.role_members || {})
    .filter(m => m.steam_id === steamId)
    .map(m => m.role_id);
  if (!roleIds.length) return null;
  const roles = (state.roles || []).filter(r => roleIds.includes(r.id))
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
  if (!roles[0]) return null;
  return { id: roles[0].id, name: roles[0].name, color: roles[0].color };
}

// Attach role info to an array of objects with a steam_id field (e.g., comments, messages)
function attachRoles(rows, sidField = 'steam_id') {
  if (!rows?.length) return rows;
  const ids = Array.from(new Set(rows.map(r => r[sidField]).filter(Boolean)));
  const map = {};
  for (const id of ids) {
    const r = getUserRole(id);
    if (r) map[id] = r;
  }
  for (const row of rows) {
    if (map[row[sidField]]) row.role = map[row[sidField]];
  }
  return rows;
}

// ----- public editors (co-owners) -----
function addPublicEditor(publicId, steamId, bySteamId) {
  const created_at = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(`INSERT INTO public_editors (public_id, steam_id, added_by, created_at) VALUES (?,?,?,?)
      ON CONFLICT(public_id, steam_id) DO NOTHING`).run(publicId, steamId, bySteamId || null, created_at);
  } else {
    const state = readFallback();
    if (!state.public_editors) state.public_editors = {};
    state.public_editors[`${publicId}:${steamId}`] = { public_id: publicId, steam_id: steamId, added_by: bySteamId || null, created_at };
    writeFallback(state);
  }
  return { ok: true };
}
function removePublicEditor(publicId, steamId) {
  if (useSqlite()) {
    openSqlite().prepare(`DELETE FROM public_editors WHERE public_id=? AND steam_id=?`).run(publicId, steamId);
  } else {
    const state = readFallback();
    delete (state.public_editors || {})[`${publicId}:${steamId}`];
    writeFallback(state);
  }
  return { ok: true };
}
function listPublicEditors(publicId) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT steam_id, created_at FROM public_editors WHERE public_id=?`).all(publicId);
  }
  return Object.values(readFallback().public_editors || {})
    .filter(e => e.public_id === publicId)
    .map(e => ({ steam_id: e.steam_id, created_at: e.created_at }));
}
function isPublicEditor(publicId, steamId) {
  if (!steamId) return false;
  if (useSqlite()) {
    return !!openSqlite().prepare(`SELECT 1 FROM public_editors WHERE public_id=? AND steam_id=?`).get(publicId, steamId);
  }
  return !!(readFallback().public_editors || {})[`${publicId}:${steamId}`];
}

// Edit an existing post — only title/body/image/link can change, author/public are immutable
function updatePost(id, patch = {}) {
  const edited_at = nowIso();
  // Normalize images patch
  let imagesPatch = undefined; // undefined = no change; null = clear; array = set
  if (patch.images !== undefined) {
    if (Array.isArray(patch.images) && patch.images.length) {
      imagesPatch = patch.images.filter(Boolean).slice(0, 6);
    } else {
      imagesPatch = null;
    }
  } else if (patch.image !== undefined) {
    imagesPatch = patch.image ? [patch.image] : null;
  }
  if (useSqlite()) {
    const cur = openSqlite().prepare(`SELECT * FROM posts WHERE id=?`).get(Number(id));
    if (!cur) return { error: 'not-found' };
    const next = {
      title: patch.title !== undefined ? (String(patch.title || '').trim().slice(0, 200) || null) : cur.title,
      body: patch.body !== undefined ? (String(patch.body || '').trim().slice(0, 8000) || cur.body) : cur.body,
      link: patch.link !== undefined ? (String(patch.link || '').trim().slice(0, 500) || null) : cur.link,
      image: imagesPatch === undefined ? cur.image : (imagesPatch ? imagesPatch[0] : null),
      images_json: imagesPatch === undefined ? cur.images_json
        : (imagesPatch && imagesPatch.length > 1 ? JSON.stringify(imagesPatch) : null)
    };
    openSqlite().prepare(`UPDATE posts SET title=?, body=?, link=?, image=?, images_json=?, edited_at=? WHERE id=?`)
      .run(next.title, next.body, next.link, next.image, next.images_json, edited_at, Number(id));
    return { ok: true, edited_at };
  }
  const state = readFallback();
  const p = (state.posts || []).find(x => x.id === Number(id));
  if (!p) return { error: 'not-found' };
  if (patch.title !== undefined) p.title = String(patch.title || '').trim().slice(0, 200) || null;
  if (patch.body !== undefined) p.body = String(patch.body || '').trim().slice(0, 8000) || p.body;
  if (patch.link !== undefined) p.link = String(patch.link || '').trim().slice(0, 500) || null;
  if (imagesPatch !== undefined) {
    p.image = imagesPatch ? imagesPatch[0] : null;
    p.images_json = (imagesPatch && imagesPatch.length > 1) ? JSON.stringify(imagesPatch) : null;
  }
  p.edited_at = edited_at;
  writeFallback(state);
  return { ok: true, edited_at };
}

// Polls (stored as JSON on the post row): { question, options: [{text, votes: [steamId]}] }
function setPostPoll(id, poll) {
  const json = poll ? JSON.stringify(poll) : null;
  if (useSqlite()) {
    openSqlite().prepare(`UPDATE posts SET poll_json=? WHERE id=?`).run(json, Number(id));
  } else {
    const state = readFallback();
    const p = (state.posts || []).find(x => x.id === Number(id));
    if (p) { p.poll_json = json; writeFallback(state); }
  }
  return { ok: true };
}

function getPostPoll(id) {
  let row = null;
  if (useSqlite()) row = openSqlite().prepare(`SELECT poll_json FROM posts WHERE id=?`).get(Number(id));
  else row = (readFallback().posts || []).find(x => x.id === Number(id));
  if (!row?.poll_json) return null;
  try { return JSON.parse(row.poll_json); } catch (_) { return null; }
}

// Toggle a vote (one option per user; second vote on same option removes it)
function voteOnPoll(postId, steamId, optionIdx) {
  const poll = getPostPoll(postId);
  if (!poll || !Array.isArray(poll.options) || !poll.options[optionIdx]) return { error: 'bad-option' };
  // Remove this user from all options first (single-choice)
  for (const opt of poll.options) {
    opt.votes = (opt.votes || []).filter(s => s !== steamId);
  }
  // Add to chosen option
  poll.options[optionIdx].votes = poll.options[optionIdx].votes || [];
  poll.options[optionIdx].votes.push(steamId);
  setPostPoll(postId, poll);
  return { ok: true, poll };
}

// Message reactions (stored as JSON on message row): { "👍": [sid, sid], "❤️": [sid] }
function getMessageReactions(id) {
  let row = null;
  if (useSqlite()) row = openSqlite().prepare(`SELECT reactions_json FROM messages WHERE id=?`).get(Number(id));
  else row = (readFallback().messages || []).find(x => x.id === Number(id));
  if (!row?.reactions_json) return {};
  try { return JSON.parse(row.reactions_json) || {}; } catch (_) { return {}; }
}

function toggleMessageReaction(messageId, steamId, emoji) {
  const reactions = getMessageReactions(messageId);
  const list = reactions[emoji] || [];
  const idx = list.indexOf(steamId);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(steamId);
  if (list.length === 0) delete reactions[emoji];
  else reactions[emoji] = list;
  const json = Object.keys(reactions).length ? JSON.stringify(reactions) : null;
  if (useSqlite()) {
    openSqlite().prepare(`UPDATE messages SET reactions_json=? WHERE id=?`).run(json, Number(messageId));
  } else {
    const state = readFallback();
    const m = (state.messages || []).find(x => x.id === Number(messageId));
    if (m) { m.reactions_json = json; writeFallback(state); }
  }
  return { ok: true, reactions };
}

// Pin / unpin a post. One pinned post per public (newer pin replaces the old one).
function pinPost(publicId, postId) {
  const now = nowIso();
  if (useSqlite()) {
    const d = openSqlite();
    // Unpin any currently-pinned post in this public
    d.prepare(`UPDATE posts SET pinned_at = NULL WHERE public_id = ? AND pinned_at IS NOT NULL`).run(publicId);
    d.prepare(`UPDATE posts SET pinned_at = ? WHERE id = ?`).run(now, Number(postId));
  } else {
    const state = readFallback();
    for (const p of (state.posts || [])) {
      if (p.public_id === publicId && p.pinned_at) p.pinned_at = null;
      if (p.id === Number(postId)) p.pinned_at = now;
    }
    writeFallback(state);
  }
  return { ok: true };
}

function unpinPost(postId) {
  if (useSqlite()) {
    openSqlite().prepare(`UPDATE posts SET pinned_at = NULL WHERE id = ?`).run(Number(postId));
  } else {
    const state = readFallback();
    for (const p of (state.posts || [])) if (p.id === Number(postId)) p.pinned_at = null;
    writeFallback(state);
  }
  return { ok: true };
}

// Soft-delete a single message — text becomes "(удалено)" but row remains so the conversation thread doesn't lose its order
function softDeleteMessage(messageId) {
  const now = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(`UPDATE messages SET deleted_at = ? WHERE id = ?`).run(now, Number(messageId));
  } else {
    const state = readFallback();
    const m = (state.messages || []).find(x => x.id === Number(messageId));
    if (m) { m.deleted_at = now; writeFallback(state); }
  }
  return { ok: true };
}

// Content deletion (admin)
function deletePost(id) {
  if (useSqlite()) {
    const d = openSqlite();
    d.prepare(`DELETE FROM posts WHERE id=?`).run(id);
    d.prepare(`DELETE FROM post_likes WHERE post_id=?`).run(Number(id));
    d.prepare(`DELETE FROM post_views WHERE post_id=?`).run(Number(id));
    d.prepare(`DELETE FROM post_comments WHERE post_id=?`).run(Number(id));
  } else {
    const state = readFallback();
    state.posts = (state.posts || []).filter(p => p.id !== Number(id));
    for (const k of Object.keys(state.post_likes || {})) if (k.startsWith(id + ':')) delete state.post_likes[k];
    for (const k of Object.keys(state.post_views || {})) if (k.startsWith(id + ':')) delete state.post_views[k];
    state.post_comments = (state.post_comments || []).filter(c => c.post_id !== Number(id));
    writeFallback(state);
  }
  return { ok: true };
}
function deletePublic(id) {
  if (useSqlite()) {
    const d = openSqlite();
    d.prepare(`DELETE FROM publics WHERE id=?`).run(id);
    d.prepare(`DELETE FROM posts WHERE public_id=?`).run(id);
    d.prepare(`DELETE FROM subscriptions WHERE public_id=?`).run(id);
    d.prepare(`DELETE FROM public_editors WHERE public_id=?`).run(id);
  } else {
    const state = readFallback();
    delete (state.publics || {})[id];
    state.posts = (state.posts || []).filter(p => p.public_id !== id);
    for (const k of Object.keys(state.subscriptions || {})) if (k.endsWith(':' + id)) delete state.subscriptions[k];
    for (const k of Object.keys(state.public_editors || {})) if (k.startsWith(id + ':')) delete state.public_editors[k];
    writeFallback(state);
  }
  return { ok: true };
}
function setPublicVerified(id, verified) {
  if (useSqlite()) {
    openSqlite().prepare(`UPDATE publics SET verified=? WHERE id=?`).run(verified ? 1 : 0, id);
  } else {
    const state = readFallback();
    if ((state.publics || {})[id]) { state.publics[id].verified = verified ? 1 : 0; writeFallback(state); }
  }
  return { ok: true };
}

// Admin dashboard stats
function adminStats() {
  if (useSqlite()) {
    const d = openSqlite();
    const one = (sql) => d.prepare(sql).get().c;
    return {
      users: one(`SELECT COUNT(*) AS c FROM users`),
      publics: one(`SELECT COUNT(*) AS c FROM publics`),
      posts: one(`SELECT COUNT(*) AS c FROM posts`),
      messages: one(`SELECT COUNT(*) AS c FROM messages`),
      reputations: one(`SELECT COUNT(*) AS c FROM reputation`),
      open_reports: one(`SELECT COUNT(*) AS c FROM reports WHERE status='open'`),
      bans: one(`SELECT COUNT(*) AS c FROM user_bans`)
    };
  }
  const s = readFallback();
  return {
    users: Object.keys(s.users || {}).length,
    publics: Object.keys(s.publics || {}).length,
    posts: (s.posts || []).length,
    messages: (s.messages || []).length,
    reputations: Object.keys(s.reputation || {}).length,
    open_reports: (s.reports || []).filter(r => r.status === 'open').length,
    bans: Object.keys(s.user_bans || {}).length
  };
}

// ----- events (lightweight log) -----
// Notifications — created when someone interacts with the user's content.
// Self-notifications (actor === recipient) are silently dropped.
function createNotification({ recipient, actor, kind, data }) {
  if (!recipient || recipient === actor) return null; // never notify yourself
  const created_at = nowIso();
  const json = data ? JSON.stringify(data) : null;
  if (useSqlite()) {
    // De-dupe: same (recipient, actor, kind, data_json) within last 30 seconds → ignore (prevents spam)
    const since = new Date(Date.now() - 30000).toISOString();
    const dup = openSqlite().prepare(
      `SELECT id FROM notifications
       WHERE recipient_steam_id = ? AND actor_steam_id = ? AND kind = ?
       AND IFNULL(data_json,'') = IFNULL(?,'') AND created_at > ?`
    ).get(recipient, actor || null, kind, json, since);
    if (dup) return null;
    const info = openSqlite().prepare(
      `INSERT INTO notifications (recipient_steam_id, actor_steam_id, kind, data_json, created_at) VALUES (?,?,?,?,?)`
    ).run(recipient, actor || null, kind, json, created_at);
    return { id: Number(info.lastInsertRowid), created_at };
  }
  const state = readFallback();
  if (!state.notifications) state.notifications = [];
  // De-dupe (same logic)
  const cutoff = Date.now() - 30000;
  const dup = state.notifications.find(n =>
    n.recipient_steam_id === recipient && n.actor_steam_id === actor &&
    n.kind === kind && (n.data_json || '') === (json || '') &&
    Date.parse(n.created_at) > cutoff);
  if (dup) return null;
  const id = (state.notifications.reduce((m, n) => Math.max(m, n.id || 0), 0) || 0) + 1;
  state.notifications.push({ id, recipient_steam_id: recipient, actor_steam_id: actor,
    kind, data_json: json, created_at, read_at: null });
  writeFallback(state);
  return { id, created_at };
}

function listNotifications(recipient, limit = 50) {
  if (useSqlite()) {
    return openSqlite().prepare(
      `SELECT * FROM notifications WHERE recipient_steam_id = ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(recipient, limit);
  }
  return (readFallback().notifications || [])
    .filter(n => n.recipient_steam_id === recipient)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, limit);
}

function countUnreadNotifications(recipient) {
  if (useSqlite()) {
    const r = openSqlite().prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE recipient_steam_id = ? AND read_at IS NULL`
    ).get(recipient);
    return r?.n || 0;
  }
  return (readFallback().notifications || [])
    .filter(n => n.recipient_steam_id === recipient && !n.read_at).length;
}

function markNotificationsRead(recipient) {
  const now = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(
      `UPDATE notifications SET read_at = ? WHERE recipient_steam_id = ? AND read_at IS NULL`
    ).run(now, recipient);
  } else {
    const state = readFallback();
    for (const n of (state.notifications || [])) {
      if (n.recipient_steam_id === recipient && !n.read_at) n.read_at = now;
    }
    writeFallback(state);
  }
  return { ok: true };
}

function logEvent(kind, steamId = null, data = null) {
  if (useSqlite()) {
    openSqlite().prepare(`INSERT INTO events (ts, kind, steam_id, data_json) VALUES (?,?,?,?)`)
      .run(nowIso(), kind, steamId, data == null ? null : JSON.stringify(data));
  } else {
    const state = readFallback();
    state.events.push({ ts: nowIso(), kind, steam_id: steamId, data_json: data == null ? null : JSON.stringify(data) });
    if (state.events.length > 2000) state.events = state.events.slice(-2000);
    writeFallback(state);
  }
}

function analyticsReport(days = 30) {
  const safeDays = Math.min(365, Math.max(1, Number(days) || 30));
  const since = new Date(Date.now() - safeDays * 86400000).toISOString();
  let rows;
  if (useSqlite()) {
    rows = openSqlite().prepare(`SELECT ts, kind, steam_id, data_json FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT 20000`).all(since);
  } else {
    rows = (readFallback().events || []).filter(e => e.ts >= since).slice(-20000).reverse();
  }
  const tracked = ['page_view','lookup_started','lookup_success','inventory_value_shown','steam_login_clicked','steam_login_success','profile_shared','watchlist_added','onboarding_complete','register'];
  const totals = Object.fromEntries(tracked.map(k => [k, 0]));
  const sources = {};
  const daily = {};
  for (const row of rows) {
    let data = {}; try { data = JSON.parse(row.data_json || '{}') || {}; } catch (_) {}
    if (totals[row.kind] != null) totals[row.kind]++;
    const day = String(row.ts || '').slice(0, 10);
    if (!daily[day]) daily[day] = { page_view: 0, lookup_success: 0, steam_login_success: 0, profile_shared: 0 };
    if (daily[day][row.kind] != null) daily[day][row.kind]++;
    const utm = data.utm || {};
    const source = String(utm.source || data.referrer || 'direct').slice(0, 60) || 'direct';
    if (!sources[source]) sources[source] = { source, visits: 0, lookups: 0, logins: 0, shares: 0 };
    if (row.kind === 'page_view') sources[source].visits++;
    if (row.kind === 'lookup_success') sources[source].lookups++;
    if (row.kind === 'steam_login_success' || row.kind === 'register') sources[source].logins++;
    if (row.kind === 'profile_shared') sources[source].shares++;
  }
  return { days: safeDays, since, totals, sources: Object.values(sources).sort((a,b) => b.lookups - a.lookups || b.visits - a.visits).slice(0, 30), daily: Object.entries(daily).sort((a,b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, ...value })) };
}

function storageHealth() {
  const backend = useSqlite() ? 'sqlite' : 'json-fallback';
  let counts = {};
  try {
    if (useSqlite()) {
      const d = openSqlite();
      for (const t of ['users','sessions','inventory_snapshots','prices','watchlist','user_settings','events']) {
        counts[t] = d.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c;
      }
    } else {
      const s = readFallback();
      counts = {
        users: Object.keys(s.users).length,
        sessions: Object.keys(s.sessions).length,
        inventory_snapshots: s.inventory_snapshots.length,
        prices: Object.keys(s.prices).length,
        watchlist: Object.keys(s.watchlist).length,
        user_settings: Object.keys(s.user_settings).length,
        events: s.events.length
      };
    }
  } catch (e) { counts.error = String(e); }
  return { backend, counts, sqlite_file: SQLITE_FILE, json_file: JSON_FILE };
}

// ----- push subscriptions (Web Push) -----
function savePushSubscription({ endpoint, steam_id, p256dh, auth, user_agent }) {
  if (!endpoint || !steam_id || !p256dh || !auth) return null;
  const created_at = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(
      `INSERT INTO push_subscriptions (endpoint, steam_id, p256dh, auth, user_agent, created_at, last_used_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET
         steam_id=excluded.steam_id, p256dh=excluded.p256dh, auth=excluded.auth,
         user_agent=excluded.user_agent, last_used_at=excluded.last_used_at`
    ).run(endpoint, steam_id, p256dh, auth, user_agent || null, created_at, created_at);
    return { endpoint };
  }
  const state = readFallback();
  if (!state.push_subscriptions) state.push_subscriptions = {};
  state.push_subscriptions[endpoint] = { endpoint, steam_id, p256dh, auth, user_agent, created_at, last_used_at: created_at };
  writeFallback(state);
  return { endpoint };
}

function deletePushSubscription(endpoint) {
  if (!endpoint) return false;
  if (useSqlite()) {
    const r = openSqlite().prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
    return r.changes > 0;
  }
  const state = readFallback();
  if (!state.push_subscriptions || !state.push_subscriptions[endpoint]) return false;
  delete state.push_subscriptions[endpoint];
  writeFallback(state);
  return true;
}

function listPushSubscriptions(steamId) {
  if (!steamId) return [];
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM push_subscriptions WHERE steam_id = ?`).all(steamId);
  }
  const state = readFallback();
  return Object.values(state.push_subscriptions || {}).filter(s => s.steam_id === steamId);
}

function touchPushSubscription(endpoint) {
  if (!endpoint) return;
  const at = nowIso();
  if (useSqlite()) {
    try { openSqlite().prepare(`UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?`).run(at, endpoint); } catch (_) {}
    return;
  }
  const state = readFallback();
  if (state.push_subscriptions?.[endpoint]) {
    state.push_subscriptions[endpoint].last_used_at = at;
    writeFallback(state);
  }
}

// ----- auth_methods (external login identities) -----
// Find which internal user is bound to a given (provider, external_id).
// Returns the matching auth_methods row or null.
function findAuthMethod(provider, externalId) {
  if (!provider || !externalId) return null;
  if (useSqlite()) {
    return openSqlite().prepare(
      'SELECT * FROM auth_methods WHERE provider = ? AND external_id = ?'
    ).get(String(provider), String(externalId)) || null;
  }
  const state = readFallback();
  return (Object.values(state.auth_methods || {})).find(a =>
    a.provider === provider && a.external_id === String(externalId)) || null;
}

// Insert a new auth method, or refresh the cached profile info if it already
// exists. Returns the row (always present after the call).
function upsertAuthMethod({ steam_id, provider, external_id, external_username, external_name, external_avatar, verified }) {
  if (!steam_id || !provider || !external_id) return null;
  const now = nowIso();
  if (useSqlite()) {
    const db = openSqlite();
    const existing = db.prepare(
      'SELECT * FROM auth_methods WHERE provider = ? AND external_id = ?'
    ).get(String(provider), String(external_id));
    if (existing) {
      db.prepare(
        `UPDATE auth_methods SET external_username = ?, external_name = ?, external_avatar = ?, last_login_at = ? WHERE id = ?`
      ).run(external_username || null, external_name || null, external_avatar || null, now, existing.id);
      return db.prepare('SELECT * FROM auth_methods WHERE id = ?').get(existing.id);
    }
    db.prepare(
      `INSERT INTO auth_methods (steam_id, provider, external_id, external_username, external_name, external_avatar, verified, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(steam_id, String(provider), String(external_id), external_username || null, external_name || null,
          external_avatar || null, verified ? 1 : 0, now, now);
    return db.prepare('SELECT * FROM auth_methods WHERE provider = ? AND external_id = ?')
      .get(String(provider), String(external_id));
  }
  const state = readFallback();
  if (!state.auth_methods) state.auth_methods = {};
  const key = `${provider}:${external_id}`;
  const row = state.auth_methods[key] || { id: Object.keys(state.auth_methods).length + 1, created_at: now };
  Object.assign(row, { steam_id, provider, external_id: String(external_id), external_username, external_name, external_avatar, verified: verified ? 1 : 0, last_login_at: now });
  state.auth_methods[key] = row;
  writeFallback(state);
  return row;
}

// List all auth methods bound to a user — used in /settings to show "Steam + Telegram".
function listAuthMethods(steamId) {
  if (!steamId) return [];
  if (useSqlite()) {
    return openSqlite().prepare('SELECT * FROM auth_methods WHERE steam_id = ? ORDER BY created_at').all(steamId);
  }
  const state = readFallback();
  return Object.values(state.auth_methods || {}).filter(a => a.steam_id === steamId);
}

// Unbind a specific provider from a user (e.g. user removes Telegram).
// Refuses to remove the last method to avoid orphan accounts.
function removeAuthMethod(steamId, provider) {
  if (!steamId || !provider) return false;
  const all = listAuthMethods(steamId);
  const remaining = all.filter(a => a.provider !== provider);
  if (remaining.length === 0) return false; // would lock user out
  if (useSqlite()) {
    const r = openSqlite().prepare('DELETE FROM auth_methods WHERE steam_id = ? AND provider = ?')
      .run(steamId, String(provider));
    return r.changes > 0;
  }
  const state = readFallback();
  if (!state.auth_methods) return false;
  let changed = false;
  for (const key of Object.keys(state.auth_methods)) {
    const r = state.auth_methods[key];
    if (r.steam_id === steamId && r.provider === provider) {
      delete state.auth_methods[key];
      changed = true;
    }
  }
  if (changed) writeFallback(state);
  return changed;
}

module.exports = {
  // common
  nowIso, uuid,
  // users
  upsertUser, getUser, searchUsers, searchPosts, searchPublics, touchLastSeen, getLastSeen,
  // sessions
  createSession, getSession, deleteSession,
  // auth methods (multi-provider login)
  findAuthMethod, upsertAuthMethod, listAuthMethods, removeAuthMethod,
  // inventory
  saveInventorySnapshot, listInventorySnapshots, latestInventorySnapshot,
  getInventoryCache, setInventoryCache,
  // prices
  setPrice, getPrice, getPriceHistory,
  // watchlist
  listWatchlist, addWatch, removeWatch,
  // settings
  getSettings, setSettings,
  // reputation
  castReputation, removeReputation, getReputationFor, getReputationVote,
  countRecentVotes, aggregateReputation, REP_CATEGORIES,
  // feed
  listPublics, getPublic, createPublic, updatePublic, countPublicsByOwner,
  createPost, getPost, updatePost, listPosts, listPostsByAuthor, listCommentsByAuthor, pinPost, unpinPost,
  softDeleteMessage,
  setPostPoll, getPostPoll, voteOnPoll,
  getMessageReactions, toggleMessageReaction,
  likePost, unlikePost, hasLiked, countLikes,
  viewPost, countViews, attachPostStats,
  addComment, deleteComment, getComment, listComments, countComments,
  recommendFriends,
  listSubscriptions, countSubscribers, getPublicStats, subscribe, unsubscribe,
  // friends / blocks
  friendStatus, sendFriendRequest, acceptFriendRequest, removeFriend,
  listFriends, areFriends, blockUser, unblockUser, listBlocks, isBlocked, eitherBlocked,
  // messages
  insertMessage, getMessage, listMessages, markRead, listConversations, countUnread,
  // moderation
  createReport, listReports, resolveReport, countOpenReports,
  banUser, unbanUser, isUserBanned, listBans,
  addModerator, removeModerator, isModerator, listModerators,
  createRole, updateRole, deleteRole, listRoles, getRole,
  addRoleMember, removeRoleMember, listRoleMembers, getUserRole, attachRoles,
  addPublicEditor, removePublicEditor, listPublicEditors, isPublicEditor,
  deletePost, deletePublic, setPublicVerified, adminStats,
  // events
  createNotification, listNotifications, countUnreadNotifications, markNotificationsRead,
  // push subscriptions
  savePushSubscription, deletePushSubscription, listPushSubscriptions, touchPushSubscription,
  logEvent, analyticsReport, storageHealth
};
