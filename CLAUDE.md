# Godot Host (Cloudflare)

Self-hosted Godot 4 web-export platform on Cloudflare. See README.md for setup.

## Stack & layout
- Worker (Hono) + R2 (game files) + D1 (metadata) + Worker Static Assets (UI).
- `src/` Worker code · `public/` static dashboard+player · `scripts/` migration.
- ZIP is extracted **in the browser** (fflate); files upload to R2 via parallel multipart.

## Routing (wrangler.jsonc `run_worker_first`)
- Worker handles `/api/*`, `/g/*`, `/play/*`; everything else is a static asset.
- Dashboard = `public/index.html` at `/`. Player shell = Worker fetching ASSETS
  `/player/` (directory form — fetching `/player/index.html` 307-redirects).
- Game files: `/g/<slug>/v<n>/*` → R2 key `games/<slug>/v<n>/...`, served with
  COOP/COEP + `immutable` cache. Version is in the path → responses are immutable.

## Conventions
- `Env`/`AppEnv` are declared in `src/types.ts`; do not depend on `wrangler types`.
- D1 rows are snake_case; `src/db.ts` maps them to camelCase. API response shapes
  must match what `public/dashboard/app.js` expects (e.g. `game.versions[]`).
- `public/dashboard/app.js` is `type="module"`; run `npm run vendor` after
  `npm install` to copy fflate into `public/dashboard/vendor/`.
- hono/jwt: `verify(token, secret, 'HS256')` — the alg arg is required.
- Repo is public: keep README/comments environment-neutral (no host specifics).

## Build / verify (no deploy needed)
- `npx tsc --noEmit` — typecheck.
- `npx wrangler deploy --dry-run` — validate bundle + bindings.
- Avoid `npx wrangler types` — spawns workerd, OOMs on low-mem/ARM, not needed.

## Secrets
- Secrets via `wrangler secret put`: `ADMIN_PASSWORD`, `JWT_SECRET`, `ARCHIVE_URL`,
  `ARCHIVE_SECRET`. `ADMIN_USERNAME` is a var in wrangler.jsonc.
- Custom domains: managed via CF dashboard — not stored in wrangler.jsonc.
- Local dev: copy `.dev.vars.example` → `.dev.vars`.

## Migration gotcha
- `wrangler r2 object put` caps files at 300 MiB — Godot `.pck` exceeds this.
  Large files: `scripts/put-dir.mjs` (Worker multipart API). Metadata:
  `node scripts/migrate.mjs <data> --active-only --sql-only`. `migrate.sql` is
  gitignored (contains access codes).
