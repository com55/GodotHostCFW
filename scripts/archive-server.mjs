#!/usr/bin/env node
// Pi archive server — receives tasks from the Cloudflare Worker via CF Tunnel.
// Handles download (R2 → local), restore (local → R2), and confirm-local.
//
// Usage:
//   node scripts/archive-server.mjs [--config path/to/config.json]
//   Default config path: scripts/archive-server-config.json

import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

// ---- Config ----------------------------------------------------------------

const configArg = process.argv.indexOf('--config');
const configPath =
  configArg !== -1 ? process.argv[configArg + 1] : 'scripts/archive-server-config.json';

let cfg;
try {
  cfg = JSON.parse(await readFile(configPath, 'utf8'));
} catch {
  console.error(`Cannot read config: ${configPath}`);
  console.error(`Copy scripts/archive-server-config.example.json → ${configPath} and fill it in.`);
  process.exit(1);
}

const { port, archiveDir, workerUrl, archiveSecret, adminUsername, adminPassword } = cfg;

// ---- Path safety -----------------------------------------------------------

function safeVersionDir(slug, version) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(slug))
    throw new Error('bad slug');
  const v = Number(version);
  if (!Number.isInteger(v) || v < 1 || v > 1_000_000) throw new Error('bad version');
  const base = resolve(archiveDir);
  const dir = resolve(base, slug, `v${v}`);
  if (dir !== base && !dir.startsWith(base + sep)) throw new Error('path escape');
  return { dir, version: v };
}

function safeKey(key) {
  if (typeof key !== 'string' || key.startsWith('/') || key.split('/').includes('..'))
    throw new Error('bad key');
  return key;
}

// ---- Auth helpers ----------------------------------------------------------

async function loginWithRetry(attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${workerUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: adminUsername, password: adminPassword }),
    });
    if (res.ok) return (res.headers.get('set-cookie') || '').split(';')[0];
    console.log(`login attempt ${i + 1} -> ${res.status}, retrying...`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Login failed after retries');
}

// ---- R2 download -----------------------------------------------------------

async function downloadVersion(slug, version) {
  const { dir: versionDir, version: v } = safeVersionDir(slug, version);
  const flagKey = `${slug}:${v}`;
  if (downloadFlags.has(flagKey)) {
    console.log(`[archive] download already in progress for ${slug}/v${v}, skipping`);
    return;
  }
  downloadFlags.set(flagKey, true);
  try {
    const cookie = await loginWithRetry();

    const listRes = await fetch(
      `${workerUrl}/api/internal/list-version?slug=${encodeURIComponent(slug)}&version=${v}`,
      { headers: { 'x-archive-secret': archiveSecret } }
    );
    if (!listRes.ok) throw new Error(`list-version failed: ${listRes.status}`);
    const { keys } = await listRes.json();

    mkdirSync(versionDir, { recursive: true });

    for (const key of keys) {
      const safeK = safeKey(key);
      const destPath = resolve(versionDir, safeK);
      if (!destPath.startsWith(versionDir + sep)) throw new Error(`key escapes versionDir: ${key}`);
      mkdirSync(dirname(destPath), { recursive: true });

      const fileRes = await fetch(
        `${workerUrl}/g/${encodeURIComponent(slug)}/v${v}/${encodeURIComponent(safeK)}`,
        { headers: { cookie } }
      );
      if (!fileRes.ok) throw new Error(`download ${safeK}: ${fileRes.status}`);

      await pipeline(fileRes.body, createWriteStream(destPath));
      process.stdout.write(`  ↓ ${safeK}\n`);
    }

    console.log(`[archive] downloaded ${slug}/v${v} (${keys.length} files)`);
  } finally {
    downloadFlags.delete(flagKey);
  }
}

// ---- In-flight guards ------------------------------------------------------
// Key: `${slug}:${version}` — prevents duplicate concurrent operations.
const downloadFlags = new Map();
const abortFlags = new Map();

// ---- R2 upload (restore) ---------------------------------------------------

const PART = 25 * 1024 * 1024;
const CONCURRENCY = 4;

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

