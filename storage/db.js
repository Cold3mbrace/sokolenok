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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  steam_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

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
    telegram_id: null, faceit_nickname: null, consent_at: null, updated_at: null };
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT * FROM user_settings WHERE steam_id = ?`).get(steamId)
      || empty;
  }
  return readFallback().user_settings[steamId] || empty;
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
    updated_at: nowIso()
  };
  if (useSqlite()) {
    openSqlite().prepare(`INSERT INTO user_settings (steam_id, currency, language, telegram_id, faceit_nickname, consent_at, updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(steam_id) DO UPDATE SET
        currency = excluded.currency,
        language = excluded.language,
        telegram_id = excluded.telegram_id,
        faceit_nickname = excluded.faceit_nickname,
        consent_at = excluded.consent_at,
        updated_at = excluded.updated_at`)
      .run(next.steam_id, next.currency, next.language, next.telegram_id, next.faceit_nickname, next.consent_at, next.updated_at);
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

function createPost({ public_id, author_steam_id, title, body, link, image }) {
  const created_at = nowIso();
  if (useSqlite()) {
    const info = openSqlite().prepare(`INSERT INTO posts (public_id, author_steam_id, title, body, link, image, created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(public_id, author_steam_id, title || null, body, link || null, image || null, created_at);
    return { id: Number(info.lastInsertRowid), public_id, author_steam_id, title, body, link, image, created_at };
  }
  const state = readFallback();
  if (!state.posts) state.posts = [];
  const id = (state.posts.reduce((m, p) => Math.max(m, p.id || 0), 0) || 0) + 1;
  const row = { id, public_id, author_steam_id, title: title || null, body, link: link || null, image: image || null, created_at };
  state.posts.push(row);
  writeFallback(state);
  return row;
}

// Posts from a set of public_ids (for a personalized feed), newest first
function listPosts({ publicIds = null, limit = 50 } = {}) {
  if (useSqlite()) {
    const d = openSqlite();
    if (publicIds && publicIds.length) {
      const ph = publicIds.map(() => '?').join(',');
      return d.prepare(`SELECT * FROM posts WHERE public_id IN (${ph}) ORDER BY created_at DESC LIMIT ?`)
        .all(...publicIds, limit);
    }
    return d.prepare(`SELECT * FROM posts ORDER BY created_at DESC LIMIT ?`).all(limit);
  }
  let rows = (readFallback().posts || []).slice();
  if (publicIds && publicIds.length) rows = rows.filter(p => publicIds.includes(p.public_id));
  rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return rows.slice(0, limit);
}

function listSubscriptions(steamId) {
  if (useSqlite()) {
    return openSqlite().prepare(`SELECT public_id FROM subscriptions WHERE steam_id = ?`).all(steamId).map(r => r.public_id);
  }
  return Object.values(readFallback().subscriptions || {})
    .filter(s => s.steam_id === steamId).map(s => s.public_id);
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
function insertMessage(sender, recipient, bodyEnc) {
  const created_at = nowIso();
  if (useSqlite()) {
    const info = openSqlite().prepare(`INSERT INTO messages (sender_steam_id, recipient_steam_id, body_enc, created_at)
      VALUES (?,?,?,?)`).run(sender, recipient, bodyEnc, created_at);
    return { id: Number(info.lastInsertRowid), created_at };
  }
  const state = readFallback();
  if (!state.messages) state.messages = [];
  const id = (state.messages.reduce((m, x) => Math.max(m, x.id || 0), 0) || 0) + 1;
  state.messages.push({ id, sender_steam_id: sender, recipient_steam_id: recipient, body_enc: bodyEnc, created_at, read_at: null });
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

// Mark messages from `other` to `me` as read
function markRead(me, other) {
  const now = nowIso();
  if (useSqlite()) {
    openSqlite().prepare(`UPDATE messages SET read_at=? WHERE recipient_steam_id=? AND sender_steam_id=? AND read_at IS NULL`)
      .run(now, me, other);
  } else {
    const state = readFallback();
    for (const m of state.messages || []) {
      if (m.recipient_steam_id === me && m.sender_steam_id === other && !m.read_at) m.read_at = now;
    }
    writeFallback(state);
  }
  return { ok: true };
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

// Content deletion (admin)
function deletePost(id) {
  if (useSqlite()) {
    openSqlite().prepare(`DELETE FROM posts WHERE id=?`).run(id);
  } else {
    const state = readFallback();
    state.posts = (state.posts || []).filter(p => p.id !== Number(id));
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
  } else {
    const state = readFallback();
    delete (state.publics || {})[id];
    state.posts = (state.posts || []).filter(p => p.public_id !== id);
    for (const k of Object.keys(state.subscriptions || {})) if (k.endsWith(':' + id)) delete state.subscriptions[k];
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

module.exports = {
  // common
  nowIso, uuid,
  // users
  upsertUser, getUser,
  // sessions
  createSession, getSession, deleteSession,
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
  createPost, getPost, listPosts,
  listSubscriptions, subscribe, unsubscribe,
  // friends / blocks
  friendStatus, sendFriendRequest, acceptFriendRequest, removeFriend,
  listFriends, areFriends, blockUser, unblockUser, listBlocks, isBlocked, eitherBlocked,
  // messages
  insertMessage, listMessages, markRead, listConversations, countUnread,
  // moderation
  createReport, listReports, resolveReport, countOpenReports,
  banUser, unbanUser, isUserBanned, listBans,
  deletePost, deletePublic, setPublicVerified, adminStats,
  // events
  logEvent, storageHealth
};
