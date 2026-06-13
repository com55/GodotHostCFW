import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { sign, verify } from 'hono/jwt';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppEnv } from '../types';

export const auth = new Hono<AppEnv>();

const WEEK = 7 * 24 * 60 * 60;

/** Middleware: require a valid admin JWT cookie. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, 'token');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  try {
    c.set('user', await verify(token, c.env.JWT_SECRET, 'HS256'));
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};

auth.post('/login', async (c) => {
  const { username, password } = await c.req.json<{ username?: string; password?: string }>();

  if (username !== c.env.ADMIN_USERNAME || password !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const token = await sign(
    { username, role: 'admin', exp: Math.floor(Date.now() / 1000) + WEEK },
    c.env.JWT_SECRET
  );

  setCookie(c, 'token', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    secure: true,
    maxAge: WEEK,
  });

  return c.json({ success: true, username });
});

auth.post('/logout', (c) => {
  deleteCookie(c, 'token', { path: '/' });
  return c.json({ success: true });
});

auth.get('/me', requireAuth, (c) => {
  return c.json({ authenticated: true, user: c.get('user') });
});