async function putSmall(cookie, key, buf) {
  const r = await fetch(`${workerUrl}/api/upload/put?key=${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { cookie },
    body: buf,
  });
  if (!r.ok) throw new Error(`put ${key}: ${r.status} ${await r.text()}`);
}

async function putMultipart(cookie, key, buf) {
  const create = await fetch(`${workerUrl}/api/upload/mpu-create?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { cookie },
  });
  if (!create.ok) throw new Error(`mpu-create ${key}: ${create.status}`);
  const { uploadId } = await create.json();

  const numParts = Math.ceil(buf.length / PART);
  const parts = new Array(numParts);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= numParts) return;
      const chunk = buf.subarray(i * PART, Math.min((i + 1) * PART, buf.length));
      const r = await fetch(
        `${workerUrl}/api/upload/mpu-part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&part=${i + 1}`,
        { method: 'PUT', headers: { cookie }, body: chunk }
      );
      if (!r.ok) throw new Error(`part ${i + 1}: ${r.status}`);
      parts[i] = { partNumber: i + 1, etag: (await r.json()).etag };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, numParts) }, worker));

  const done = await fetch(`${workerUrl}/api/upload/mpu-complete`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ key, uploadId, parts }),
  });
  if (!done.ok) throw new Error(`mpu-complete ${key}: ${await done.text()}`);
}

async function restoreVersion(slug, version) {
  const { dir: versionDir, version: v } = safeVersionDir(slug, version);
  if (!existsSync(versionDir)) throw new Error(`No local copy at ${versionDir}`);

  const flagKey = `${slug}:${v}`;
  // Skip if a restore for this version is already in flight (e.g. cron retry).
  if (abortFlags.has(flagKey)) {
    console.log(`[archive] restore already in progress for ${slug}/v${v}, skipping`);
    return;
  }
  abortFlags.set(flagKey, false);

  try {
    const cookie = await loginWithRetry();
    const files = walk(versionDir);

    for (const rel of files) {
      if (abortFlags.get(flagKey)) {
        console.log(`[archive] restore aborted for ${slug}/v${v}`);
        return; // don't call restore-done — Worker already reverted storage to 'local'
      }
      const buf = await readFile(join(versionDir, rel));
      const key = `games/${slug}/v${v}/${rel.split('\\').join('/')}`;
      console.log(`  ↑ ${key} (${(buf.length / 1048576).toFixed(1)} MB)`);
      if (buf.length <= PART) await putSmall(cookie, key, buf);
      else await putMultipart(cookie, key, buf);
    }

    if (abortFlags.get(flagKey)) {
      console.log(`[archive] restore aborted for ${slug}/v${v}`);
      return;
    }

    const res = await fetch(`${workerUrl}/api/internal/restore-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-archive-secret': archiveSecret },
      body: JSON.stringify({ slug, version: v }),
    });
    if (!res.ok) throw new Error(`restore-done callback failed: ${res.status}`);

    console.log(`[archive] restored ${slug}/v${v} to R2`);
  } finally {
    abortFlags.delete(flagKey);
  }
}

// ---- Local copy check ------------------------------------------------------

function hasLocalCopy(slug, version) {
  try {
    const { dir } = safeVersionDir(slug, version);
    if (!existsSync(dir)) return false;
    return walk(dir).length > 0;
  } catch {
    return false;
  }
}

// ---- HTTP server -----------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(json);
}

const server = createServer(async (req, res) => {
  if (req.headers['x-archive-secret'] !== archiveSecret) {
    return send(res, 401, { error: 'Unauthorized' });
  }

  const url = new URL(req.url, `http://localhost`);

  try {
    if (req.method === 'POST' && url.pathname === '/archive/download') {
      const { slug, version } = await readBody(req);
      send(res, 202, { queued: true });
      // Run download in background so we don't block the response
      downloadVersion(slug, version)
        .then(() =>
          fetch(`${workerUrl}/api/internal/archive-done`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-archive-secret': archiveSecret },
            body: JSON.stringify({ slug, version }),
          })
        )
        .catch((err) => console.error(`[archive] download error ${slug}/v${version}:`, err));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/archive/restore') {
      const { slug, version } = await readBody(req);
      if (!hasLocalCopy(slug, version)) {
        return send(res, 404, { error: 'No local copy found' });
      }
      send(res, 202, { queued: true });
      restoreVersion(slug, version).catch((err) =>
        console.error(`[archive] restore error ${slug}/v${version}:`, err)
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/archive/confirm-local') {
      const { slug, version } = await readBody(req);
      return send(res, 200, { ok: hasLocalCopy(slug, version) });
    }

    if (req.method === 'POST' && url.pathname === '/archive/abort') {
      const { slug, version } = await readBody(req);
      const { version: v } = safeVersionDir(slug, version);
      abortFlags.set(`${slug}:${v}`, true);
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[archive] handler error:', err);
    send(res, 500, { error: String(err) });
  }
});

server.listen(port, () => {
  console.log(`[archive] Pi server listening on :${port}`);
  console.log(`[archive] archiveDir: ${archiveDir}`);
});
