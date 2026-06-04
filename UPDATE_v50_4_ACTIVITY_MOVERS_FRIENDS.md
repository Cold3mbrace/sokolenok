# SOKOLENOK v50.4 — Activity, movers and friend flow fixes

## What changed

- Fixed inventory "Лидеры роста" and "Лидеры падения":
  - movers are now calculated from item price history, not only from old inventory snapshot top-10 data;
  - empty text now says whether changes are being calculated or whether there were no noticeable movers.
- Online status is now tied to active site usage:
  - background API calls no longer update `last_seen`;
  - the browser sends activity pings only from a visible, focused tab with real user activity.
- Friend request actions no longer reset the Friends page to the main friends tab:
  - accepting/declining incoming requests refreshes the current tab;
  - cancelling outgoing requests refreshes the current tab;
  - unblocking users refreshes the current tab.

## Checks

- `npm.cmd run check`
