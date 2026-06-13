import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireAuth } from './auth';
import { mimeFor } from '../mime';

export const upload = new Hono<AppEnv>();

// All upload routes are admin-only.
upload.use('*', requireAuth);

/** Validate an R2 key: must live under games/ and contain no traversal. */
function safeKey(key: string | undefined): key is string {
  return !!key && key.startsWith('games/') && !key.includes('..');
}

// Single PUT for small files.
upload.put('/put', async (c) => {
  const key = c.req.query('key');
  if (!safeKey(key)) return c.json({ error: 'Invalid key' }, 400);

  const body = await c.req.arrayBuffer();
  await c.env.BUCKET.put(key, body, {
    httpMetadata: { contentType: mimeFor(key) },
  });
  return c.json({ success: true });
});

// Begin a multipart upload for a large file.
upload.post('/mpu-create', async (c) => {
  const key = c.req.query('key');
  if (!safeKey(key)) return c.json({ error: 'Invalid key' }, 400);

  const mpu = await c.env.BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: mimeFor(key) },
  });
  return c.json({ key: mpu.key, uploadId: mpu.uploadId });
});

// Upload a single part. Parts are uploaded in parallel by the client.
upload.put('/mpu-part', async (c) => {
  const key = c.req.query('key');
  const uploadId = c.req.query('uploadId');
  const partNumber = Number(c.req.query('part'));
  if (!safeKey(key) || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
    return c.json({ error: 'Invalid part request' }, 400);
  }

  const mpu = c.env.BUCKET.resumeMultipartUpload(key, uploadId);
  const body = await c.req.arrayBuffer();
  const part = await mpu.uploadPart(partNumber, body);
  return c.json({ partNumber: part.partNumber, etag: part.etag });
});

// Finish a multipart upload.
upload.post('/mpu-complete', async (c) => {
  const { key, uploadId, parts } = await c.req.json<{
    key?: string;
    uploadId?: string;
    parts?: { partNumber: number; etag: string }[];
  }>();
  if (!safeKey(key) || !uploadId || !Array.isArray(parts)) {
    return c.json({ error: 'Invalid complete request' }, 400);
  }

  const mpu = c.env.BUCKET.resumeMultipartUpload(key, uploadId);
  try {
    await mpu.complete(parts);
  } catch (err) {
    return c.json({ error: `Failed to complete upload: ${(err as Error).message}` }, 400);
  }
  return c.json({ success: true });
});
