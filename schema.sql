-- Godot Host (Cloudflare) schema
-- Metadata only. Game files live in R2 under games/<slug>/v<n>/...

CREATE TABLE IF NOT EXISTS games (
  id             TEXT PRIMARY KEY,
  slug           TEXT UNIQUE NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  visibility     TEXT NOT NULL DEFAULT 'public',   -- 'public' | 'private'
  access_code    TEXT NOT NULL DEFAULT '',
  active_version INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  game_id     TEXT NOT NULL,
  version     INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL,
  file_size   INTEGER NOT NULL DEFAULT 0,
  icon_path   TEXT NOT NULL DEFAULT '',            -- file within the version used as favicon
  status      TEXT NOT NULL DEFAULT 'pending',     -- 'pending' | 'ready'
  PRIMARY KEY (game_id, version),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_games_slug ON games(slug);
