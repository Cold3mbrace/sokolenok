// steam-bot.js
// SOKOLENOK / LUDIK Steam notification bot worker.
//
// Role of this worker is intentionally narrow:
// - log into a dedicated Steam bot account;
// - accept incoming friend requests;
// - keep a tiny local friend notification state;
// - respond only to service commands: help/status/stop/start;
// - later: read notification events and send them to Steam friends.
//
// It must NOT trade, ask user credentials, ask Steam API keys, cookies, or act as a profile search bot.

'use strict';

const fs = require('fs');
const path = require('path');

let SteamUser;
try {
  SteamUser = require('steam-user');
} catch (err) {
  console.error('[steam-bot] Missing dependency: steam-user');
  console.error('[steam-bot] Run: npm install');
  process.exit(1);
}

let SteamTotp = null;
try { SteamTotp = require('steam-totp'); } catch (_) { SteamTotp = null; }

const db = require('./storage/db');

const ROOT = __dirname;
const DATA_DIR = process.env.SOKOLENOK_DATA_DIR
  ? path.resolve(process.env.SOKOLENOK_DATA_DIR)
  : path.join(ROOT, '.data');
const STATE_FILE = path.join(DATA_DIR, 'steam-bot-state.json');

const USERNAME = process.env.STEAM_BOT_USERNAME || '';
const PASSWORD = process.env.STEAM_BOT_PASSWORD || '';
const SHARED_SECRET = process.env.STEAM_BOT_SHARED_SECRET || '';
const TWO_FACTOR_CODE = process.env.STEAM_BOT_2FA_CODE || '';
const BOT_DISPLAY_NAME = process.env.STEAM_BOT_DISPLAY_NAME || 'SOKOLENOK Bot';
const ACCEPT_FRIENDS = process.env.STEAM_BOT_ACCEPT_FRIENDS !== '0';
const POLL_EVENTS = process.env.STEAM_BOT_POLL_EVENTS === '1';
const EVENT_POLL_MS = Number(process.env.STEAM_BOT_EVENT_POLL_MS || 30000);

function nowIso() { return new Date().toISOString(); }
function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    console.warn('[steam-bot] Failed to read state, using fallback:', err.message);
    return fallback;
  }
}
function writeJsonAtomic(file, value) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function defaultState() {
  return {
    version: 1,
    bot: { started_at: nowIso(), display_name: BOT_DISPLAY_NAME },
    friends: {},
    counters: { accepted: 0, messages: 0, stops: 0, starts: 0 }
  };
}
function loadState() { return readJsonSafe(STATE_FILE, defaultState()); }
function saveState(state) { writeJsonAtomic(STATE_FILE, state); }
function asSteamIdString(steamID) {
  if (!steamID) return '';
  if (typeof steamID.getSteamID64 === 'function') return steamID.getSteamID64();
  return String(steamID);
}
function logEvent(kind, steamId, data) {
  try { db.logEvent(kind, steamId || null, data || null); }
  catch (err) { console.warn('[steam-bot] db.logEvent failed:', err.message); }
}
function buildTwoFactorCode() {
  if (TWO_FACTOR_CODE) return TWO_FACTOR_CODE;
  if (SHARED_SECRET && SteamTotp && typeof SteamTotp.generateAuthCode === 'function') {
    return SteamTotp.generateAuthCode(SHARED_SECRET);
  }
  return undefined;
}
function requireEnv() {
  const missing = [];
  if (!USERNAME) missing.push('STEAM_BOT_USERNAME');
  if (!PASSWORD) missing.push('STEAM_BOT_PASSWORD');
  if (missing.length) {
    console.error(`[steam-bot] Missing env: ${missing.join(', ')}`);
    console.error('[steam-bot] Example:');
    console.error('  STEAM_BOT_USERNAME=bot_login STEAM_BOT_PASSWORD=bot_password node steam-bot.js');
    process.exit(1);
  }
  if (SHARED_SECRET && !SteamTotp) {
    console.warn('[steam-bot] STEAM_BOT_SHARED_SECRET is set, but steam-totp is not installed. Run npm install.');
    console.warn('[steam-bot] Falling back to STEAM_BOT_2FA_CODE/manual Steam Guard flow if Steam asks for it.');
  }
}

function serviceHelp() {
  return [
    'SOKOLENOK Bot online.',
    '',
    'Я нужен только для уведомлений внутри Steam:',
    '• сильный сдвиг стоимости инвентаря;',
    '• важное обновление CS2;',
    '• готовый вывод статистики последнего матча.',
    '',
    'Команды:',
    'status — проверить, что бот живой',
    'help — показать это сообщение',
    'stop — выключить уведомления',
    'start — включить уведомления обратно',
    '',
    'Я не принимаю трейды и не прошу пароли, cookies или Steam API key.'
  ].join('\n');
}

function updateFriend(steamId, patch) {
  const state = loadState();
  const current = state.friends[steamId] || {
    steam_id: steamId,
    persona_name: null,
    friend_since: nowIso(),
    notifications_enabled: true,
    created_at: nowIso()
  };
  state.friends[steamId] = { ...current, ...patch, updated_at: nowIso() };
  saveState(state);
  return state.friends[steamId];
}
function setNotifications(steamId, enabled) {
  const friend = updateFriend(steamId, {
    notifications_enabled: Boolean(enabled),
    stopped_at: enabled ? null : nowIso(),
    started_at: enabled ? nowIso() : undefined
  });
  const state = loadState();
  if (enabled) state.counters.starts = (state.counters.starts || 0) + 1;
  else state.counters.stops = (state.counters.stops || 0) + 1;
  saveState(state);
  logEvent(enabled ? 'steam-bot-notifications-start' : 'steam-bot-notifications-stop', steamId, { enabled });
  return friend;
}

