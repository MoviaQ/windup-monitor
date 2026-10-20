import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createPrismaClient } from '../src/db/client.js';
import { createContext } from '../src/context.js';
import { buildApp } from '../src/app.js';
import {
  authHeaders,
  bootstrapAdmin,
  createHarness,
  resetDb,
  testTmpRoot,
  type Harness,
  type Session,
} from './helpers.js';
import { recordAiUsage } from '../src/ai/usage.js';

/** Harness with per-case env overrides (same rules as helpers.testConfig). */
async function aiHarness(envOverrides: Record<string, string> = {}): Promise<Harness> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789abcdef',
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'silent',
    BOOTSTRAP_TOKEN_FILE: join(testTmpRoot(), 'bootstrap-token'),
    WEB_DIST_DIR: join(testTmpRoot(), 'no-web-build'),
    ALLOWED_ORIGINS: 'http://localhost:8080',
    AI_CREDENTIAL_KEY: 'test-ai-credential-key-0123456789abcdef',
    ...envOverrides,
  });
  const db = createPrismaClient(config.databaseUrl);
  const app = await buildApp(createContext(config, db));
  await app.ready();
  return {
    app,
    db,
    config,
    close: async () => {
      await app.close();
      await db.$disconnect();
    },
  };
}

interface Stub {
  url: string;
  requests: Array<{ url: string; authorization: string | undefined }>;
  respond: (status: number, body?: string, headers?: Record<string, string>) => void;
  close: () => Promise<void>;
}

