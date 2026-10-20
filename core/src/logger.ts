import type { FastifyServerOptions } from 'fastify';
import type { AppConfig } from './config.js';

/**
 * Structured logging with secret redaction. Passwords, cookies, Bearer tokens,
 * CSRF tokens, enroll/bootstrap tokens and agent credentials must never reach
 * the aggregated logs (docs/security.md §3, §7).
 */
export function loggerOptions(config: AppConfig): FastifyServerOptions['logger'] {
  if (config.logLevel === 'silent') return false;
  return {
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'req.headers["x-requested-with"]',
        'res.headers["set-cookie"]',
        'body.password',
        'body.token',
        'body.enroll_token',
        'body.credential',
        'body.new_credential',
        '*.password',
        '*.token',
        '*.enroll_token',
        '*.credential',
        '*.new_credential',
      ],
      censor: '[REDACTED]',
    },
  };
}
