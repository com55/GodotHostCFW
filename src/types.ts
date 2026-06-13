export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  JWT_SECRET: string;
  ARCHIVE_URL: string;
  ARCHIVE_SECRET: string;
}

/** Hono typing: bindings + per-request variables. */
export interface AppEnv {
  Bindings: Env;
  Variables: { user: unknown };
}

export interface GameVersion {
  version: number;
  uploadedAt: string;
  fileSize: number;
  folderName: string;
  storage: 'r2' | 'local' | 'restoring';
  hasLocalCopy: boolean;
}

export interface Game {
  id: string;
  slug: string;
  title: string;
  description: string;
  visibility: 'public' | 'private';
  accessCode: string;
  activeVersion: number;
  versions: GameVersion[];
  createdAt: string;
  updatedAt: string;
}