async function startStub(initialStatus = 200): Promise<Stub> {
  const requests: Stub['requests'] = [];
  let handler: (res: ServerResponse) => void = (res) => res.end('{}');
  const server: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', authorization: req.headers.authorization });
    handler(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const stub: Stub = {
    url: `http://127.0.0.1:${port}`,
    requests,
    respond: (status, body = '{}', headers = {}) => {
      handler = (res) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(body);
      };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  stub.respond(initialStatus);
  return stub;
}

describe('AI settings API', () => {
  let harness: Harness;
  let session: Session;

  beforeEach(async () => {
    harness = await createHarness();
    await resetDb(harness.db);
    session = await bootstrapAdmin(harness);
  });

  afterEach(async () => {
    await harness.close();
  });

  const getSettings = (app: FastifyInstance, s: Session) =>
    app.inject({ method: 'GET', url: '/api/v1/ai/settings', headers: authHeaders(harness.config, s) });

  it('requires a session and returns honest defaults', async () => {
    const anon = await harness.app.inject({ method: 'GET', url: '/api/v1/ai/settings' });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toMatchObject({ code: 'UNAUTHENTICATED' });

    const res = await getSettings(harness.app, session);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settings).toEqual({
      provider: null,
      model: null,
      autoFree: false,
      executionMode: 'approval_required',
      customName: null,
      baseUrl: null,
      customBaseUrl: null,
    });
    expect(body.connections).toHaveLength(4);
    expect(body.connections.map((c: { provider: string }) => c.provider).sort()).toEqual([
      'chatgpt',
      'custom',
      'openai',
      'openrouter',
    ]);
    for (const conn of body.connections) {
      expect(conn.connected).toBe(false);
      expect(conn.keyHint).toBeNull();
      expect(conn.lastCheckedAt).toBeNull();
    }
    expect(body.capabilities.credentialStorage).toBe(true);
  });

  it('rejects mutations without CSRF and unknown providers', async () => {
    const noCsrf = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/settings',
      headers: { cookie: `sp_session=${session.cookie}`, origin: 'http://localhost:8080' },
      payload: { executionMode: 'autonomous' },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ code: 'CSRF_INVALID' });

    const badProvider = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/settings',
      headers: authHeaders(harness.config, session),
      payload: { provider: 'gemini' },
    });
    expect(badProvider.statusCode).toBe(400);
  });

  it('validates model/free/default mode resolution', async () => {
    // Model without provider.
    const modelOnly = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/settings',
      headers: authHeaders(harness.config, session),
      payload: { model: 'openai/gpt-4o' },
    });
    expect(modelOnly.statusCode).toBe(400);

    // Provider without model.
    const noModel = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/settings',
      headers: authHeaders(harness.config, session),
      payload: { provider: 'openrouter' },
    });
    expect(noModel.statusCode).toBe(400);

    // autoFree resolves the model to openrouter/free (never a paid fallback).
    const autoFree = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/settings',
      headers: authHeaders(harness.config, session),
      payload: { provider: 'openrouter', autoFree: true },
    });
    expect(autoFree.statusCode).toBe(200);
    expect(autoFree.json().settings).toMatchObject({
      provider: 'openrouter',
      model: 'openrouter/free',
      autoFree: true,
      executionMode: 'approval_required',
    });

    // A conflicting explicit model is rejected, not silently overridden.
    const conflict = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/settings',
      headers: authHeaders(harness.config, session),
      payload: { provider: 'openrouter', autoFree: true, model: 'openai/gpt-4o' },
    });
    expect(conflict.statusCode).toBe(400);

    // Custom provider requires a base URL.
    const customNoUrl = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/settings',
      headers: authHeaders(harness.config, session),
      payload: { provider: 'custom', model: 'local-model' },
    });
    expect(customNoUrl.statusCode).toBe(400);

    // Partial patch keeps previous fields (absent fields keep their value —
    // including autoFree, which only resolves models for OpenRouter).
    const manual = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/settings',
      headers: authHeaders(harness.config, session),
      payload: { provider: 'openai', model: 'gpt-4o-mini', executionMode: 'monitor_only' },
    });
    expect(manual.statusCode).toBe(200);
    expect(manual.json().settings).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
      autoFree: true,
      executionMode: 'monitor_only',
    });

    const modeOnly = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/settings',
      headers: authHeaders(harness.config, session),
      payload: { executionMode: 'autonomous' },
    });
    expect(modeOnly.statusCode).toBe(200);
    expect(modeOnly.json().settings).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
      executionMode: 'autonomous',
    });

    const badMode = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/settings',
      headers: authHeaders(harness.config, session),
      payload: { executionMode: 'yolo' },
    });
    expect(badMode.statusCode).toBe(400);
  });

  it('accepts the customBaseUrl alias and rejects conflicting aliases', async () => {
    const viaAlias = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/settings',
      headers: authHeaders(harness.config, session),
      payload: {
        provider: 'custom',
        model: 'local-model',
        customName: 'Local llama',
        customBaseUrl: 'http://127.0.0.1:11434',
      },
    });
    expect(viaAlias.statusCode).toBe(200);
    expect(viaAlias.json().settings).toMatchObject({
      customName: 'Local llama',
      baseUrl: 'http://127.0.0.1:11434',
      customBaseUrl: 'http://127.0.0.1:11434',
    });

    const conflict = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/settings',
      headers: authHeaders(harness.config, session),
      payload: { baseUrl: 'http://127.0.0.1:1', customBaseUrl: 'http://127.0.0.1:2' },
    });
    expect(conflict.statusCode).toBe(400);
  });

  it('stores API keys encrypted and never returns them', async () => {
    const apiKey = 'sk-or-v1-0123456789abcdef0123456789abcdef';
    const put = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/connections/openrouter',
      headers: authHeaders(harness.config, session),
      payload: { apiKey },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json();
    expect(JSON.stringify(body)).not.toContain(apiKey);
    const conn = body.connections.find((c: { provider: string }) => c.provider === 'openrouter');
    expect(conn.connected).toBe(true);
    expect(conn.keyHint).toBe('sk-o…cdef');

    // Ciphertext at rest never contains the plaintext key.
    const rows = await harness.db.aiCredential.findMany({ where: { provider: 'openrouter' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ciphertext).not.toContain(apiKey);
    expect(rows[0]!.ciphertext.startsWith('v1.')).toBe(true);

    // Read path is stable and still masked.
    const again = await getSettings(harness.app, session);
    const conn2 = again.json().connections.find((c: { provider: string }) => c.provider === 'openrouter');
    expect(conn2.connected).toBe(true);
    expect(conn2.keyHint).toBe('sk-o…cdef');

    const del = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/ai/connections/openrouter',
      headers: authHeaders(harness.config, session),
    });
    expect(del.statusCode).toBe(200);
    const conn3 = del.json().connections.find((c: { provider: string }) => c.provider === 'openrouter');
    expect(conn3.connected).toBe(false);
    expect(conn3.keyHint).toBeNull();
  });

  it('distinguishes unchanged, replaced and removed custom keys', async () => {
    const withKey = 'local-secret-key-1234567890';
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/connections/custom',
      headers: authHeaders(harness.config, session),
      payload: { baseUrl: 'http://127.0.0.1:11434', name: 'Local', apiKey: withKey },
    });

    // Absent apiKey → unchanged.
    const unchanged = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/connections/custom',
      headers: authHeaders(harness.config, session),
      payload: { baseUrl: 'http://127.0.0.1:11434' },
    });
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json().connections.find((c: { provider: string }) => c.provider === 'custom').keyHint).toBe(
      'loca…7890',
    );

    // '' → key removed, base URL and name stay (keyless local servers work).
    const removed = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/connections/custom',
      headers: authHeaders(harness.config, session),
      payload: { baseUrl: 'http://127.0.0.1:11434', name: 'Local', apiKey: '' },
    });
    expect(removed.statusCode).toBe(200);
    const conn = removed.json().connections.find((c: { provider: string }) => c.provider === 'custom');
    expect(conn.connected).toBe(true); // base URL configured
    expect(conn.keyHint).toBeNull();
    expect(removed.json().settings).toMatchObject({ customName: 'Local', customBaseUrl: 'http://127.0.0.1:11434' });
    expect(await harness.db.aiCredential.count({ where: { provider: 'custom' } })).toBe(0);

    // chatgpt on the key endpoints is rejected (its own login/logout flow).
    const chatgptPut = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/connections/chatgpt',
      headers: authHeaders(harness.config, session),
      payload: { apiKey: 'x' },
    });
    expect(chatgptPut.statusCode).toBe(400);
    const chatgptDel = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/ai/connections/chatgpt',
      headers: authHeaders(harness.config, session),
    });
    expect(chatgptDel.statusCode).toBe(400);
    const chatgptTest = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/ai/connections/chatgpt/test',
      headers: authHeaders(harness.config, session),
      payload: {},
    });
    expect(chatgptTest.statusCode).toBe(400);
  });

  it('DELETE custom fully disconnects: key + config + selection, mode stays', async () => {
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/connections/custom',
      headers: authHeaders(harness.config, session),
      payload: { baseUrl: 'http://127.0.0.1:11434', name: 'Local', apiKey: 'local-secret-key-1234567890' },
    });
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/settings',
      headers: authHeaders(harness.config, session),
      payload: { provider: 'custom', model: 'local-model', executionMode: 'monitor_only' },
    });

    const del = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/ai/connections/custom',
      headers: authHeaders(harness.config, session),
    });
    expect(del.statusCode).toBe(200);
    const body = del.json();
    // Credential gone and custom config gone — not "connected with empty key".
    expect(await harness.db.aiCredential.count({ where: { provider: 'custom' } })).toBe(0);
    expect(body.settings).toMatchObject({
      provider: null,
      model: null,
      customName: null,
      baseUrl: null,
      customBaseUrl: null,
      executionMode: 'monitor_only',
    });
    expect(body.connections.find((c: { provider: string }) => c.provider === 'custom').connected).toBe(false);
  });

  it('rejects SSRF-unsafe custom base URLs', async () => {
    for (const baseUrl of [
      'http://169.254.169.254/latest/meta-data',
      'http://[::ffff:169.254.169.254]/',
      'http://[::ffff:a9fe:a9fe]/', // same address in the URL parser's hex form
      'http://user:pass@127.0.0.1:11434',
      'http://127.0.0.1:11434?token=1',
      'http://127.0.0.1:11434#frag',
      'ftp://127.0.0.1:11434',
      'http://[fe80::1]/',
    ]) {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/v1/ai/connections/custom',
        headers: authHeaders(harness.config, session),
        payload: { baseUrl },
      });
      expect(res.statusCode, baseUrl).toBe(400);
    }
  });
});

