import type { Env } from './types';
import {
  getPendingDownloads,
  getPendingCleanups,
  getPendingRestores,
  setVersionStorage,
} from './db';
import { callPi } from './archive';

export async function runCron(env: Env): Promise<void> {
  await retryDownloads(env);
  await cleanupR2(env);
  await retryRestores(env);
  await cleanupStalePending(env);
}

/** Re-send download requests for versions Pi hasn't confirmed yet. */
async function retryDownloads(env: Env): Promise<void> {
  const tasks = await getPendingDownloads(env.DB);
  for (const t of tasks) {
    await callPi(env, 'download', { slug: t.slug, version: t.version });
  }
}

/**
 * Delete from R2 versions that have been inactive >4h and Pi has confirmed
 * a local copy. Calls Pi to verify the file is still there before deleting.
 */
async function cleanupR2(env: Env): Promise<void> {
  const tasks = await getPendingCleanups(env.DB);
  for (const t of tasks) {
    const confirmed = await callPi(env, 'confirm-local', { slug: t.slug, version: t.version });
    if (!confirmed) continue; // Pi offline or file missing — skip, retry next hour

    await deleteVersionFromR2(env.BUCKET, t.slug, t.version);
    await setVersionStorage(env.DB, t.gameId, t.version, 'local');
  }
}

/** Re-send restore requests for versions stuck in 'restoring'. */
async function retryRestores(env: Env): Promise<void> {
  const tasks = await getPendingRestores(env.DB);
  for (const t of tasks) {
    await callPi(env, 'restore', { slug: t.slug, version: t.version });
  }
}

/** Remove pending versions >1h old and games that have no remaining versions. */
async function cleanupStalePending(env: Env): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM versions WHERE status = 'pending' AND uploaded_at < datetime('now', '-1 hour')"
  ).run();
  await env.DB.prepare(
    'DELETE FROM games WHERE id NOT IN (SELECT DISTINCT game_id FROM versions)'
  ).run();
}

async function deleteVersionFromR2(
  bucket: R2Bucket,
  slug: string,
  version: number
): Promise<void> {
  const prefix = `games/${slug}/v${version}/`;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((o) => o.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
