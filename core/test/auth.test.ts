import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ORIGIN,
  authHeaders,
  bootstrapAdmin,
  createHarness,
  createPairingToken,
  login,
  resetDb,
  seedBootstrapToken,
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

describe('auth: status + bootstrap', () => {
  it('reports uninitialized before bootstrap and initialized after', async () => {
    const before = await h.app.inject({ method: 'GET', url: '/api/v1/auth/status' });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ initialized: false });

    await bootstrapAdmin(h);

    const after = await h.app.inject({ method: 'GET', url: '/api/v1/auth/status' });
    expect(after.json()).toEqual({ initialized: true });
  });

  it('sets a HttpOnly SameSite=Lax session cookie and returns a CSRF token', async () => {
    const token = await seedBootstrapToken(h.db, h.config);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers: { origin: ORIGIN },
      payload: { token, email: 'admin@example.test', password: 'correct horse battery staple' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { user: { email: string }; csrfToken: string };
    expect(body.user.email).toBe('admin@example.test');
    expect(body.csrfToken.length).toBeGreaterThan(20);

    const cookie = res.cookies.find((c) => c.name === h.config.cookieName);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(String(cookie?.sameSite).toLowerCase()).toBe('lax');
    expect(cookie?.path).toBe('/');
    // Test environment is plain HTTP, so the secure flag is off and the
    // __Host- prefix (which requires Secure) is not used.
    expect(cookie?.secure ?? false).toBe(false);
    expect(h.config.cookieName).toBe('sp_session');
  });

  it('consumes the bootstrap token permanently (second attempt 409)', async () => {
    const token = await seedBootstrapToken(h.db, h.config);
    const payload = { token, email: 'admin@example.test', password: 'correct horse battery staple' };

    const first = await h.app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', headers: { origin: ORIGIN }, payload });
    expect(first.statusCode).toBe(201);

    const second = await h.app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', headers: { origin: ORIGIN }, payload });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'ALREADY_INITIALIZED' });

    await expect(h.db.user.count()).resolves.toBe(1);
  });

  it('rejects a wrong bootstrap token without burning it', async () => {
    const token = await seedBootstrapToken(h.db, h.config);
    const wrong = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers: { origin: ORIGIN },
      payload: { token: 'not-the-token', email: 'admin@example.test', password: 'correct horse battery staple' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: 'INVALID_BOOTSTRAP_TOKEN' });

    const good = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers: { origin: ORIGIN },
      payload: { token, email: 'admin@example.test', password: 'correct horse battery staple' },
    });
    expect(good.statusCode).toBe(201);
  });

  it('rejects passwords shorter than 12 characters', async () => {
    const token = await seedBootstrapToken(h.db, h.config);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers: { origin: ORIGIN },
      payload: { token, email: 'admin@example.test', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_BODY' });
  });
});

describe('auth: login / me / logout', () => {
  it('logs in, returns the user + CSRF token and rejects wrong passwords', async () => {
    await bootstrapAdmin(h);

    const wrong = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { email: 'admin@example.test', password: 'wrong password 123' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: 'BAD_CREDENTIAL' });

    const session = await login(h, 'ADMIN@example.test', 'correct horse battery staple');
    const me = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `${h.config.cookieName}=${session.cookie}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      user: { email: 'admin@example.test' },
      csrfToken: session.csrfToken,
    });
  });

  it('requires a CSRF token on authenticated mutations', async () => {
    const session = await bootstrapAdmin(h);

    const without = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agents/pairing-tokens',
      headers: { cookie: `${h.config.cookieName}=${session.cookie}`, origin: ORIGIN },
      payload: {},
    });
    expect(without.statusCode).toBe(403);
    expect(without.json()).toMatchObject({ code: 'CSRF_INVALID' });

    const withToken = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agents/pairing-tokens',
      headers: authHeaders(h.config, session),
      payload: {},
    });
    expect(withToken.statusCode).toBe(201);
  });

  it('rejects cross-origin mutations', async () => {
    const session = await bootstrapAdmin(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/agents/pairing-tokens',
      headers: { ...authHeaders(h.config, session), origin: 'https://evil.example' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
  });

  it('rate-limits login attempts (5 / 5 min / IP)', async () => {
    await bootstrapAdmin(h);
    for (let i = 0; i < 5; i += 1) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: ORIGIN },
        payload: { email: 'admin@example.test', password: 'wrong password 123' },
      });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN },
      payload: { email: 'admin@example.test', password: 'correct horse battery staple' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('destroys the session on logout', async () => {
    const session = await bootstrapAdmin(h);
    const out = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: authHeaders(h.config, session),
    });
    expect(out.statusCode).toBe(204);

    const me = await h.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `${h.config.cookieName}=${session.cookie}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it('creates a pairing token only for an authenticated session', async () => {
    const anonymous = await h.app.inject({ method: 'POST', url: '/api/v1/agents/pairing-tokens', payload: {} });
    expect(anonymous.statusCode).toBe(401);

    const session = await bootstrapAdmin(h);
    const token = await createPairingToken(h, session);
    expect(token.length).toBeGreaterThan(30);
  });
});