describe('AI connection tests (provider stubs, no inference)', () => {
  let harness: Harness;
  let session: Session;
  let stub: Stub;

  beforeEach(async () => {
    stub = await startStub(200);
    harness = await aiHarness({
      OPENROUTER_BASE_URL: `${stub.url}/api/v1`,
      OPENAI_BASE_URL: `${stub.url}/v1`,
    });
    await resetDb(harness.db);
    session = await bootstrapAdmin(harness);
  });

  afterEach(async () => {
    await harness.close();
    await stub.close();
  });

  const auth = () => authHeaders(harness.config, session);

  it('checks OpenRouter via GET /key and OpenAI via GET /models', async () => {
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/connections/openrouter',
      headers: auth(),
      payload: { apiKey: 'sk-or-v1-test-key-0123456789abcd' },
    });
    const ok = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/ai/connections/openrouter/test',
      headers: auth(),
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true });
    expect(stub.requests.at(-1)?.url).toBe('/api/v1/key');

    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/connections/openai',
      headers: auth(),
      payload: { apiKey: 'sk-test-key-0123456789abcdef' },
    });
    const okOpenai = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/ai/connections/openai/test',
      headers: auth(),
      payload: {},
    });
    expect(okOpenai.json()).toMatchObject({ ok: true });
    expect(stub.requests.at(-1)?.url).toBe('/v1/models');
  });

  it('reports failure without leaking the key', async () => {
    stub.respond(401, JSON.stringify({ error: { message: 'bad key' } }));
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/connections/openrouter',
      headers: auth(),
      payload: { apiKey: 'sk-or-v1-secret-key-abcdefghijkl' },
    });
    const fail = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/ai/connections/openrouter/test',
      headers: auth(),
      payload: {},
    });
    expect(fail.statusCode).toBe(200);
    expect(fail.json().ok).toBe(false);
    expect(fail.json().message).toContain('401');
    expect(fail.body).not.toContain('sk-or-v1-secret');

    // No stored key → no network call, honest result.
    const noKey = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/ai/connections/openai/test',
      headers: auth(),
      payload: {},
    });
    expect(noKey.json()).toMatchObject({ ok: false });
    expect(noKey.json().message).toMatch(/No API key/i);
  });

  it('does not follow redirects with credentials', async () => {
    stub.respond(302, '', { location: 'http://example.invalid/steal' });
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/connections/openrouter',
      headers: auth(),
      payload: { apiKey: 'sk-or-v1-redirect-key-abcdefghij' },
    });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/ai/connections/openrouter/test',
      headers: auth(),
      payload: {},
    });
    expect(res.json().ok).toBe(false);
    expect(res.json().message).toMatch(/redirect/i);
  });

  it('tests the custom provider against GET {baseUrl}/models', async () => {
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/connections/custom',
      headers: auth(),
      payload: { baseUrl: stub.url, name: 'Stub', apiKey: 'local-key-1234567890' },
    });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/ai/connections/custom/test',
      headers: auth(),
      payload: {},
    });
    expect(res.json()).toMatchObject({ ok: true });
    const last = stub.requests.at(-1);
    expect(last?.url).toBe('/models');
    expect(last?.authorization).toBe('Bearer local-key-1234567890');

    // lastCheckedAt is recorded on the connection.
    const settings = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/ai/settings',
      headers: auth(),
    });
    const conn = settings.json().connections.find((c: { provider: string }) => c.provider === 'custom');
    expect(conn.lastCheckedAt).not.toBeNull();

    // Keyless custom connection: no Authorization header is sent.
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/connections/custom',
      headers: auth(),
      payload: { baseUrl: stub.url, apiKey: '' },
    });
    stub.requests.length = 0;
    const keyless = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/ai/connections/custom/test',
      headers: auth(),
      payload: {},
    });
    expect(keyless.json()).toMatchObject({ ok: true });
    expect(stub.requests.at(-1)?.authorization).toBeUndefined();
  });
});

