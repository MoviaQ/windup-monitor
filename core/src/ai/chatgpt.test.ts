import { createHash, generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHATGPT_REQUIRED_SCOPES,
  ChatGptConnector,
  ChatGptError,
  chatGptConfigFromEnv,
  createChatgptIntegration,
  newAgentHostId,
  type ChatGptConfig,
  type ChatGptTokenStore,
  type ChatgptSecretStore,
  type FetchLike,
} from './chatgpt.js';

const BASE_TIME = Date.parse('2026-10-19T12:00:00.000Z');
const REDIRECT_URI = 'http://127.0.0.1:53682/auth/callback';
const HOST_ID = 'urn:uuid:123e4567-e89b-42d3-a456-426614174000';
const ISSUER = 'https://auth.example.test';
const AUTHORIZE_ENDPOINT = 'https://auth.example.test/authorize';
const TOKEN_ENDPOINT = 'https://auth.example.test/token';
const JWKS_URI = 'https://auth.example.test/jwks.json';
const CLIENT_ID = 'oaiapp_test_client_123';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;

let nowMs = BASE_TIME;

beforeEach(() => {
  nowMs = BASE_TIME;
});

function makeConfig(overrides: Partial<ChatGptConfig> = {}): ChatGptConfig {
  return {
    agentName: 'wind-up monitor',
    extAgentHostId: HOST_ID,
    redirectUri: REDIRECT_URI,
    issuer: ISSUER,
    authorizationEndpoint: AUTHORIZE_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    jwksUri: JWKS_URI,
    ...overrides,
  };
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function signJwt(
  claims: Record<string, unknown>,
  options: { key?: typeof privateKey; kid?: string } = {},
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: options.kid ?? 'kid-1' };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign('RSA-SHA256', Buffer.from(data, 'utf8'), options.key ?? privateKey).toString('base64url');
  return `${data}.${signature}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

class MemoryStore implements ChatGptTokenStore {
  readonly records = new Map<string, string>();

  async encrypt(plaintext: string): Promise<string> {
    return `enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
  }

  async decrypt(ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith('enc:')) throw new Error('not encrypted by this store');
    return Buffer.from(ciphertext.slice(4), 'base64').toString('utf8');
  }

  async load(userId: string): Promise<string | null> {
    return this.records.get(userId) ?? null;
  }

  async save(userId: string, encrypted: string): Promise<void> {
    this.records.set(userId, encrypted);
  }

  async delete(userId: string): Promise<void> {
    this.records.delete(userId);
  }

  plaintext(userId: string): string | null {
    const value = this.records.get(userId);
    if (value === undefined) return null;
    return Buffer.from(value.slice(4), 'base64').toString('utf8');
  }
}

/** Contract §8 storage: backend owns encryption, module passes an object. */
class MemorySecretStore implements ChatgptSecretStore {
  readonly records = new Map<string, unknown>();

  async save(userId: string, secret: unknown, opts?: { keyHint?: string | null }): Promise<void> {
    void opts;
    this.records.set(userId, secret);
  }

  async load(userId: string): Promise<unknown | null> {
    return this.records.get(userId) ?? null;
  }

  async delete(userId: string): Promise<void> {
    this.records.delete(userId);
  }
}

interface HarnessOptions {
  config?: Partial<ChatGptConfig>;
  store?: MemoryStore;
  token?: (body: URLSearchParams, call: number) => Response | Promise<Response>;
  jwks?: JsonWebKey[];
  fetch?: FetchLike;
}

interface Harness {
  connector: ChatGptConnector;
  store: MemoryStore;
  config: ChatGptConfig;
  tokenBodies: URLSearchParams[];
  fetchFn: FetchLike;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const config = makeConfig(options.config);
  const store = options.store ?? new MemoryStore();
  const tokenBodies: URLSearchParams[] = [];
  let tokenCall = 0;

