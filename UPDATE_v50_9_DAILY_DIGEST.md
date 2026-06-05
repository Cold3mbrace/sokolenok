# SOKOLENOK v50.9 — daily digest

## What changed

- Added a quiet "Сегодня / Что изменилось" block to the logged-in dashboard.
- The block uses existing site signals without new database tables:
  - unread messages;
  - friend requests;
  - unread notifications;
  - inventory value movement from the latest snapshots;
  - reputation summary.
- If there are no events, it shows a calm "Спокойный день" state with useful next actions.
- The block stays neutral and useful for everyone: players, friends, viewers and returning visitors.

## Checks

- `npm.cmd run check`
- local dashboard smoke check