describe('AI credential key configuration', () => {
  let harness: Harness;
  let session: Session;

  beforeEach(async () => {
    harness = await aiHarness({ AI_CREDENTIAL_KEY: '' });
    await resetDb(harness.db);
    session = await bootstrapAdmin(harness);
  });

  afterEach(async () => {
    await harness.close();
  });

  it('reads settings but refuses secret writes with a clear error', async () => {
    const read = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/ai/settings',
      headers: authHeaders(harness.config, session),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().capabilities).toMatchObject({ credentialStorage: false, chatgpt: false });
    expect(read.json().capabilities.chatgptReason).toBeTruthy();

    const write = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/connections/openrouter',
      headers: authHeaders(harness.config, session),
      payload: { apiKey: 'sk-or-v1-cannot-be-stored-abcdefgh' },
    });
    expect(write.statusCode).toBe(500);
    expect(write.json()).toMatchObject({ code: 'AI_CREDENTIAL_KEY_MISSING' });
    expect(write.json().message).toContain('AI_CREDENTIAL_KEY');
    expect(await harness.db.aiCredential.count()).toBe(0);

    // Non-secret settings still save (modes are configuration, not secrets).
    const modes = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/ai/settings',
      headers: authHeaders(harness.config, session),
      payload: { executionMode: 'monitor_only' },
    });
    expect(modes.statusCode).toBe(200);
    expect(modes.json().settings.executionMode).toBe('monitor_only');
  });
});

