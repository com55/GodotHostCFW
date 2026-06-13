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

The old project stored games on disk (`data/games/`) with metadata in
`data/db.json`. To move them:

```bash
# Uploads every file to R2 and writes migrate.sql for the metadata
node scripts/migrate.mjs /path/to/old/your-game-data/data

# Load the metadata into D1
npx wrangler d1 execute godot_host --remote --file=./migrate.sql
```

Run the migration where `wrangler` is authenticated. If the Raspberry Pi runs
out of memory on large `.pck` uploads, run it from the PC instead.

## Notes / limits

- **Browser memory:** the whole export is decompressed in the browser during
  upload. Multi-GB single games may strain low-memory devices; upload from a
  desktop.
- **COOP/COEP** are set only on game files, matching the original. Godot
  single-threaded web exports work as-is; multi-threaded exports rely on these
  headers for cross-origin isolation.
- **Building on the Pi:** `wrangler dev/deploy` invoke `workerd`, which can OOM
  on a Raspberry Pi (48-bit VA / tcmalloc). Typecheck works (`npx tsc --noEmit`);
  run `wrangler dev`/`deploy` from the PC if the Pi can't.
