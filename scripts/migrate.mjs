#!/usr/bin/env node
// Migrate the old filesystem-based project (data/db.json + data/games/) into
// Cloudflare D1 (metadata) and R2 (game files).
//
// Usage:
//   node scripts/migrate.mjs /path/to/old/your-game-data/data
//
// It writes migrate.sql (D1 inserts) and uploads every game file to R2 with
// `wrangler r2 object put ... --remote`. Run from a machine where `wrangler` is
// logged in. If the Raspberry Pi struggles with large uploads, run this on the PC.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const BUCKET = 'godot-games';
const D1_NAME = 'godot_host';
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const activeOnly = args.includes('--active-only');
const sqlOnly = args.includes('--sql-only'); // only emit migrate.sql, skip R2 uploads
const dataDir = args.find((a) => !a.startsWith('--'));
if (!dataDir) {
  console.error('Usage: node scripts/migrate.mjs /path/to/old/data [--active-only]');
  process.exit(1);
}

const db = JSON.parse(readFileSync(join(dataDir, 'db.json'), 'utf-8'));
const gamesDir = join(dataDir, 'games');

/** Recursively list files under dir, returned as paths relative to dir. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

function detectIcon(files) {
  return (
    files.find((f) => f.toLowerCase() === 'icon.png') ||
    files.find((f) => f.toLowerCase().includes('icon') && f.endsWith('.png')) ||
    files.find((f) => f.endsWith('.png')) ||
    ''
  );
}

const sql = (s) => String(s).replace(/'/g, "''");
const lines = [];

for (const game of db.games) {
  const id = game.id || randomUUID();
  lines.push(
    `INSERT INTO games (id, slug, title, description, visibility, access_code, active_version, created_at, updated_at) VALUES ('${id}', '${sql(game.slug)}', '${sql(game.title)}', '${sql(game.description || '')}', '${game.visibility}', '${sql(game.accessCode || '')}', ${game.activeVersion || 1}, '${game.createdAt}', '${game.updatedAt}');`
  );

  const versions = activeOnly
    ? game.versions.filter((v) => v.version === game.activeVersion)
    : game.versions;

  for (const v of versions) {
    const versionDir = join(gamesDir, game.slug, v.folderName);
    const files = walk(versionDir);
    const icon = detectIcon(files);
    lines.push(
      `INSERT INTO versions (game_id, version, uploaded_at, file_size, icon_path, status) VALUES ('${id}', ${v.version}, '${v.uploadedAt}', ${v.fileSize || 0}, '${sql(icon)}', 'ready');`
    );

    for (const rel of files) {
      const key = `games/${game.slug}/${v.folderName}/${rel.split('\\').join('/')}`;
      const file = join(versionDir, rel);
      if (sqlOnly) continue;
      console.log(`R2 put ${key}`);
      execFileSync(
        'npx',
        ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, `--file=${file}`, '--remote'],
        { stdio: 'inherit', cwd: PROJECT_ROOT }
      );
    }
  }
}

writeFileSync('migrate.sql', lines.join('\n') + '\n');
console.log(`\nWrote migrate.sql (${db.games.length} games).`);
console.log(`Now load metadata into D1:\n  npx wrangler d1 execute ${D1_NAME} --remote --file=./migrate.sql`);
