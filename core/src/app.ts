import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { AppContext } from './context.js';
import { loggerOptions } from './logger.js';
import { registerSecurityHeaders } from './security/headers.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerAgentUiRoutes } from './agents/routes.js';
import { registerAgentProtocolRoutes } from './agent/routes.js';
import { registerServiceRoutes } from './services/routes.js';
import { registerPublicEndpointRoutes } from './public-endpoints/index.js';
import { registerAiRoutes, registerAiChatgptCallback } from './ai/index.js';
import { registerHealthRoutes } from './health/routes.js';
import { registerWebApp } from './web/static.js';
import { ApiError } from './lib/errors.js';

export const API_PREFIX = '/api/v1';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(ctx.config),
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  // Opaque session cookie; nothing is signed, the id is a random secret itself.
  await app.register(cookie);
  registerSecurityHeaders(app, ctx.config);

  await app.register(
    async (api) => {
      registerHealthRoutes(api, ctx);
      registerAuthRoutes(api, ctx);
      registerAgentUiRoutes(api, ctx);
      registerAgentProtocolRoutes(api, ctx);
      registerServiceRoutes(api, ctx);
      registerPublicEndpointRoutes(api, ctx);
      registerAiRoutes(api, ctx);
    },
    { prefix: API_PREFIX },
  );

  await registerWebApp(app, ctx.config);

  // Official SIWC loopback callback (root path, outside /api/v1): the SIWC
  // registration pins `/auth/callback`; only the port may vary.
  registerAiChatgptCallback(app, ctx);

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.statusCode).send({ code: error.code, message: error.message });
      return;
    }
    const failure = error as { statusCode?: number; code?: string; message?: string };
    const statusCode = failure.statusCode ?? 500;
    if (statusCode >= 400 && statusCode < 500) {
      const code = statusCode === 400 ? 'INVALID_BODY' : (failure.code ?? 'BAD_REQUEST');
      const message = statusCode === 400 ? 'Invalid request body' : (failure.message ?? 'Request failed');
      reply.code(statusCode).send({ code, message });
      return;
    }
    req.log.error({ err: error }, 'unhandled error');
    reply.code(500).send({ code: 'INTERNAL', message: 'Internal server error' });
  });

  return app;
}
