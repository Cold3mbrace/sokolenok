#!/usr/bin/env node
// scripts/healthcheck.js — pings the local server and alerts via Telegram
// if status changes (down or recovered).
//
// Run every minute via cron:
//   * * * * * cd /var/www/sokolenok && /usr/bin/node scripts/healthcheck.js >> /var/log/sokolenok-healthcheck.log 2>&1
//
// Env vars required:
//   TELEGRAM_BOT_TOKEN  — same bot used for login
//   ALERT_TELEGRAM_CHAT — your personal chat ID (numeric). Get it by messaging
//                         your bot once, then GET https://api.telegram.org/bot{TOKEN}/getUpdates
//
// State file `.data/healthcheck-state.json` remembers whether we last saw
// "up" or "down" — alerts fire only on transitions, not every minute.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.SOKOLENOK_DATA_DIR
  ? path.resolve(process.env.SOKOLENOK_DATA_DIR)
  : path.join(ROOT, '.data');
const STATE_FILE = path.join(DATA_DIR, 'healthcheck-state.json');

// Server binds to PORT (default 4173 in repo). We hit localhost to avoid
// going through nginx — that way we test the app, not the proxy.
const PORT = parseInt(process.env.PORT || '4173', 10);
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
const TIMEOUT_MS = 10_000;

// Load env from .env if it exists (the cron job won't inherit pm2's env)
try {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
} catch (_) { /* best-effort */ }

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.ALERT_TELEGRAM_CHAT || '';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return { status: 'unknown', since: null, downCount: 0 }; }
}
function saveState(s) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s), { mode: 0o600 });
  } catch (e) { console.error('[health] failed to save state:', e.message); }
}

async function pingServer() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: TIMEOUT_MS }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return resolve({ ok: false, reason: `HTTP ${res.statusCode}` });
        }
        try {
          const json = JSON.parse(buf);
          if (json?.ok) return resolve({ ok: true, version: json.version });
          resolve({ ok: false, reason: 'health JSON not ok' });
        } catch (_) {
          resolve({ ok: false, reason: 'bad JSON' });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, reason: e.code || e.message }));
  });
}

async function notifyTelegram(text) {
  if (!TOKEN || !CHAT) {
    console.warn('[health] alert needed but TELEGRAM_BOT_TOKEN/ALERT_TELEGRAM_CHAT not set:', text);
    return;
  }
  const payload = JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML' });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error('[health] Telegram error:', res.statusCode, buf.slice(0, 200));
        }
        resolve();
      });
    });
    req.on('error', (e) => { console.error('[health] Telegram send error:', e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}

(async () => {
  const result = await pingServer();
  const prev = loadState();
  const now = new Date().toISOString();

  if (result.ok) {
    // Recovery: previous state was "down" (or unknown after an outage)
    if (prev.status === 'down') {
      const downSince = prev.since || 'unknown';
      const dur = prev.since ? Math.round((Date.now() - new Date(prev.since)) / 60000) : '?';
      await notifyTelegram(
        `✅ <b>SOKOLENOK поднялся</b>\nВерсия: ${result.version || '?'}\nЛежал с ${downSince}\nДлительность: ~${dur} мин`
      );
    }
    saveState({ status: 'up', since: now, downCount: 0, lastVersion: result.version });
    console.log(`[health] OK · ${result.version}`);
    return;
  }

  // Down. To avoid alert-spam on flaky transient errors, require 2 consecutive
  // failures before sending the first alert.
  const downCount = (prev.downCount || 0) + 1;
  if (prev.status !== 'down' && downCount >= 2) {
    await notifyTelegram(
      `🔴 <b>SOKOLENOK не отвечает</b>\nПричина: ${result.reason}\nВремя: ${now}\n\nПроверь: <code>pm2 logs sokolenok --lines 50 --nostream</code>`
    );
    saveState({ status: 'down', since: now, downCount });
  } else {
    saveState({ status: prev.status === 'down' ? 'down' : 'unknown', since: prev.since || now, downCount });
  }
  console.log(`[health] FAIL · ${result.reason} · downCount=${downCount}`);
})();
