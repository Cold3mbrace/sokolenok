# SOKOLENOK v50.3 — Fast dialogs

## What changed

- Dialog switching no longer reloads the left rail on every click.
- Opened threads are cached in memory, so returning to a dialog shows it immediately while the fresh data loads in the background.
- Conversation and friends lists are cached briefly in `sessionStorage`, so coming back to Messages does not start from an empty loading state.
- Safety polling on the Messages page is calmer:
  - 8 seconds without WebSocket,
  - 25 seconds when WebSocket is alive.
- Read events are only sent when messages actually changed from unread to read.
- Outgoing messages now show clear delivery text:
  - one check + "Отправлено",
  - two checks + "Прочитано".

## Checks

- `npm.cmd run check`
