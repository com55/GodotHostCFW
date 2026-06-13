import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { mimeFor } from '../mime';

export const serve = new Hono<AppEnv>();

// Serve the player shell for any slug. The page's JS reads the slug from the
// URL and fetches game info to load the correct version.
serve.get('/play/:slug', async (c) => {
  // Fetch the directory form so the assets handler serves index.html with a 200
  // instead of redirecting /player/index.html -> /player/.
  const url = new URL('/player/', c.req.url);
  return c.env.ASSETS.fetch(new Request(url, { headers: c.req.raw.headers }));
});

// Serve game files from R2 with the headers Godot needs for SharedArrayBuffer.
// Path: /g/<slug>/v<n>/<file...>  ->  R2 key  games/<slug>/v<n>/<file...>
serve.get('/g/:slug/:version/*', async (c) => {
  const { pathname } = new URL(c.req.url);
  const match = pathname.match(/^\/g\/([^/]+)\/(v\d+)\/(.+)$/);
  if (!match) return c.notFound();

  const [, slug, version, filePath] = match;
  if (filePath.includes('..')) return c.text('Forbidden', 403);

  const key = `games/${slug}/${version}/${decodeURIComponent(filePath)}`;
  const object = await c.env.BUCKET.get(key);
  if (!object) return c.notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has('content-type')) headers.set('content-type', mimeFor(filePath));
  headers.set('etag', object.httpEtag);
  // Versioned paths are immutable: cache hard at the edge and in the browser.
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  // Required for Godot multi-threaded (SharedArrayBuffer) exports.
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');

  return new Response(object.body, { headers });
});
