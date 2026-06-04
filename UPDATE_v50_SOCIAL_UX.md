# SOKOLENOK v50.0 — Social UX Core

## What changed

- Added a clearer social-style top bar on pages with:
  - player search,
  - notifications icon,
  - messages icon,
  - profile avatar shortcut.
- Added a notifications dropdown so users do not need to open a separate page for every update.
- Added a friends search panel directly on the Friends page:
  - search by nickname, SteamID, Steam URL, or Telegram site user ID,
  - add friend,
  - accept incoming request,
  - open profile,
  - write to existing friend.
- Added message receipts in chat:
  - one check mark for sent,
  - two green check marks for viewed.

## Checks

- `node --check server.js`
- `node --check storage/db.js`
- `node --check public/app.js`
- local smoke test: `/api/health` and `/friends` returned 200
