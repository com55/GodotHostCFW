import type { Env } from './types';

type PiAction = 'download' | 'restore' | 'confirm-local';

/**
 * Call the Pi archive server. Returns true if Pi accepted, false if offline/error.
 * Does NOT throw — callers decide how to handle failure.
 */
export async function callPi(
  env: Env,
  action: PiAction,
  body: { slug: string; version: number }
): Promise<boolean> {
  if (!env.ARCHIVE_URL) return false;
  try {
    const res = await fetch(`${env.ARCHIVE_URL}/archive/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-archive-secret': env.ARCHIVE_SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
