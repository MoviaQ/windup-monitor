import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

/**
 * Security headers for the SPA and API (docs/security.md §8). HSTS is only set
 * when the deployment is actually behind TLS (COOKIE_SECURE), so plain-LAN HTTP
 * access is not locked out.
 */
export function registerSecurityHeaders(app: FastifyInstance, config: AppConfig): void {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', csp);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    if (config.cookieSecure) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });
}