  const fetchFn: FetchLike = vi.fn(
    async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]): Promise<Response> => {
      const url = String(input);
      if (url === config.tokenEndpoint) {
        const body = new URLSearchParams(String(init?.body ?? ''));
        tokenBodies.push(body);
        if (options.token) return options.token(body, tokenCall++);
        return jsonResponse({ error: 'unexpected_token_call' }, 500);
      }
      if (url === config.jwksUri) {
        return jsonResponse({ keys: options.jwks ?? [{ ...publicJwk, kid: 'kid-1', alg: 'RS256', use: 'sig' }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  );

  const connector = new ChatGptConnector({
    config,
    store,
    fetch: fetchFn,
    now: () => nowMs,
  });
  return { connector, store, config, tokenBodies, fetchFn };
}

interface StartedFlow {
  start: Awaited<ReturnType<ChatGptConnector['startLogin']>>;
  url: URL;
  state: string;
  nonce: string;
}

async function begin(connector: ChatGptConnector, userId = 'user-1'): Promise<StartedFlow> {
  const start = await connector.startLogin(userId);
  const url = new URL(start.authorizationUrl);
  const state = url.searchParams.get('state');
  const nonce = url.searchParams.get('nonce');
  if (!state || !nonce) throw new Error('authorization URL is missing state/nonce');
  return { start, url, state, nonce };
}

function tokenPayload(options: {
  clientId?: string;
  nonce?: string;
  subject?: string;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  key?: typeof privateKey;
  kid?: string;
  claims?: Record<string, unknown>;
  /** Official refresh responses may omit id_token. */
  includeIdToken?: boolean;
}): Record<string, unknown> {
  const nowSeconds = Math.floor(nowMs / 1000);
  const idToken = signJwt(
    {
      iss: ISSUER,
      aud: options.clientId ?? CLIENT_ID,
      sub: options.subject ?? 'subject-1',
      exp: nowSeconds + 3600,
      iat: nowSeconds,
      ...(options.nonce ? { nonce: options.nonce } : {}),
      email: options.email ?? 'user@example.test',
      name: 'Test User',
      ...options.claims,
    },
    { key: options.key, kid: options.kid },
  );
  return {
    access_token: options.accessToken ?? 'at_test_access_token',
    refresh_token: options.refreshToken ?? 'rt_test_refresh_token',
    ...(options.includeIdToken === false ? {} : { id_token: idToken }),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: CHATGPT_REQUIRED_SCOPES.join(' '),
  };
}

async function complete(
  harness: Harness,
  flow: StartedFlow,
  overrides: { userId?: string; clientId?: string | null; error?: string } = {},
): Promise<Awaited<ReturnType<ChatGptConnector['completeCallback']>>> {
  return harness.connector.completeCallback({
    userId: overrides.userId ?? 'user-1',
    code: 'auth-code-1',
    state: flow.state,
    clientId: overrides.clientId === undefined ? CLIENT_ID : overrides.clientId,
    error: overrides.error ?? null,
  });
}

describe('ChatGPT capability', () => {
  it('is ready for a valid loopback configuration', () => {
    const harness = createHarness();
    const capability = harness.connector.capability();

    expect(capability.available).toBe(true);
    expect(capability.configured).toBe(true);
    expect(capability.loopbackCallback).toBe(true);
    expect(capability.missing).toEqual([]);
    expect(capability.warnings).toEqual([]);
  });

  it('reports missing environment configuration instead of inventing values', () => {
    const env = chatGptConfigFromEnv({});
    expect(env.enabled).toBe(true);
    expect(env.missing).toEqual(['AI_CHATGPT_HOST_ID', 'AI_CHATGPT_REDIRECT_URI']);

    const connector = new ChatGptConnector({
      config: env.config,
      store: new MemoryStore(),
      fetch: vi.fn() as unknown as FetchLike,
    });
    const capability = connector.capability();
    expect(capability.available).toBe(false);
    expect(capability.message).toContain('AI_CHATGPT_HOST_ID');
    expect(capability.message).toContain('AI_CHATGPT_REDIRECT_URI');
  });

  it('rejects non-loopback redirect URIs and any path other than /auth/callback', () => {
    for (const redirectUri of [
      'https://127.0.0.1:53682/auth/callback',
      'http://localhost:53682/auth/callback',
      'http://127.0.0.1/auth/callback',
      'http://127.0.0.1:53682/auth/callback?next=https://evil.test',
      'http://127.0.0.1:53682/api/v1/ai/chatgpt/callback',
      'http://127.0.0.1:53682/callback',
      'http://127.0.0.1:53682/auth/callback/extra',
    ]) {
      const capability = createHarness({ config: { redirectUri } }).connector.capability();
      expect(capability.available).toBe(false);
      expect(capability.loopbackCallback).toBe(false);
      expect(capability.warnings.join(' ')).toContain('AI_CHATGPT_REDIRECT_URI');
    }
  });

  it('rejects a non-opaque host ID', () => {
    const capability = createHarness({ config: { extAgentHostId: 'user@example.test' } }).connector.capability();
    expect(capability.available).toBe(false);
    expect(capability.warnings.join(' ')).toContain('AI_CHATGPT_HOST_ID');
  });

  it('keeps remote deployments available but warns about the loopback callback', () => {
    const capability = createHarness({ config: { deployment: 'remote' } }).connector.capability();
    expect(capability.available).toBe(true);
    expect(capability.warnings.join(' ')).toContain('SSH tunnel');
  });

  it('is unavailable when explicitly disabled', () => {
    const env = chatGptConfigFromEnv({
      AI_CHATGPT_ENABLED: 'false',
      AI_CHATGPT_HOST_ID: HOST_ID,
      AI_CHATGPT_REDIRECT_URI: REDIRECT_URI,
    });
    const connector = new ChatGptConnector({
      config: env.config,
      store: new MemoryStore(),
      enabled: env.enabled,
      fetch: vi.fn() as unknown as FetchLike,
    });
    expect(connector.capability().available).toBe(false);
    expect(connector.capability().message).toContain('disabled');
  });

  it('generates a valid UUIDv4 host ID', () => {
    expect(newAgentHostId()).toMatch(/^urn:uuid:[0-9a-f-]{36}$/i);
  });
});

describe('ChatGPT login start', () => {
  it('builds the official authorization URL without exposing the PKCE verifier or tokens', async () => {
    const harness = createHarness();
    const flow = await begin(harness.connector);

    expect(flow.url.origin + flow.url.pathname).toBe(AUTHORIZE_ENDPOINT);
    expect(flow.url.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(flow.url.searchParams.get('response_type')).toBe('code');
    expect(flow.url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(flow.url.searchParams.get('scope')).toBe(CHATGPT_REQUIRED_SCOPES.join(' '));
    expect(flow.url.searchParams.get('resource')).toBe('https://api.openai.com/v1');
    expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.url.searchParams.get('code_challenge')?.length).toBeGreaterThan(30);
    expect(flow.url.searchParams.get('agent_name_hint')).toBe('wind-up monitor');
    expect(flow.url.searchParams.get('ext_agent_host_id')).toBe(HOST_ID);
    expect(flow.url.searchParams.get('state')?.length).toBeGreaterThan(30);
    expect(flow.url.searchParams.get('nonce')?.length).toBeGreaterThan(30);

    expect(flow.url.searchParams.has('code_verifier')).toBe(false);
    expect(flow.url.searchParams.has('client_secret')).toBe(false);
    expect(flow.url.searchParams.has('id_token_hint')).toBe(false);
    expect(flow.url.searchParams.has('access_token')).toBe(false);
    expect(flow.start.expiresAt).toBe(new Date(BASE_TIME + 10 * 60_000).toISOString());
  });

  it('invalidates a previous pending flow for the same user', async () => {
    const harness = createHarness();
    const first = await begin(harness.connector);
    const second = await begin(harness.connector);

    await expect(complete(harness, first)).rejects.toMatchObject({ code: 'CHATGPT_FLOW_INVALID' });
    expect((await harness.connector.status('user-1')).pending).toBe(true);
    expect(second.state).not.toBe(first.state);
  });

  it('does not accept a flow from another user session', async () => {
    const harness = createHarness();
    const flow = await begin(harness.connector, 'user-1');

    await expect(complete(harness, flow, { userId: 'user-2' })).rejects.toMatchObject({
      code: 'CHATGPT_FLOW_INVALID',
    });
    expect((await harness.connector.status('user-1')).pending).toBe(true);
  });

  it('expires a pending flow', async () => {
    const harness = createHarness();
    const flow = await begin(harness.connector);
    nowMs += 10 * 60_000 + 1;

    await expect(complete(harness, flow)).rejects.toMatchObject({ code: 'CHATGPT_FLOW_EXPIRED' });
    expect((await harness.connector.status('user-1')).pending).toBe(false);
  });

  it('handles access_denied without exchanging a code', async () => {
    const harness = createHarness();
    const flow = await begin(harness.connector);

    await expect(complete(harness, flow, { error: 'access_denied' })).rejects.toMatchObject({
      code: 'CHATGPT_ACCESS_DENIED',
    });
    expect(harness.tokenBodies).toHaveLength(0);
    expect((await harness.connector.status('user-1')).pending).toBe(false);
  });
});

describe('ChatGPT callback and token exchange', () => {
  it('validates PKCE, exchanges the code and stores only encrypted credentials', async () => {
    const harness = createHarness();
    const tokenBodies: URLSearchParams[] = [];
    let payload: Record<string, unknown> | null = null;
    const connector = new ChatGptConnector({
      config: harness.config,
      store: harness.store,
      fetch: vi.fn(async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
        const url = String(input);
        if (url === TOKEN_ENDPOINT) {
          tokenBodies.push(new URLSearchParams(String(init?.body ?? '')));
          if (payload === null) throw new Error('token payload was not prepared');
          return jsonResponse(payload);
        }
        return jsonResponse({ keys: [{ ...publicJwk, kid: 'kid-1', alg: 'RS256', use: 'sig' }] });
      }) as unknown as FetchLike,
      now: () => nowMs,
    });
    const flow = await begin(connector);
    payload = tokenPayload({ nonce: flow.nonce });

    const status = await connector.completeCallback({
      userId: 'user-1',
      code: 'auth-code-1',
      state: flow.state,
      clientId: CLIENT_ID,
    });

    expect(status.connected).toBe(true);
    expect(status.pending).toBe(false);
    expect(status.account?.email).toBe('user@example.test');
    expect(status.planUsageGranted).toBe(true);
    expect(status.message).toContain('user@example.test');

    const body = tokenBodies[0];
    expect(body).toBeDefined();
    expect(body?.get('grant_type')).toBe('authorization_code');
    expect(body?.get('code')).toBe('auth-code-1');
    expect(body?.get('client_id')).toBe(CLIENT_ID);
    expect(body?.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(body?.get('resource')).toBe('https://api.openai.com/v1');
    expect(body?.has('client_secret')).toBe(false);
    expect(body?.get('code_verifier')).toBeTruthy();

    const challenge = new URL(flow.start.authorizationUrl).searchParams.get('code_challenge');
    const verifier = body?.get('code_verifier') ?? '';
    const computed = createHash('sha256').update(verifier, 'utf8').digest('base64url');
    expect(challenge).toBe(computed);

    const stored = harness.store.plaintext('user-1');
    expect(stored).not.toBeNull();
    expect(harness.store.records.get('user-1')).not.toContain('at_test_access_token');
    expect(harness.store.records.get('user-1')).not.toContain('rt_test_refresh_token');
    expect(JSON.stringify(status)).not.toContain('at_test_access_token');
    expect(JSON.stringify(status)).not.toContain('rt_test_refresh_token');
  });

  it('rejects a callback without the issued client_id on first registration', async () => {
    const harness = createHarness();
    const flow = await begin(harness.connector);

    await expect(complete(harness, flow, { clientId: null })).rejects.toMatchObject({
      code: 'CHATGPT_REGISTRATION_INCOMPLETE',
    });
    expect(harness.tokenBodies).toHaveLength(0);
  });

  it('rejects an unknown state before any token call', async () => {
    const harness = createHarness();
    await expect(
      harness.connector.completeCallback({
        userId: 'user-1',
        code: 'auth-code-1',
        state: 'not-a-real-state',
        clientId: CLIENT_ID,
      }),
    ).rejects.toMatchObject({ code: 'CHATGPT_FLOW_INVALID' });
    expect(harness.tokenBodies).toHaveLength(0);
  });

  it('rejects an authorization_code response without id_token', async () => {
    const harness = createHarness({
      token: () => jsonResponse(tokenPayload({ includeIdToken: false })),
    });
    const flow = await begin(harness.connector);

    await expect(complete(harness, flow)).rejects.toMatchObject({
      code: 'CHATGPT_TOKEN_RESPONSE_INVALID',
    });
    expect(harness.store.records.size).toBe(0);
  });

  it('does not include upstream token details in errors', async () => {
    const harness = createHarness({
      token: () =>
        jsonResponse(
          {
            error: 'invalid_grant',
            error_description: 'code=super-secret-code access_token=super-secret-token',
          },
          400,
        ),
    });
    const flow = await begin(harness.connector);

    let caught: unknown;
    try {
      await complete(harness, flow);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChatGptError);
    const error = caught as ChatGptError;
    expect(error.code).toBe('CHATGPT_TOKEN_EXCHANGE_FAILED');
    expect(error.upstreamError).toBe('invalid_grant');
    expect(error.message).not.toContain('super-secret');
    expect(JSON.stringify(error)).not.toContain('super-secret');
  });

  it('rejects a bad ID token signature, issuer, audience, nonce and expiry', async () => {
    const cases: Array<{
      name: string;
      token: (flow: StartedFlow) => Record<string, unknown>;
      jwks?: JsonWebKey[];
    }> = [
      {
        name: 'signature',
        token: (flow) => tokenPayload({ nonce: flow.nonce, key: otherPrivateKey }),
      },
      {
        name: 'issuer',
        token: (flow) => tokenPayload({ nonce: flow.nonce, claims: { iss: 'https://evil.test' } }),
      },
      {
        name: 'audience',
        token: (flow) => tokenPayload({ nonce: flow.nonce, claims: { aud: 'oaiapp_other_client' } }),
      },
      {
        name: 'nonce',
        token: (flow) => tokenPayload({ nonce: `${flow.nonce}-wrong` }),
      },
      {
        name: 'expiry',
        token: (flow) => tokenPayload({ nonce: flow.nonce, claims: { exp: Math.floor(nowMs / 1000) - 3600 } }),
      },
    ];

    for (const testCase of cases) {
      const harness = createHarness();
      let flow: StartedFlow | null = null;
      const connector = new ChatGptConnector({
        config: harness.config,
        store: harness.store,
        fetch: vi.fn(async (input: Parameters<FetchLike>[0]) => {
          const url = String(input);
          if (url === TOKEN_ENDPOINT) {
            if (flow === null) throw new Error('flow was not started');
            return jsonResponse(testCase.token(flow));
          }
          return jsonResponse({ keys: testCase.jwks ?? [{ ...publicJwk, kid: 'kid-1', alg: 'RS256', use: 'sig' }] });
        }) as unknown as FetchLike,
        now: () => nowMs,
      });
      flow = await begin(connector);

      await expect(
        connector.completeCallback({
          userId: 'user-1',
          code: 'auth-code-1',
          state: flow.state,
          clientId: CLIENT_ID,
        }),
      ).rejects.toMatchObject({ code: 'CHATGPT_ID_TOKEN_INVALID' });
      expect((await connector.status('user-1')).connected).toBe(false);
      expect(harness.store.records.size).toBe(0);
    }
  });
});

describe('ChatGPT refresh and logout', () => {
  async function connect(harness: Harness): Promise<StartedFlow> {
    let payload: Record<string, unknown> = {};
    const connector = new ChatGptConnector({
      config: harness.config,
      store: harness.store,
      fetch: vi.fn(async (input: Parameters<FetchLike>[0]) => {
        const url = String(input);
        if (url === TOKEN_ENDPOINT) return jsonResponse(payload);
        return jsonResponse({ keys: [{ ...publicJwk, kid: 'kid-1', alg: 'RS256', use: 'sig' }] });
      }) as unknown as FetchLike,
      now: () => nowMs,
    });
    const flow = await begin(connector);
    payload = tokenPayload({ nonce: flow.nonce, accessToken: 'at_old', refreshToken: 'rt_old' });
    await connector.completeCallback({
      userId: 'user-1',
      code: 'auth-code-1',
      state: flow.state,
      clientId: CLIENT_ID,
    });
    harness.connector = connector;
    return flow;
  }

  it('rotates tokens and keeps the account identity', async () => {
    const harness = createHarness();
    await connect(harness);
    nowMs += 2 * 60 * 60_000;

    const refreshed = tokenPayload({
      accessToken: 'at_new',
      refreshToken: 'rt_new',
      subject: 'subject-1',
      nonce: undefined,
    });
    const tokenBodies: URLSearchParams[] = [];
    const connector = new ChatGptConnector({
      config: harness.config,
      store: harness.store,
      fetch: vi.fn(async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
        const url = String(input);
        if (url === TOKEN_ENDPOINT) {
          tokenBodies.push(new URLSearchParams(String(init?.body ?? '')));
          return jsonResponse(refreshed);
        }
        return jsonResponse({ keys: [{ ...publicJwk, kid: 'kid-1', alg: 'RS256', use: 'sig' }] });
      }) as unknown as FetchLike,
      now: () => nowMs,
    });

    const status = await connector.refresh('user-1');
    expect(status.connected).toBe(true);
    expect(status.account?.subject).toBe('subject-1');
    expect(tokenBodies[0]?.get('grant_type')).toBe('refresh_token');
    expect(tokenBodies[0]?.get('refresh_token')).toBe('rt_old');
    expect(tokenBodies[0]?.get('client_id')).toBe(CLIENT_ID);
    expect(tokenBodies[0]?.has('client_secret')).toBe(false);
    expect(harness.store.records.get('user-1')).not.toContain('rt_new');
    expect(harness.store.plaintext('user-1')).toContain('rt_new');
  });

  it('accepts a refresh response without id_token and preserves the verified identity', async () => {
    const harness = createHarness();
    await connect(harness);
    const before = JSON.parse(harness.store.plaintext('user-1') ?? '{}') as {
      idToken: string;
      account: unknown;
    };
    nowMs += 2 * 60 * 60_000;

    const connector = new ChatGptConnector({
      config: harness.config,
      store: harness.store,
      fetch: vi.fn(async (input: Parameters<FetchLike>[0]) => {
        const url = String(input);
        if (url === TOKEN_ENDPOINT) {
          return jsonResponse(
            tokenPayload({
              accessToken: 'at_new',
              refreshToken: 'rt_new',
              includeIdToken: false,
            }),
          );
        }
        return jsonResponse({ keys: [{ ...publicJwk, kid: 'kid-1', alg: 'RS256', use: 'sig' }] });
      }) as unknown as FetchLike,
      now: () => nowMs,
    });

    const status = await connector.refresh('user-1');
    expect(status.connected).toBe(true);
    expect(status.account?.subject).toBe('subject-1');
    expect(status.account?.email).toBe('user@example.test');

    const after = JSON.parse(harness.store.plaintext('user-1') ?? '{}') as {
      accessToken: string;
      refreshToken: string;
      idToken: string;
      account: unknown;
    };
    expect(after.accessToken).toBe('at_new');
    expect(after.refreshToken).toBe('rt_new');
    // No new id_token: keep the last fully verified one, not a decoded guess.
    expect(after.idToken).toBe(before.idToken);
    expect(after.account).toEqual(before.account);
  });

  it('requires reauthentication when the refresh token expired', async () => {
    const harness = createHarness();
    await connect(harness);
    nowMs += 31 * 24 * 60 * 60_000;

    await expect(harness.connector.refresh('user-1')).rejects.toMatchObject({
      code: 'CHATGPT_REAUTH_REQUIRED',
    });
    expect(harness.store.records.size).toBe(0);
    expect((await harness.connector.status('user-1')).connected).toBe(false);
  });

  it('rejects a refresh ID token for a different subject', async () => {
    const harness = createHarness();
    await connect(harness);
    nowMs += 2 * 60 * 60_000;

    const connector = new ChatGptConnector({
      config: harness.config,
      store: harness.store,
      fetch: vi.fn(async (input: Parameters<FetchLike>[0]) => {
        const url = String(input);
        if (url === TOKEN_ENDPOINT) return jsonResponse(tokenPayload({ subject: 'other-subject' }));
        return jsonResponse({ keys: [{ ...publicJwk, kid: 'kid-1', alg: 'RS256', use: 'sig' }] });
      }) as unknown as FetchLike,
      now: () => nowMs,
    });

    await expect(connector.refresh('user-1')).rejects.toMatchObject({ code: 'CHATGPT_ID_TOKEN_INVALID' });
    expect((await harness.connector.status('user-1')).account?.subject).toBe('subject-1');
  });

  it('serializes concurrent refreshes so a rotating refresh token is not raced', async () => {
    const harness = createHarness();
    await connect(harness);
    nowMs += 2 * 60 * 60_000;

    let tokenCalls = 0;
    const connector = new ChatGptConnector({
      config: harness.config,
      store: harness.store,
      fetch: vi.fn(async (input: Parameters<FetchLike>[0]) => {
        const url = String(input);
        if (url === TOKEN_ENDPOINT) {
          tokenCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return jsonResponse(tokenPayload({ accessToken: 'at_new', refreshToken: 'rt_new' }));
        }
        return jsonResponse({ keys: [{ ...publicJwk, kid: 'kid-1', alg: 'RS256', use: 'sig' }] });
      }) as unknown as FetchLike,
      now: () => nowMs,
    });

    const [first, second] = await Promise.all([connector.refresh('user-1'), connector.refresh('user-1')]);
    expect(tokenCalls).toBe(1);
    expect(first.connected).toBe(true);
    expect(second.connected).toBe(true);
  });

  it('clears local state on logout and starts a fresh registration afterwards', async () => {
    const harness = createHarness();
    await connect(harness);

    await harness.connector.logout('user-1');
    expect(harness.store.records.size).toBe(0);
    expect((await harness.connector.status('user-1')).connected).toBe(false);

    const next = await begin(harness.connector);
    expect(next.url.searchParams.get('client_id')).toBe('dynamic_agent_client');
  });

  it('uses the issued client ID and omits agent_name_hint on returning sign-in', async () => {
    const harness = createHarness();
    await connect(harness);

    const next = await begin(harness.connector);
    expect(next.url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(next.url.searchParams.has('agent_name_hint')).toBe(false);
    expect(next.url.searchParams.has('id_token_hint')).toBe(false);
  });
});

describe('ChatGPT contract integration (docs/ai-integration-contract.md §8)', () => {
  it('exposes the contract surface and completes the flow through the secret store', async () => {
    const storage = new MemorySecretStore();
    let nonce = '';
    const fetchFn = vi.fn(async (input: Parameters<FetchLike>[0]) => {
      const url = String(input);
      if (url === TOKEN_ENDPOINT) return jsonResponse(tokenPayload({ nonce }));
      return jsonResponse({ keys: [{ ...publicJwk, kid: 'kid-1', alg: 'RS256', use: 'sig' }] });
    }) as unknown as FetchLike;

    const integration = createChatgptIntegration({
      storage,
      env: {},
      config: makeConfig(),
      fetch: fetchFn,
      now: () => nowMs,
    });

    expect(integration.isAvailable()).toEqual({ ok: true, reason: null });

    const { authorizationUrl } = await integration.login('user-1');
    const url = new URL(authorizationUrl);
    nonce = url.searchParams.get('nonce') ?? '';
    const state = url.searchParams.get('state') ?? '';
    expect(nonce.length).toBeGreaterThan(30);
    expect((await integration.status('user-1')).pending).toBe(true);

    const status = await integration.completeCallback('user-1', {
      code: 'auth-code-1',
      state,
      clientId: CLIENT_ID,
    });

    expect(status).toEqual({
      connected: true,
      pending: false,
      message: expect.stringContaining('user@example.test'),
    });
    expect(Object.keys(status).sort()).toEqual(['connected', 'message', 'pending']);
    expect(JSON.stringify(status)).not.toContain('at_test_access_token');
    expect(JSON.stringify(status)).not.toContain('rt_test_refresh_token');

    const stored = storage.records.get('user-1');
    expect(stored).toBeTypeOf('object');
    expect(stored).toMatchObject({ account: { email: 'user@example.test' } });

    await integration.logout('user-1');
    expect(storage.records.size).toBe(0);
    expect((await integration.status('user-1')).connected).toBe(false);
  });

  it('reports a precise reason when env configuration is missing', async () => {
    const integration = createChatgptIntegration({
      storage: new MemorySecretStore(),
      env: {},
      fetch: vi.fn() as unknown as FetchLike,
    });

    const available = integration.isAvailable();
    expect(available.ok).toBe(false);
    expect(available.reason).toContain('AI_CHATGPT_HOST_ID');
    expect(available.reason).toContain('AI_CHATGPT_REDIRECT_URI');

    await expect(integration.login('user-1')).rejects.toMatchObject({ code: 'CHATGPT_NOT_CONFIGURED' });
  });

  it('clears a pending flow on logout without inventing a connection', async () => {
    const storage = new MemorySecretStore();
    const integration = createChatgptIntegration({
      storage,
      env: {},
      config: makeConfig(),
      fetch: vi.fn() as unknown as FetchLike,
      now: () => nowMs,
    });

    await integration.login('user-1');
    expect((await integration.status('user-1')).pending).toBe(true);

    await integration.logout('user-1');
    const status = await integration.status('user-1');
    expect(status).toEqual({
      connected: false,
      pending: false,
      message: 'ChatGPT is not connected.',
    });
    expect(storage.records.size).toBe(0);
  });
});
