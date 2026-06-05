# SOKOLENOK v50.6 — hidden hardening

## What changed

- Banned users can no longer send new friend requests, closing a quiet notification-spam path.
- Message reply/forward attachments are now server-validated:
  - replies must point to a message from the same dialog;
  - forwarded messages must be messages the sender is allowed to see;
  - old suspicious attachments hydrate as missing instead of leaking text.
- Kept the v50.5 OG short-link fix: `/u/:steamid` shares the generated SOKOLENOK card.
- Package metadata bumped to `5.0.6`.

## Checks

- `npm.cmd run check`
