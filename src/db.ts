import type { Game, GameVersion } from './types';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

interface GameRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  visibility: 'public' | 'private';
  access_code: string;
  active_version: number;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  version: number;
  uploaded_at: string;
  file_size: number;
  icon_path: string;
  status: string;
  storage: 'r2' | 'local' | 'restoring';
  has_local_copy: number;
}

function toVersion(r: VersionRow): GameVersion {
  return {
    version: r.version,
    uploadedAt: r.uploaded_at,
    fileSize: r.file_size,
    folderName: `v${r.version}`,
    storage: r.storage ?? 'r2',
    hasLocalCopy: (r.has_local_copy ?? 0) === 1,
  };
}

function toGame(g: GameRow, versions: GameVersion[]): Game {
  return {
    id: g.id,
    slug: g.slug,
    title: g.title,
    description: g.description,
    visibility: g.visibility,
    accessCode: g.access_code,
    activeVersion: g.active_version,
    versions,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  };
}

/** List all games that have at least one ready version. */
export async function listGames(db: D1Database): Promise<Game[]> {
  const games = await db
    .prepare('SELECT * FROM games ORDER BY updated_at DESC')
    .all<GameRow>();

  const result: Game[] = [];
  for (const g of games.results) {
    const versions = await readyVersions(db, g.id);
    if (versions.length > 0) result.push(toGame(g, versions));
  }
  return result;
}

async function readyVersions(db: D1Database, gameId: string): Promise<GameVersion[]> {
  const rows = await db
    .prepare("SELECT * FROM versions WHERE game_id = ? AND status = 'ready' ORDER BY version ASC")
    .bind(gameId)
    .all<VersionRow>();
  return rows.results.map(toVersion);
}

async function rawGame(db: D1Database, slug: string): Promise<GameRow | null> {
  return db.prepare('SELECT * FROM games WHERE slug = ?').bind(slug).first<GameRow>();
}

/** Returns the internal game id for a slug, or null if not found. */
export async function getGameId(db: D1Database, slug: string): Promise<string | null> {
  const g = await rawGame(db, slug);
  return g?.id ?? null;
}

export async function getGame(db: D1Database, slug: string): Promise<Game | null> {
  const g = await rawGame(db, slug);
  if (!g) return null;
  return toGame(g, await readyVersions(db, g.id));
}

/** Returns the icon_path of the active version, or '' if none. */
export async function getActiveIcon(db: D1Database, slug: string): Promise<string> {
  const row = await db
    .prepare(
      `SELECT v.icon_path AS icon_path FROM versions v
       JOIN games g ON g.id = v.game_id
       WHERE g.slug = ? AND v.version = g.active_version AND v.status = 'ready'`
    )
    .bind(slug)
    .first<{ icon_path: string }>();
  return row?.icon_path ?? '';
}

