export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  JWT_SECRET: string;
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
