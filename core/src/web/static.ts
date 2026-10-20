import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from '../config.js';

/**
 * Serves the built SPA from Core (same origin as the API). In development the
 * Vite dev server proxies `/api` here instead, so a missing build is not fatal.
 * Non-API GET/HEAD misses fall back to `index.html` (client-side routing).
 */
export async function registerWebApp(app: FastifyInstance, config: AppConfig): Promise<void> {
  const root = config.webDistDir;
  const hasBuild = existsSync(join(root, 'index.html'));

  if (hasBuild) {
    await app.register(fastifyStatic, {
      root,
      prefix: '/',
      index: ['index.html'],
      // Dynamic `/*` route: every request re-resolves the path under `root`.
      // `wildcard: false` would glob the directory once at startup and register
      // one route per known file, so a `vite build` while Core is running (new
      // hashed asset names) made every JS/CSS request fall through to the SPA
      // fallback — HTML with the wrong content type instead of the asset.
      // API routes are unaffected: exact `/api/v1/...` paths win over `/*`, and
      // unknown API paths still reach the JSON 404 handler below.
      wildcard: true,
    });
  } else {
    app.log.warn({ root }, 'web build not found — serving API only (run the Vite dev server)');
  }

  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith('/api/');
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (!isApi && isRead && hasBuild && app.hasReplyDecorator('sendFile')) {
      return reply.type('text/html').sendFile('index.html');
    }
    reply.code(404).send({ code: 'NOT_FOUND', message: 'Not found' });
  });
}