export async function createGame(
  db: D1Database,
  data: { title: string; description: string; visibility: 'public' | 'private'; accessCode: string }
): Promise<{ slug: string; version: number }> {
  const base = slugify(data.title) || 'game';
  let slug = base;
  let counter = 1;
  while (await rawGame(db, slug)) slug = `${base}-${counter++}`;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.batch([
    db
      .prepare(
        `INSERT INTO games (id, slug, title, description, visibility, access_code, active_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .bind(id, slug, data.title, data.description, data.visibility, data.accessCode, now, now),
    db
      .prepare(
        `INSERT INTO versions (game_id, version, uploaded_at, file_size, status) VALUES (?, 1, ?, 0, 'pending')`
      )
      .bind(id, now),
  ]);

  return { slug, version: 1 };
}

/** Create a new pending version for an existing game. Returns the new version number. */
export async function addVersion(db: D1Database, slug: string): Promise<number | null> {
  const g = await rawGame(db, slug);
  if (!g) return null;

  const max = await db
    .prepare('SELECT MAX(version) AS m FROM versions WHERE game_id = ?')
    .bind(g.id)
    .first<{ m: number | null }>();
  const next = (max?.m ?? 0) + 1;

  await db
    .prepare(
      `INSERT INTO versions (game_id, version, uploaded_at, file_size, status) VALUES (?, ?, ?, 0, 'pending')`
    )
    .bind(g.id, next, new Date().toISOString())
    .run();

  return next;
}

/** Mark a version ready, record size + icon, and activate it. */
export async function finalizeVersion(
  db: D1Database,
  slug: string,
  version: number,
  fileSize: number,
  iconPath: string
): Promise<boolean> {
  const g = await rawGame(db, slug);
  if (!g) return false;
  const now = new Date().toISOString();

  await db.batch([
    db
      .prepare(
        `UPDATE versions SET status = 'ready', file_size = ?, icon_path = ?, uploaded_at = ?
         WHERE game_id = ? AND version = ?`
      )
      .bind(fileSize, iconPath, now, g.id, version),
    db
      .prepare('UPDATE games SET active_version = ?, updated_at = ? WHERE id = ?')
      .bind(version, now, g.id),
  ]);
  return true;
}

export async function updateGame(
  db: D1Database,
  slug: string,
  data: Partial<{
    title: string;
    description: string;
    visibility: 'public' | 'private';
    accessCode: string;
    activeVersion: number;
  }>
): Promise<Game | null> {
  const g = await rawGame(db, slug);
  if (!g) return null;

  const fields: string[] = [];
  const values: unknown[] = [];
  if (data.title !== undefined) (fields.push('title = ?'), values.push(data.title));
  if (data.description !== undefined) (fields.push('description = ?'), values.push(data.description));
  if (data.visibility !== undefined) (fields.push('visibility = ?'), values.push(data.visibility));
  if (data.accessCode !== undefined) (fields.push('access_code = ?'), values.push(data.accessCode));
  if (data.activeVersion !== undefined) (fields.push('active_version = ?'), values.push(data.activeVersion));
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());

  await db
    .prepare(`UPDATE games SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values, g.id)
    .run();

  return getGame(db, slug);
}

/** Set deactivated_at on a version (called when it stops being active). */
export async function deactivateVersion(
  db: D1Database,
  gameId: string,
  version: number
): Promise<void> {
  await db
    .prepare('UPDATE versions SET deactivated_at = ? WHERE game_id = ? AND version = ?')
    .bind(new Date().toISOString(), gameId, version)
    .run();
}

/** Mark that Pi has a confirmed local copy of this version. */
export async function confirmLocalCopy(
  db: D1Database,
  gameId: string,
  version: number
): Promise<void> {
  await db
    .prepare('UPDATE versions SET has_local_copy = 1 WHERE game_id = ? AND version = ?')
    .bind(gameId, version)
    .run();
}

/** Revert all restoring versions back to 'local', except the one being activated. */
export async function cancelPendingRestores(
  db: D1Database,
  gameId: string,
  exceptVersion: number
): Promise<void> {
  await db
    .prepare(
      "UPDATE versions SET storage = 'local' WHERE game_id = ? AND storage = 'restoring' AND version != ?"
    )
    .bind(gameId, exceptVersion)
    .run();
}

/** Get the current storage value for a version. */
export async function getVersionStorage(
  db: D1Database,
  gameId: string,
  version: number
): Promise<string | null> {
  const row = await db
    .prepare('SELECT storage FROM versions WHERE game_id = ? AND version = ?')
    .bind(gameId, version)
    .first<{ storage: string }>();
  return row?.storage ?? null;
}

/** Update the storage location of a version. */
export async function setVersionStorage(
  db: D1Database,
  gameId: string,
  version: number,
  storage: 'r2' | 'local' | 'restoring'
): Promise<void> {
  await db
    .prepare('UPDATE versions SET storage = ? WHERE game_id = ? AND version = ?')
    .bind(storage, gameId, version)
    .run();
}

/** Atomically switch active version and deactivate the old one. */
export async function switchActiveVersion(
  db: D1Database,
  slug: string,
  newVersion: number
): Promise<Game | null> {
  const g = await rawGame(db, slug);
  if (!g) return null;
  const now = new Date().toISOString();
  const stmts = [
    db
      .prepare('UPDATE games SET active_version = ?, updated_at = ? WHERE id = ?')
      .bind(newVersion, now, g.id),
  ];
  if (g.active_version !== newVersion) {
    stmts.push(
      db
        .prepare('UPDATE versions SET deactivated_at = ? WHERE game_id = ? AND version = ?')
        .bind(now, g.id, g.active_version)
    );
  }
  await db.batch(stmts);
  return getGame(db, slug);
}

interface ArchiveTask {
  gameId: string;
  slug: string;
  version: number;
}

/** Versions that need to be downloaded to Pi (ready but Pi hasn't confirmed). */
export async function getPendingDownloads(db: D1Database): Promise<ArchiveTask[]> {
  const rows = await db
    .prepare(
      `SELECT g.id AS game_id, g.slug, v.version
       FROM versions v JOIN games g ON g.id = v.game_id
       WHERE v.status = 'ready' AND v.has_local_copy = 0 AND v.storage != 'restoring'`
    )
    .all<{ game_id: string; slug: string; version: number }>();
  return rows.results.map((r) => ({ gameId: r.game_id, slug: r.slug, version: r.version }));
}

/** Versions that can be deleted from R2 (inactive >4h, Pi confirmed, still in R2). */
export async function getPendingCleanups(db: D1Database): Promise<ArchiveTask[]> {
  const rows = await db
    .prepare(
      `SELECT g.id AS game_id, g.slug, v.version
       FROM versions v JOIN games g ON g.id = v.game_id
       WHERE v.deactivated_at < datetime('now', '-4 hours')
         AND v.has_local_copy = 1
         AND v.storage = 'r2'`
    )
    .all<{ game_id: string; slug: string; version: number }>();
  return rows.results.map((r) => ({ gameId: r.game_id, slug: r.slug, version: r.version }));
}

/** Versions stuck in 'restoring' (Pi needs to retry upload). */
export async function getPendingRestores(db: D1Database): Promise<ArchiveTask[]> {
  const rows = await db
    .prepare(
      `SELECT g.id AS game_id, g.slug, v.version
       FROM versions v JOIN games g ON g.id = v.game_id
       WHERE v.storage = 'restoring'`
    )
    .all<{ game_id: string; slug: string; version: number }>();
  return rows.results.map((r) => ({ gameId: r.game_id, slug: r.slug, version: r.version }));
}

/** Deletes the game row (cascades versions). Returns the game id for R2 cleanup, or null. */
export async function deleteGame(db: D1Database, slug: string): Promise<boolean> {
  const g = await rawGame(db, slug);
  if (!g) return false;
  await db.batch([
    db.prepare('DELETE FROM versions WHERE game_id = ?').bind(g.id),
    db.prepare('DELETE FROM games WHERE id = ?').bind(g.id),
  ]);
  return true;
}
