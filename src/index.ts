import { Hono } from 'hono';
import type { AppEnv } from './types';
import { auth } from './routes/auth';
import { games } from './routes/games';
import { upload } from './routes/upload';
import { serve } from './routes/serve';

const app = new Hono<AppEnv>();

app.route('/api/auth', auth);
app.route('/api/games', games);
app.route('/api/upload', upload);

// Player shell (/play/:slug) and game files (/g/:slug/v:n/*)
app.route('/', serve);

export default app;
