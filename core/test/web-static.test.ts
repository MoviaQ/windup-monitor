import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createContext } from '../src/context.js';
import { createPrismaClient, type Db } from '../src/db/client.js';
import { testConfig, testTmpRoot } from './helpers.js';

/**
 * Regression: the SPA build must survive a `vite build` while Core is running.
 *
 * With `wildcard: false`, `@fastify/static` globs the web build once at startup
 * and registers a route per known file. Any asset created afterwards (every
 * Vite build re-hashes `index-*.js` / `index-*.css`) missed the route table and
 * fell through to the SPA fallback, so the published page received HTML with a
 * `text/html` content type instead of its script — a blank app behind
 * `https://…:18443/`.
 */

const INDEX_HTML = [
  '<!doctype html>',
  '<html lang="pl"><head><meta charset="UTF-8" /><title>wind-up monitor</title>',
  '<script type="module" crossorigin src="/assets/index-startup.js"></script>',
  '<link rel="stylesheet" crossorigin href="/assets/index-startup.css" />',
  '</head><body><div id="root"></div></body></html>',
  '',
].join('\n');

const STARTUP_JS = 'console.log("build-obecny-przy-starciu");\n';
const STARTUP_CSS = ':root{--startup:true}\n';
const FRESH_JS = 'console.log("build-dodany-po-starciu");\n';
const FRESH_CSS = ':root{--fresh:true}\n';

// Per-process scratch dir (see helpers.testTmpRoot): removed on exit, never
// shared between concurrent vitest runs.
const fixtureDir = join(testTmpRoot(), 'web-static-fixture');

let app: FastifyInstance;
let db: Db;

beforeEach(async () => {
  const config = { ...testConfig(), webDistDir: fixtureDir };

  await mkdir(join(fixtureDir, 'assets'), { recursive: true });
  await writeFile(join(fixtureDir, 'index.html'), INDEX_HTML);
  await writeFile(join(fixtureDir, 'assets', 'index-startup.js'), STARTUP_JS);
  await writeFile(join(fixtureDir, 'assets', 'index-startup.css'), STARTUP_CSS);

  db = createPrismaClient(config.databaseUrl);
  app = await buildApp(createContext(config, db, Date.now));
  await app.ready();

  // Registered routes are frozen at this point; these files simulate a frontend
  // rebuild happening while the Core process keeps running.
  await writeFile(join(fixtureDir, 'assets', 'index-freshhash.js'), FRESH_JS);
  await writeFile(join(fixtureDir, 'assets', 'index-freshhash.css'), FRESH_CSS);
});

afterEach(async () => {
  await app.close();
  await db.$disconnect();
});

describe('static SPA serving', () => {
  it('serves hashed assets created after app startup with the right MIME and body', async () => {
    const js = await app.inject({ method: 'GET', url: '/assets/index-freshhash.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/^application\/javascript/);
    expect(js.body).toBe(FRESH_JS);

    const css = await app.inject({ method: 'GET', url: '/assets/index-freshhash.css' });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toMatch(/^text\/css/);
    expect(css.body).toBe(FRESH_CSS);
  });

  it('keeps serving assets that existed when the app started', async () => {
    const js = await app.inject({ method: 'GET', url: '/assets/index-startup.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/^application\/javascript/);
    expect(js.body).toBe(STARTUP_JS);
  });

  it('serves index.html for the root and for SPA routes, never for assets', async () => {
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.headers['content-type']).toMatch(/^text\/html/);
    expect(root.body).toContain('<div id="root">');

    const spa = await app.inject({ method: 'GET', url: '/services/whatever' });
    expect(spa.statusCode).toBe(200);
    expect(spa.headers['content-type']).toMatch(/^text\/html/);
    expect(spa.body).toContain('<div id="root">');
    expect(spa.body).not.toBe(FRESH_JS);
  });

  it('does not shadow API routes', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['content-type']).toMatch(/^application\/json/);
    expect(health.json()).toEqual({ status: 'ok' });

    const status = await app.inject({ method: 'GET', url: '/api/v1/auth/status' });
    expect(status.statusCode).toBe(200);
    expect(status.headers['content-type']).toMatch(/^application\/json/);
    expect(typeof (status.json() as { initialized: boolean }).initialized).toBe('boolean');
  });

  it('keeps returning JSON 404 for unknown API paths (GET and POST)', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/v1/definitely-not-a-route' });
    expect(get.statusCode).toBe(404);
    expect(get.headers['content-type']).toMatch(/^application\/json/);
    expect(get.json()).toMatchObject({ code: 'NOT_FOUND' });

    const post = await app.inject({ method: 'POST', url: '/api/v1/definitely-not-a-route', payload: {} });
    expect(post.statusCode).toBe(404);
    expect(post.headers['content-type']).toMatch(/^application\/json/);
    expect(post.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns JSON 404 for unknown non-API methods too', async () => {
    const del = await app.inject({ method: 'DELETE', url: '/assets/index-freshhash.js' });
    expect(del.statusCode).toBe(404);
    expect(del.headers['content-type']).toMatch(/^application\/json/);
  });
});
