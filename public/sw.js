// public/sw.js — SOKOLENOK service worker.
// Minimal: receive push, show notification, route click.

const CACHE = 'sok-v3';
const activeMessagePeers = new Map();

self.addEventListener('install', (event) => {
  // Activate immediately — we want push subscriptions to work right after first SW registration
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim all clients so push delivery starts working without a reload
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'sok:active-message-peer') return;
  const id = event.source?.id;
  if (!id) return;
  if (data.peer) activeMessagePeers.set(id, String(data.peer));
  else activeMessagePeers.delete(id);
});

// Push delivery: data is the JSON we send from the server.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {
    try { data = { title: 'SOKOLENOK', body: event.data ? event.data.text() : '' }; }
    catch (_) {}
  }
  const title = data.title || 'SOKOLENOK';
  const options = {
    body: data.body || '',
    icon: data.icon || '/assets/logo-icon.png',
    badge: '/assets/logo-icon.png',
    data: { url: data.url || '/', kind: data.kind || null, peer: data.peer || null },
    // Tag messages from the same peer so a second message replaces the first one
    // in the tray instead of stacking. Notifications still appear, just collapsed.
    tag: data.kind === 'message' && data.peer ? `msg:${data.peer}` : undefined,
    renotify: data.kind === 'message',
    requireInteraction: false
  };

  // Suppression rule: don't pop an OS notification if the user is *actively
  // looking at the relevant content right now*. Specifically — for messages,
  // suppress only when:
  //   1) at least one tab on our origin is focused, AND
  //   2) that focused tab is on /messages with ?to=<peer> or the chat is open
  // For everything else (notifications, comments) — always show.
  event.waitUntil((async () => {
    try {
      if (data.kind === 'message' && data.peer) {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const activeMatchingChat = all.find(c => {
          if (c.visibilityState !== 'visible' || !c.focused) return false;
          try {
            const u = new URL(c.url);
            if (u.pathname !== '/messages') return false;
            // The chat page tracks the open thread in URL and via postMessage.
            return u.searchParams.get('to') === data.peer || activeMessagePeers.get(c.id) === data.peer;
          } catch (_) { return false; }
        });
        if (activeMatchingChat) {
          // User is actively reading this chat — skip OS popup.
          return;
        }
      }
      await self.registration.showNotification(title, options);
    } catch (_) {
      // Last-resort: always try to show — better a duplicate than silence
      try { await self.registration.showNotification(title, options); } catch (_) {}
    }
  })());
});

// Click: focus an existing tab pointing at the right URL, or open a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer a tab already on our origin — navigate it
    for (const c of all) {
      try {
        const u = new URL(c.url);
        if (u.origin === self.location.origin) {
          await c.focus();
          // Only navigate if it's a different path — don't disrupt the chat the user might be reading
          const want = new URL(targetUrl, self.location.origin);
          if (u.pathname + u.search !== want.pathname + want.search) {
            try { await c.navigate(want.href); } catch (_) {}
          }
          return;
        }
      } catch (_) {}
    }
    // No matching tab — open a new one
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

// When the user unsubscribes via OS / browser settings, we get this event.
// We can't reach the server here (no cookie session), so the cleanup happens
// server-side on the next push attempt (404/410 → delete).
self.addEventListener('pushsubscriptionchange', (event) => {
  // Future enhancement: re-subscribe with the new endpoint here and POST it back
});