describe('AI usage panel (app-side only)', () => {
  let harness: Harness;
  let session: Session;

  beforeEach(async () => {
    harness = await createHarness();
    await resetDb(harness.db);
    session = await bootstrapAdmin(harness);
  });

  afterEach(async () => {
    await harness.close();
  });

  it('reports null/— for missing metrics and never fabricates statistics', async () => {
    const empty = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/ai/usage',
      headers: authHeaders(harness.config, session),
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({
      requests: 0,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      since: null,
      recent: [],
    });

    // There is no client-facing endpoint that could record usage.
    const forge = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/ai/usage',
      headers: authHeaders(harness.config, session),
      payload: { requests: 999 },
    });
    expect(forge.statusCode).toBe(404);
  });

  it('aggregates recorded events per user with nulls for unknown metrics', async () => {
    const userId = session.cookie.length > 0 ? (await harness.db.user.findFirstOrThrow()).id : '';
    await recordAiUsage(harness.db, {
      userId,
      provider: 'openrouter',
      model: 'openrouter/free',
      kind: 'test',
    });
    await recordAiUsage(harness.db, {
      userId,
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.002,
    });

    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/ai/usage',
      headers: authHeaders(harness.config, session),
    });
    const body = res.json();
    expect(body.requests).toBe(2);
    expect(body.inputTokens).toBe(100);
    expect(body.outputTokens).toBe(50);
    expect(body.costUsd).toBeCloseTo(0.002);
    expect(typeof body.since).toBe('string');
    expect(body.recent).toHaveLength(2);
    expect(body.recent[0].provider).toBe('openai');
    expect(body.recent[1]).toMatchObject({
      provider: 'openrouter',
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  });
});

