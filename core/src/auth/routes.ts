import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ApiError } from '../lib/errors.js';
import { parseBody } from '../lib/validate.js';
import { bootstrap, isInitialized, login } from './service.js';
import { clearSessionCookie, destroySession, setSessionCookie } from './session.js';
import { requireAuth, requireCsrf, requireOrigin } from '../http/guards.js';

const bootstrapSchema = z.object({
  token: z.string().min(1).max(1024),
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
});

const loginSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
});

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx;

  app.get('/auth/status', async () => ({ initialized: await isInitialized(db) }));

  app.post('/auth/bootstrap', { preHandler: requireOrigin(config) }, async (req, reply) => {
    const limit = ctx.bootstrapLimiter.check(req.ip);
    if (!limit.allowed) {
      reply.header('retry-after', String(limit.retryAfterSeconds));
      throw new ApiError(429, 'RATE_LIMITED', 'Too many bootstrap attempts');
    }
    const body = parseBody(bootstrapSchema, req.body);
    const result = await bootstrap(db, config, body, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(reply, config, result.session);
    reply.code(201);
    return { user: { email: result.email }, csrfToken: result.session.csrfToken };
  });

  app.post('/auth/login', { preHandler: requireOrigin(config) }, async (req, reply) => {
    const limit = ctx.loginLimiter.check(req.ip);
    if (!limit.allowed) {
      reply.header('retry-after', String(limit.retryAfterSeconds));
      throw new ApiError(429, 'RATE_LIMITED', 'Too many login attempts');
    }
    const body = parseBody(loginSchema, req.body);
    const result = await login(db, config, body, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(reply, config, result.session);
    return { user: { email: result.email }, csrfToken: result.session.csrfToken };
  });

  app.get('/auth/me', { preHandler: requireAuth(db, config) }, async (req) => {
    const auth = req.auth;
    if (!auth) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
    return { user: { email: auth.user.email }, csrfToken: auth.csrfToken };
  });

  app.post(
    '/auth/logout',
    { preHandler: [requireAuth(db, config), requireOrigin(config), requireCsrf()] },
    async (req, reply) => {
      const auth = req.auth;
      if (auth) await destroySession(db, auth.sessionId);
      clearSessionCookie(reply, config);
      reply.code(204);
      return null;
    },
  );
}
