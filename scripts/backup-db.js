#!/usr/bin/env node
// scripts/backup-db.js — daily backup of the SQLite database.
//
// Run via cron at 04:00 UTC (or whenever traffic is lowest):
//   0 4 * * * cd /var/www/sokolenok && /usr/bin/node scripts/backup-db.js >> /var/log/sokolenok-backup.log 2>&1
//
// Why this script vs `cp`:
//   - SQLite uses WAL mode; the .sqlite file alone is inconsistent if you copy
//     it while the server is writing. The `VACUUM INTO` command (or `.backup`
//     in the CLI) takes a snapshot atomically.
//   - We use node:sqlite which supports VACUUM INTO natively in SQLite 3.27+.
//
// What it does:
//   1. Snapshot .data/sokolenok.sqlite → .data/backups/YYYY-MM-DD.sqlite
//   2. Delete backups older than 14 days
//   3. Print summary

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.SOKOLENOK_DATA_DIR
  ? path.resolve(process.env.SOKOLENOK_DATA_DIR)
  : path.join(ROOT, '.data');
const DB_PATH = path.join(DATA_DIR, 'sokolenok.sqlite');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_DAYS = 14;

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[backup] source DB missing: ${DB_PATH}`);
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  // YYYY-MM-DD in UTC. Stable across timezones, sorts lexically.
  const today = new Date().toISOString().slice(0, 10);
  const outPath = path.join(BACKUP_DIR, `${today}.sqlite`);

  // If a backup for today already exists, we'll overwrite — last-write-wins
  // is fine since multiple runs in one day are usually a retry after failure.
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

  const t0 = Date.now();
  const db = new sqlite.DatabaseSync(DB_PATH);
  // VACUUM INTO takes a consistent snapshot even while the main process is
  // writing — it acquires a shared lock briefly, copies pages, then releases.
  // The escape-quotes are required because the path is interpolated as a
  // SQL literal, not a parameter (VACUUM doesn't accept parameters).
  const escapedPath = outPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedPath}'`);
  db.close();
  const dt = Date.now() - t0;

  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  console.log(`[backup] ${today}.sqlite written (${sizeMB} MB) in ${dt}ms`);

  // Sweep old backups: anything older than KEEP_DAYS days by filename date.
  // Filename date is more reliable than mtime (admin might `touch` files).
  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  let removed = 0;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.sqlite$/);
    if (!m) continue; // skip non-backup files (e.g. .keep)
    if (m[1] < cutoff) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      removed++;
    }
  }
  if (removed) console.log(`[backup] swept ${removed} old backup(s) older than ${cutoff}`);
}

try { main(); } catch (e) {
  console.error('[backup] FAILED:', e.message);
  process.exit(2);
}