describe('ChatGPT (SIWC) endpoints', () => {
  const savedEnv = { ...process.env };

  afterEach(async () => {
    for (const key of ['AI_CHATGPT_HOST_ID', 'AI_CHATGPT_REDIRECT_URI', 'AI_CHATGPT_ENABLED']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('reports an honest capability and 503 when unconfigured', async () => {
    delete process.env.AI_CHATGPT_HOST_ID;
    delete process.env.AI_CHATGPT_REDIRECT_URI;
    const harness = await aiHarness();
    await resetDb(harness.db);
    const session = await bootstrapAdmin(harness);
    try {
      const settings = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/ai/settings',
        headers: authHeaders(harness.config, session),
      });
      expect(settings.json().capabilities.chatgpt).toBe(false);
      expect(settings.json().capabilities.chatgptReason).toBeTruthy();

      const status = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/ai/chatgpt/status',
        headers: authHeaders(harness.config, session),
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ connected: false, pending: false });
      expect(status.json().message).toBeTruthy();

      const login = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/ai/chatgpt/login',
        headers: authHeaders(harness.config, session),
        payload: {},
      });
      expect(login.statusCode).toBe(503);
      expect(login.json()).toMatchObject({ code: 'CHATGPT_UNAVAILABLE' });

      // Logout stays safe without configuration and returns the settings shape.
      const logout = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/ai/chatgpt/logout',
        headers: authHeaders(harness.config, session),
        payload: {},
      });
      expect(logout.statusCode).toBe(200);
      expect(logout.json().settings).toBeDefined();
      expect(logout.json().connections).toHaveLength(4);
    } finally {
      await harness.close();
    }
  });

  it('starts a real PKCE login and completes logout when configured', async () => {
    process.env.AI_CHATGPT_HOST_ID = 'urn:uuid:11111111-2222-4333-8444-555555555555';
    // Strict SIWC path: scheme+host+path pinned (/auth/callback), only the
    // port may vary (official docs; module validates it too).
    process.env.AI_CHATGPT_REDIRECT_URI = 'http://127.0.0.1:8080/auth/callback';
    const harness = await aiHarness();
    await resetDb(harness.db);
    const session = await bootstrapAdmin(harness);
    try {
      const settings = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/ai/settings',
        headers: authHeaders(harness.config, session),
      });
      expect(settings.json().capabilities.chatgpt).toBe(true);
      expect(settings.json().capabilities.chatgptReason).toBeNull();

      const login = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/ai/chatgpt/login',
        headers: authHeaders(harness.config, session),
        payload: {},
      });
      expect(login.statusCode).toBe(200);
      const { authorizationUrl } = login.json();
      expect(authorizationUrl).toContain('code_challenge=');
      expect(authorizationUrl).toContain('code_challenge_method=S256');
      // The PKCE verifier never leaves the backend.
      expect(authorizationUrl).not.toContain('code_verifier');

      const status = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/ai/chatgpt/status',
        headers: authHeaders(harness.config, session),
      });
      expect(status.json()).toMatchObject({ connected: false, pending: true });

      // Official SIWC loopback path: root /auth/callback (outside /api/v1).
      // An unknown state must be handled as a static page, never a redirect.
      const alias = await harness.app.inject({
        method: 'GET',
        url: '/auth/callback?code=dummy-code&state=not-a-pending-state',
        headers: authHeaders(harness.config, session),
      });
      expect(alias.statusCode).toBe(200);
      expect(alias.body).toContain('Sign-in did not complete');
      expect(alias.body).not.toContain('dummy-code');
      // API-path alias stays available for compatibility.
      const apiAlias = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/ai/chatgpt/callback?code=dummy-code&state=not-a-pending-state',
        headers: authHeaders(harness.config, session),
      });
      expect(apiAlias.statusCode).toBe(200);

      const logout = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/ai/chatgpt/logout',
        headers: authHeaders(harness.config, session),
        payload: {},
      });
      expect(logout.statusCode).toBe(200);
      const after = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/ai/chatgpt/status',
        headers: authHeaders(harness.config, session),
      });
      expect(after.json()).toMatchObject({ connected: false, pending: false });
    } finally {
      await harness.close();
    }
  });
});
