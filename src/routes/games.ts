import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireAuth } from './auth';
import {
  listGames,
  getGame,
  getGameId,
  getActiveIcon,
  createGame,
  addVersion,
  finalizeVersion,
  updateGame,
  deleteGame,
  deactivateVersion,
  setVersionStorage,
  switchActiveVersion,
} from '../db';
import { callPi } from '../archive';

export const games = new Hono<AppEnv>();

// ---- Protected (admin) routes ----

games.get('/', requireAuth, async (c) => {
  return c.json({ games: await listGames(c.env.DB) });
});

games.get('/:slug', requireAuth, async (c) => {
  const game = await getGame(c.env.DB, c.req.param('slug'));
  if (!game) return c.json({ error: 'Game not found' }, 404);
  return c.json({ game });
});

// Create a new game (returns slug + version to upload files under).
games.post('/', requireAuth, async (c) => {
  const body = await c.req.json<{
    title?: string;
    description?: string;
    visibility?: 'public' | 'private';
    accessCode?: string;
  }>();

  const title = (body.title ?? '').trim();
  if (!title) return c.json({ error: 'Title is required' }, 400);

  const { slug, version } = await createGame(c.env.DB, {
    title,
    description: body.description ?? '',
    visibility: body.visibility === 'private' ? 'private' : 'public',
    accessCode: body.accessCode ?? '',
  });

  return c.json({ slug, version }, 201);
});

// Create a new version for an existing game.
games.post('/:slug/versions', requireAuth, async (c) => {
  const slug = c.req.param('slug');
  const version = await addVersion(c.env.DB, slug);
  if (version === null) return c.json({ error: 'Game not found' }, 404);
  return c.json({ slug, version }, 201);
});

// Finalize a version once all files are uploaded to R2: mark ready + activate.
games.post('/:slug/finalize', requireAuth, async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json<{ version?: number; fileSize?: number; iconPath?: string }>();
  if (typeof body.version !== 'number') return c.json({ error: 'version is required' }, 400);

  // Read current active version before finalizing so we can deactivate it after.
  const before = await getGame(c.env.DB, slug);
  const oldVersion = before?.activeVersion;

  const ok = await finalizeVersion(
    c.env.DB,
    slug,
    body.version,
    body.fileSize ?? 0,
    body.iconPath ?? ''
  );
  if (!ok) return c.json({ error: 'Game not found' }, 404);

  const gameId = await getGameId(c.env.DB, slug);
  if (gameId && oldVersion !== undefined && oldVersion !== body.version) {
    await deactivateVersion(c.env.DB, gameId, oldVersion);
  }

  // Fire-and-forget: ask Pi to download new version. Game is unaffected if Pi is offline.
  callPi(c.env, 'download', { slug, version: body.version }).catch(() => {});

  const game = await getGame(c.env.DB, slug);
  return c.json({ game }, 201);
});

games.put('/:slug', requireAuth, async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json<Record<string, unknown>>();

  // If switching active version, check storage state first.
  if (typeof body.activeVersion === 'number') {
    const current = await getGame(c.env.DB, slug);
    if (!current) return c.json({ error: 'Game not found' }, 404);

    const target = current.versions.find((v) => v.version === body.activeVersion);
    if (!target) return c.json({ error: 'Version not found' }, 404);

    if (target.storage === 'restoring') {
      return c.json({ error: 'Version is already being restored', restoring: true }, 409 as 409);
    }

    if (target.storage === 'local') {
      const gameId = await getGameId(c.env.DB, slug);
      if (!gameId) return c.json({ error: 'Game not found' }, 404);
      await setVersionStorage(c.env.DB, gameId, target.version, 'restoring');

      const piOk = await callPi(c.env, 'restore', { slug, version: target.version });
      if (!piOk) {
        // Pi offline — leave as 'restoring' (cron will retry) or revert based on user choice.
        // Return 503 so the dashboard can prompt the user.
        return c.json(
          {
            error:
              'ไม่สามารถ restore ได้เนื่องจากไม่สามารถเชื่อมต่อที่เก็บข้อมูลได้',
            queued: true,
          },
          503
        );
      }
      // Pi accepted — restore-done callback will activate and set storage='r2'.
      return c.json({ restoring: true });
    }

    // storage = 'r2': instant switch.
    const game = await switchActiveVersion(c.env.DB, slug, body.activeVersion);
    return c.json({ game });
  }

  // Cancel a pending restore — revert storage back to 'local'.
  if (typeof body.cancelRestore === 'number') {
    const gameId = await getGameId(c.env.DB, slug);
    if (!gameId) return c.json({ error: 'Game not found' }, 404);
    await setVersionStorage(c.env.DB, gameId, body.cancelRestore, 'local');
    return c.json({ ok: true });
  }

  const game = await updateGame(c.env.DB, slug, body);
  if (!game) return c.json({ error: 'Game not found' }, 404);
  return c.json({ game });
});

games.delete('/:slug', requireAuth, async (c) => {
  const slug = c.req.param('slug');
  const ok = await deleteGame(c.env.DB, slug);
  if (!ok) return c.json({ error: 'Game not found' }, 404);

  // Remove all R2 objects for this game (games/<slug>/...).
  await deletePrefix(c.env.BUCKET, `games/${slug}/`);
  return c.json({ success: true });
});

// ---- Public routes (player page) ----

games.post('/:slug/verify', async (c) => {
  const slug = c.req.param('slug');
  const { accessCode } = await c.req.json<{ accessCode?: string }>();

  const game = await getGame(c.env.DB, slug);
  if (!game) return c.json({ error: 'Game not found' }, 404);
  if (game.visibility !== 'private') return c.json({ granted: true });
  if (game.accessCode === accessCode) return c.json({ granted: true });

  return c.json({ error: 'Invalid access code', granted: false }, 403);
});

// Public-safe info used by the player to load the game.
games.get('/:slug/info', async (c) => {
  const slug = c.req.param('slug');
  const game = await getGame(c.env.DB, slug);
  if (!game) return c.json({ error: 'Game not found' }, 404);

  const active = game.versions.find((v) => v.version === game.activeVersion);
  if (!active) return c.json({ error: 'No active version' }, 404);

  return c.json({
    slug: game.slug,
    title: game.title,
    description: game.description,
    visibility: game.visibility,
    activeVersion: game.activeVersion,
    iconPath: await getActiveIcon(c.env.DB, slug),
  });
});

/** Delete every object under a prefix, paginating through the listing. */
async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((o) => o.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
