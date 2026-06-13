#!/usr/bin/env node
// Upload a local directory of already-extracted game files to R2 through the
// deployed Worker's multipart API (handles files of any size, unlike the
// `wrangler r2 object put` 300 MiB CLI limit).
//
// Usage:
//   WORKER_URL=https://... ADMIN_USERNAME=admin ADMIN_PASSWORD=... \
//     node scripts/put-dir.mjs /path/to/v17 games/lafy/v17

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PART = 25 * 1024 * 1024;
const CONCURRENCY = 4;

const BASE = process.env.WORKER_URL;
const [dir, prefix] = process.argv.slice(2);
if (!BASE || !dir || !prefix) {
  console.error('Need WORKER_URL env and args: <localDir> <r2KeyPrefix>');
  process.exit(1);
}

function walk(d, base = d) {
  const out = [];
  for (const e of readdirSync(d)) {
    const full = join(d, e);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loginWithRetry(attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: process.env.ADMIN_USERNAME,
        password: process.env.ADMIN_PASSWORD,
      }),
    });
    if (res.ok) return (res.headers.get('set-cookie') || '').split(';')[0];
    console.log(`login attempt ${i + 1} -> ${res.status}, retrying...`);
    await sleep(3000);
  }
  throw new Error('Login failed after retries (secret may not have propagated)');
}

const cookie = await loginWithRetry();

async function putSmall(key, buf) {
  const r = await fetch(`${BASE}/api/upload/put?key=${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { cookie },
    body: buf,
  });
  if (!r.ok) throw new Error(`put ${key}: ${r.status} ${await r.text()}`);
}

async function putMultipart(key, buf) {
  const create = await fetch(`${BASE}/api/upload/mpu-create?key=${encodeURIComponent(key)}`, {
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
        `${BASE}/api/upload/mpu-part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&part=${i + 1}`,
        { method: 'PUT', headers: { cookie }, body: chunk }
      );
      if (!r.ok) throw new Error(`part ${i + 1}: ${r.status}`);
      parts[i] = { partNumber: i + 1, etag: (await r.json()).etag };
      process.stdout.write(`  part ${i + 1}/${numParts}\r`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, numParts) }, worker));

  const done = await fetch(`${BASE}/api/upload/mpu-complete`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ key, uploadId, parts }),
  });
  if (!done.ok) throw new Error(`mpu-complete ${key}: ${await done.text()}`);
  process.stdout.write('\n');
}

for (const rel of walk(dir)) {
  const buf = readFileSync(join(dir, rel));
  const key = `${prefix}/${rel.split('\\').join('/')}`;
  console.log(`upload ${key} (${(buf.length / 1048576).toFixed(1)} MB)`);
  if (buf.length <= PART) await putSmall(key, buf);
  else await putMultipart(key, buf);
}
console.log('done');
