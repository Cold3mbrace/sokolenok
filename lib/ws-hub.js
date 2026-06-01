// ws-hub.js — registry of live WebSocket connections per Steam ID.
//
// One user can have several open tabs / devices, so we keep a Set of sockets
// per steamId. Each socket is tagged with its steamId on attach so we can
// clean up on close. Inactive sockets (no pong in 60s) are dropped.
//
// Public API:
//   register(ws, steamId)            — call after auth, when WS is open
//   sendTo(steamId, payload)         — JSON-encode and ship to all sockets of this user; returns number of sockets it reached
//   broadcast(payload, exceptSteamId) — to everyone except an optional steamId
//   isOnline(steamId)                — boolean, useful for typing indicators etc.
//   onlineSteamIds()                 — Array<string> currently connected
//   startHeartbeat()                 — start ping/pong loop (call once at boot)

const sockets = new Map(); // steamId -> Set<WebSocket>

function register(ws, steamId) {
  if (!ws || !steamId) return;
  ws._sokSteamId = steamId;
  let set = sockets.get(steamId);
  if (!set) { set = new Set(); sockets.set(steamId, set); }
  set.add(ws);

  ws.on('close', () => unregister(ws));
  ws.on('error', () => { try { ws.terminate(); } catch (_) {} unregister(ws); });
}

function unregister(ws) {
  const steamId = ws && ws._sokSteamId;
  if (!steamId) return;
  const set = sockets.get(steamId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) sockets.delete(steamId);
}

function sendTo(steamId, payload) {
  if (!steamId) return 0;
  const set = sockets.get(String(steamId));
  if (!set || !set.size) return 0;
  const data = JSON.stringify(payload);
  let n = 0;
  for (const ws of set) {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(data); n++; } catch (_) {}
    }
  }
  return n;
}

function broadcast(payload, exceptSteamId) {
  const data = JSON.stringify(payload);
  let n = 0;
  for (const [sid, set] of sockets) {
    if (exceptSteamId && sid === String(exceptSteamId)) continue;
    for (const ws of set) {
      if (ws.readyState === 1) {
        try { ws.send(data); n++; } catch (_) {}
      }
    }
  }
  return n;
}

function isOnline(steamId) {
  const set = sockets.get(String(steamId));
  return !!(set && set.size);
}

function onlineSteamIds() {
  return Array.from(sockets.keys());
}

// Heartbeat: terminate sockets that didn't reply to ping within 60s.
// Browsers and intermediaries silently drop idle TCP — without ping/pong,
// dead sockets sit in the Map forever.
let heartbeatInterval = null;
function startHeartbeat() {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    for (const set of sockets.values()) {
      for (const ws of set) {
        if (ws.isAlive === false) {
          try { ws.terminate(); } catch (_) {}
          continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) {}
      }
    }
  }, 30000);
  heartbeatInterval.unref?.();
}

function attachPongHandler(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
}

module.exports = {
  register,
  unregister,
  sendTo,
  broadcast,
  isOnline,
  onlineSteamIds,
  startHeartbeat,
  attachPongHandler
};
