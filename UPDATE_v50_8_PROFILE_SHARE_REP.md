# SOKOLENOK v50.8 — profile share cards and reputation count

## What changed

- Profile sharing inside site messages now sends a real profile attachment instead of plain text.
- Shared Steam profile attachments render as clickable cards with the generated OG image, avatar, name and "open profile" CTA.
- Telegram-only profiles render as clickable profile cards with avatar/name and the same CTA.
- Reputation summary now counts one positive/negative vote per person, even if that person selected several tags.
- Category tags still keep their own per-tag counts for detail.

## Checks

- `npm.cmd run check`
- reputation aggregate smoke test
- profile attachment message smoke test
