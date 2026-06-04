# SOKOLENOK v49.1 — mobile + Telegram profile fix

## What changed

- Mobile pages now have an extra anti-overflow CSS layer so cards, tabs, friend rows and lookup blocks do not drift outside the iPhone viewport.
- The PWA safe-area strip at the top is now subtle and textless instead of a loud permanent green SOKOLENOK header.
- Telegram accounts (`tg:<id>`) are accepted as normal site users for profiles, friends, blocks, messages, reputation and presence.
- Steam-only data endpoints now return graceful "steam-required" empty states for Telegram users instead of breaking the page.
- Profile, message and friend links now encode user IDs safely, so `tg:<id>` survives navigation.

## Checks

- `node --check server.js`
- `node --check storage/db.js`
- `node --check public/app.js`
