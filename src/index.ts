import { Hono } from 'hono';
import type { AppEnv, Env } from './types';
import { auth } from './routes/auth';
import { games } from './routes/games';
import { upload } from './routes/upload';
import { serve } from './routes/serve';
import { internal } from './routes/internal';
import { runCron } from './cron';

const app = new Hono<AppEnv>();

app.route('/api/auth', auth);
app.route('/api/games', games);
app.route('/api/upload', upload);
app.route('/api/internal', internal);

// Player shell (/play/:slug) and game files (/g/:slug/v:n/*)
app.route('/', serve);

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env));
  },
};
