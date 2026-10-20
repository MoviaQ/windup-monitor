import { stat } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loggerOptions } from '../src/logger.js';
import { createPrismaClient } from '../src/db/client.js';
import { createContext } from '../src/context.js';
import { buildApp } from '../src/app.js';
import {
  bootstrapAdmin,
  createHarness,
  resetDb,
  seedBootstrapToken,
  testConfig,
  type Harness,
} from './helpers.js';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  await resetDb(h.db);
});

afterEach(async () => {
  await h.close();
});

describe('health', () => {
  it('liveness does not touch the database', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('readiness verifies PostgreSQL', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok' } });
  });

  it('readiness returns 503 when the database is unreachable', async () => {
    const config = {
      ...testConfig(),
      databaseUrl: 'postgresql://statuspilot:statuspilot@127.0.0.1:59999/nope?schema=public',
    };
    const badDb = createPrismaClient(config.databaseUrl);
    const app = await buildApp(createContext(config, badDb));
    try {
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ status: 'unavailable', checks: { database: 'error' } });
    } finally {
      await app.close();
      await badDb.$disconnect();
    }
  });
});

describe('security headers + secrets', () => {
  it('sets the SPA security headers (and no HSTS on plain HTTP)', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('redacts secrets in structured logs', () => {
    const options = loggerOptions({ ...testConfig(), logLevel: 'info' });
    expect(options).not.toBe(false);
    const paths = typeof options === 'object' && options !== null && 'redact' in options
      ? (options.redact as { paths: string[] }).paths
      : [];
    expect(paths).toContain('req.headers.authorization');
    expect(paths).toContain('req.headers.cookie');
    expect(paths).toContain('req.headers["x-csrf-token"]');
    expect(paths).toContain('body.password');
    expect(paths).toContain('body.credential');
  });

  it('writes the bootstrap token to a 0600 file', async () => {
    await seedBootstrapToken(h.db, h.config);
    const info = await stat(h.config.bootstrapTokenFile);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('never stores plaintext passwords, bootstrap tokens or agent credentials in audit_log', async () => {
    const token = await seedBootstrapToken(h.db, h.config);
    const password = 'correct horse battery staple';
    await bootstrapAdmin(h, { password });
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://localhost:8080' },
      payload: { email: 'admin@example.test', password },
    });

    const rows = await h.db.auditLog.findMany();
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(password);
    expect(dump).not.toContain(token);
    expect(dump.toLowerCase()).not.toContain('argon2');
  });
});