function formatEventMessage(event) {
  const type = event.type || event.kind || 'event';
  const title = event.title || 'SOKOLENOK notification';
  const body = event.body || event.message || '';
  const url = event.url || '';
  const lines = [`${title}`, body].filter(Boolean);
  if (type === 'inventory_shift') lines.unshift('Инвентарь заметно изменился');
  if (type === 'cs2_update') lines.unshift('Вышло важное обновление CS2');
  if (type === 'match_summary_ready') lines.unshift('Готов вывод статистики последнего матча');
  if (url) lines.push('', url);
  return lines.join('\n');
}

function startBot() {
  requireEnv();
  ensureDir();

  const client = new SteamUser({ enablePicsCache: false });

  client.on('loggedOn', (details) => {
    console.log('[steam-bot] Logged on:', details?.eresult || 'ok');
    try { client.setPersona(SteamUser.EPersonaState.Online, BOT_DISPLAY_NAME); } catch (_) {}
    try { client.gamesPlayed(['SOKOLENOK notifications']); } catch (_) {}
    logEvent('steam-bot-online', null, { username: USERNAME });
  });

  client.on('error', (err) => {
    console.error('[steam-bot] Steam error:', err && err.message ? err.message : err);
    logEvent('steam-bot-error', null, { message: err && err.message ? err.message : String(err) });
  });

  client.on('disconnected', (eresult, msg) => {
    console.warn('[steam-bot] Disconnected:', eresult, msg || '');
    logEvent('steam-bot-disconnected', null, { eresult, message: msg || null });
  });

  client.on('friendRelationship', (steamID, relationship) => {
    const steamId = asSteamIdString(steamID);
    console.log('[steam-bot] friendRelationship:', steamId, relationship);

    if (relationship === SteamUser.EFriendRelationship.RequestRecipient) {
      if (!ACCEPT_FRIENDS) {
        console.log('[steam-bot] Friend auto-accept disabled; ignoring request from', steamId);
        return;
      }
      try {
        client.addFriend(steamID);
        const friend = updateFriend(steamId, {
          friend_since: nowIso(),
          notifications_enabled: true,
          relationship: 'accepted'
        });
        const state = loadState();
        state.counters.accepted = (state.counters.accepted || 0) + 1;
        saveState(state);
        logEvent('steam-bot-friend-accepted', steamId, friend);
        setTimeout(() => {
          try { client.chatMessage(steamID, serviceHelp()); }
          catch (err) { console.warn('[steam-bot] welcome message failed:', err.message); }
        }, 1200);
      } catch (err) {
        console.error('[steam-bot] Failed to accept friend:', steamId, err.message);
        logEvent('steam-bot-friend-accept-error', steamId, { message: err.message });
      }
    }
  });

  client.on('friendMessage', (steamID, message) => {
    const steamId = asSteamIdString(steamID);
    const text = String(message || '').trim().toLowerCase();
    if (!text) return;

    const state = loadState();
    state.counters.messages = (state.counters.messages || 0) + 1;
    saveState(state);
    updateFriend(steamId, { last_message_at: nowIso() });

    console.log('[steam-bot] message:', steamId, text);

    try {
      if (['help', '!help', '/help', 'старт', 'start', '/start'].includes(text)) {
        client.chatMessage(steamID, serviceHelp());
        return;
      }
      if (['status', '!status', '/status', 'статус'].includes(text)) {
        const friend = updateFriend(steamId, { last_status_at: nowIso() });
        client.chatMessage(steamID,
          `SOKOLENOK Bot online.\nУведомления: ${friend.notifications_enabled === false ? 'выключены' : 'включены'}.`);
        return;
      }
      if (['stop', '!stop', '/stop', 'выкл', 'отключить'].includes(text)) {
        setNotifications(steamId, false);
        client.chatMessage(steamID, 'Уведомления выключены. Чтобы включить обратно, напишите start.');
        return;
      }
      if (['start', '!start', '/start', 'вкл', 'включить'].includes(text)) {
        setNotifications(steamId, true);
        client.chatMessage(steamID, 'Уведомления включены. Я напишу, когда появится важное событие.');
        return;
      }
      client.chatMessage(steamID,
        'Я не командный бот для поиска профилей. Я присылаю уведомления SOKOLENOK. Напишите help, чтобы увидеть команды.');
    } catch (err) {
      console.error('[steam-bot] Failed to answer message:', err.message);
      logEvent('steam-bot-message-error', steamId, { message: err.message });
    }
  });

  // Placeholder for stage 2. Kept disabled by default because current events table has no sent_at/channel columns yet.
  if (POLL_EVENTS) {
    console.warn('[steam-bot] STEAM_BOT_POLL_EVENTS=1 is set, but event queue sending is not implemented in MVP stage 1.');
    console.warn('[steam-bot] Next step: extend storage events with channel/sent_at and send formatEventMessage(event).');
  }

  const logOnOptions = {
    accountName: USERNAME,
    password: PASSWORD
  };
  const twoFactorCode = buildTwoFactorCode();
  if (twoFactorCode) logOnOptions.twoFactorCode = twoFactorCode;

  console.log('[steam-bot] Logging into Steam as', USERNAME);
  client.logOn(logOnOptions);

  const shutdown = (signal) => {
    console.log(`[steam-bot] ${signal}: shutting down`);
    logEvent('steam-bot-shutdown', null, { signal });
    try { client.logOff(); } catch (_) {}
    setTimeout(() => process.exit(0), 350);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) startBot();

module.exports = {
  startBot,
  serviceHelp,
  formatEventMessage,
  loadState,
  updateFriend,
  setNotifications
};
