# Godot Host (Cloudflare)

Self-hosted platform for Godot 4 **Web** exports, rebuilt on Cloudflare so games
are served straight from R2 at the edge — fast, cached, and cheap — instead of
from a single home server behind a tunnel.

This is the Cloudflare rewrite of the original Node/Fastify project. Same
features (admin dashboard, public/private games, versioning, large uploads), new
runtime.

## Architecture

| Concern | Implementation |
|---|---|
| API + routing | Cloudflare **Worker** (Hono) |
| Game files | **R2** bucket `godot-games`, keys `games/<slug>/v<n>/<file>` |
| Metadata | **D1** database `godot_host` (`games`, `versions`) |
| Dashboard + player UI | **Worker Static Assets** (`./public`) |
| ZIP extraction | **In the browser** (fflate) — no server-side unzip |
| Large uploads | **R2 multipart** with parallel parts (chunked + concurrent) |

**Upload flow:** the dashboard unzips the Godot export in the browser, then
uploads each extracted file to R2. Files larger than 25 MB use R2 multipart
uploads with 4 parts in flight at once. The Worker only streams parts into R2.

**Serving:** games run in an iframe pointed at `/g/<slug>/v<n>/index.html`.
Because the version is in the path, every response is immutable and cached hard
(`max-age=31536000, immutable`). Game files carry the `Cross-Origin-Opener-Policy`
/ `Cross-Origin-Embedder-Policy` headers Godot needs for `SharedArrayBuffer`.

## One-time setup

Requires a Cloudflare account and `wrangler` logged in (`npx wrangler login`).

```bash
npm install

# 1. Create the R2 bucket
npx wrangler r2 bucket create godot-games

# 2. Create the D1 database, then paste the printed database_id into wrangler.jsonc
npx wrangler d1 create godot_host

# 3. Apply the schema
npm run db:schema          # remote (production)
npm run db:schema:local    # local dev

# 4. Set secrets (production)
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put JWT_SECRET     # any random 32+ char string
# ADMIN_USERNAME is a plain var in wrangler.jsonc (default: admin)
```

For local dev, copy `.dev.vars.example` to `.dev.vars` and fill in the values.

## Develop

```bash
npm run dev        # wrangler dev (local Worker + local R2/D1)
```

## Deploy

```bash
npm run deploy
```

After the first deploy, add a custom domain/route to the Worker in the Cloudflare
dashboard (or `wrangler` routes) so games are served from your own hostname.

## Migrating from the old project

The old project stored games on disk (`data/games/<slug>/v<n>/`) with metadata in
`data/db.json`. Migration is two steps: copy the files into R2, then load the
metadata into D1. The Worker must already be deployed with secrets set.

### 1. Upload game files to R2

`wrangler r2 object put` is capped at **300 MiB per file**, and Godot `.pck`
files routinely exceed that. So `put-dir.mjs` uploads a whole version folder
(any file size) through the deployed Worker's multipart API instead:

```bash
WORKER_URL=https://<your-worker>.workers.dev \
ADMIN_USERNAME=admin ADMIN_PASSWORD=<your-admin-password> \
  node scripts/put-dir.mjs /path/to/old/data/games/<slug>/v<n> games/<slug>/v<n>
```

### 2. Load metadata into D1

`migrate.mjs` reads `db.json` and writes `migrate.sql`:

```bash
# --active-only : only the game's active version (skip old history)
# --sql-only    : just write migrate.sql, don't upload (files done in step 1)
node scripts/migrate.mjs /path/to/old/data --active-only --sql-only
npx wrangler d1 execute godot_host --remote --file=./migrate.sql
```

Notes:
- Without `--sql-only`, `migrate.mjs` also uploads files via
  `wrangler r2 object put` — convenient for small games, but it fails on files
  >300 MiB. For large games, use `put-dir.mjs` (step 1) + `migrate.mjs --sql-only`.
- `migrate.sql` may contain private access codes, so it is gitignored.

## Notes / limits

- **Browser memory:** the whole export is decompressed in the browser during
  upload. Multi-GB single games may strain low-memory devices; upload from a
  desktop.
- **COOP/COEP** are set only on game files, matching the original. Godot
  single-threaded web exports work as-is; multi-threaded exports rely on these
  headers for cross-origin isolation.
- **Building on the Pi:** `wrangler deploy` and `npx tsc --noEmit` both work on a
  Raspberry Pi. `wrangler types` spawns `workerd` and can OOM (48-bit VA /
  tcmalloc) — it is not required, since `Env` is declared in `src/types.ts`. If
  `wrangler dev` ever hits the same limit, run it from the PC.
