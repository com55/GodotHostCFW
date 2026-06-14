import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import {
  getGameId,
  confirmLocalCopy,
  setVersionStorage,
  switchActiveVersion,
} from '../db';

export const internal = new Hono<AppEnv>();

function auth(c: Context<AppEnv>): boolean {
  return c.req.header('x-archive-secret') === c.env.ARCHIVE_SECRET;
}

// Pi → Worker: Pi finished downloading a version to local storage.
internal.post('/archive-done', async (c) => {
  if (!auth(c)) return c.json({ error: 'Unauthorized' }, 401);
  const { slug, version } = await c.req.json<{ slug: string; version: number }>();
  const gameId = await getGameId(c.env.DB, slug);
  if (!gameId) return c.json({ error: 'Game not found' }, 404);
  await confirmLocalCopy(c.env.DB, gameId, version);
  return c.json({ ok: true });
});

// Pi → Worker: Pi finished uploading a version to R2 — activate it.
internal.post('/restore-done', async (c) => {
  if (!auth(c)) return c.json({ error: 'Unauthorized' }, 401);
  const { slug, version } = await c.req.json<{ slug: string; version: number }>();
  const gameId = await getGameId(c.env.DB, slug);
  if (!gameId) return c.json({ error: 'Game not found' }, 404);
  await setVersionStorage(c.env.DB, gameId, version, 'r2');
  const game = await switchActiveVersion(c.env.DB, slug, version);
  return c.json({ game });
});

// Pi → Worker: list all R2 keys for a version so Pi knows what to download.
internal.get('/list-version', async (c) => {
  if (!auth(c)) return c.json({ error: 'Unauthorized' }, 401);
  const slug = c.req.query('slug');
  const versionStr = c.req.query('version');
  if (!slug || !versionStr) return c.json({ error: 'slug and version required' }, 400);

  if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(slug) || !/^\d+$/.test(versionStr)) {
    return c.json({ error: 'Invalid slug or version' }, 400);
  }
  const gameId = await getGameId(c.env.DB, slug);
  if (!gameId) return c.json({ error: 'Game not found' }, 404);

  const prefix = `games/${slug}/v${versionStr}/`;
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await c.env.BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const obj of listed.objects) {
      keys.push(obj.key.slice(prefix.length));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return c.json({ keys });
});
