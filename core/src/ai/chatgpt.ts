import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature,
  type JsonWebKey,
} from 'node:crypto';

/**
 * ChatGPT subscription ("Sign in with ChatGPT") connector.
 *
 * This module implements the OAuth/PKCE part of the official open-source SIWC
 * flow and the token lifecycle. It deliberately does NOT call the Responses API
 * or run any agent logic. A future inference module can read the credential
 * through the same injected store.
 *
 * Official docs:
 * - https://developers.openai.com/siwc/token-sharing-open-source
 * - https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 * - https://developers.openai.com/siwc/token-sharing-open-source/token-reference
 *
 * Security invariants:
 * - the redirect URI comes only from server configuration (no open redirect);
 * - every pending flow is bound to a userId and expires;
 * - state and nonce are single-use and validated before token exchange;
 * - ID tokens are signature-checked against the issuer JWKS, and issuer,
 *   audience, expiration and nonce are validated;
 * - access/refresh/ID tokens never leave the module through status, errors or
 *   URLs. The only token ever placed in a URL is the OAuth authorization code
 *   returned by OpenAI to the callback, which the backend must not log.
 */

const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const DEFAULT_ISSUER = 'https://auth.openai.com';
const DEFAULT_AUTHORIZATION_ENDPOINT = 'https://auth.openai.com/api/accounts/authorize';
const DEFAULT_TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';
const DEFAULT_JWKS_URI = 'https://auth.openai.com/.well-known/jwks.json';
const DEFAULT_RESOURCE = 'https://api.openai.com/v1';

/** Scopes required by the ChatGPT plan usage flow. */
export const CHATGPT_REQUIRED_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  'chatgpt.tokens.use.direct',
] as const;

const FLOW_TTL_MS = 10 * 60_000;
const JWKS_CACHE_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_SECONDS = 60;
const ACCESS_TOKEN_FALLBACK_SECONDS = 3600;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_PENDING_FLOWS = 500;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_ID_TOKEN_LENGTH = 32 * 1024;
const MAX_CODE_LENGTH = 4096;
const MAX_STATE_LENGTH = 512;

export type ChatGptDeployment = 'local' | 'remote';
export type FetchLike = typeof globalThis.fetch;

export interface ChatGptConfig {
  /** Human-readable app name sent as `agent_name_hint` on first registration. */
  agentName: string;
  /** Stable opaque host ID, e.g. `urn:uuid:<UUIDv4>`. Never an e-mail or user ID. */
  extAgentHostId: string;
  /** Must be `http://127.0.0.1:<port>/<path>` (official loopback requirement). */
  redirectUri: string;
  /** Only affects capability messages; it does not change the OAuth flow. */
  deployment?: ChatGptDeployment;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  jwksUri?: string;
  resource?: string;
  /** Lifetime of a pending login flow. Defaults to 10 minutes. */
  flowTtlMs?: number;
  /** JWKS cache lifetime. Defaults to 10 minutes. */
  jwksCacheTtlMs?: number;
  /** Allowed clock skew when validating ID tokens. Defaults to 60 seconds. */
  clockSkewSeconds?: number;
  /** Timeout for token/JWKS HTTP requests. Defaults to 15 seconds. */
  requestTimeoutMs?: number;
}

/**
 * Backend-provided persistence adapter. The module only sees opaque encrypted
 * strings: `encrypt` and `decrypt` are implemented by the integrator (for
 * example AES-256-GCM with a key from the environment), and `save`/`load`
 * store the ciphertext per user. Plaintext tokens must never be persisted.
 */
export interface ChatGptTokenStore {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
  load(userId: string): Promise<string | null>;
  save(userId: string, encrypted: string): Promise<void>;
  delete(userId: string): Promise<void>;
}

export type ChatGptErrorCode =
  | 'CHATGPT_DISABLED'
  | 'CHATGPT_NOT_CONFIGURED'
  | 'CHATGPT_INVALID_USER'
  | 'CHATGPT_FLOW_INVALID'
  | 'CHATGPT_FLOW_EXPIRED'
  | 'CHATGPT_ACCESS_DENIED'
  | 'CHATGPT_REGISTRATION_INCOMPLETE'
  | 'CHATGPT_TOKEN_EXCHANGE_FAILED'
  | 'CHATGPT_TOKEN_RESPONSE_INVALID'
  | 'CHATGPT_ID_TOKEN_INVALID'
  | 'CHATGPT_NOT_CONNECTED'
  | 'CHATGPT_REAUTH_REQUIRED'
  | 'CHATGPT_REFRESH_FAILED'
  | 'CHATGPT_STORE_ERROR'
  | 'CHATGPT_CREDENTIAL_INVALID';

export class ChatGptError extends Error {
  readonly code: ChatGptErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  /** Upstream OAuth error code (e.g. `invalid_grant`), never a token/description. */
  readonly upstreamError: string | null;

  constructor(
    code: ChatGptErrorCode,
    statusCode: number,
    message: string,
    options: { retryable?: boolean; upstreamError?: string | null } = {},
  ) {
    super(message);
    this.name = 'ChatGptError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = options.retryable ?? false;
    this.upstreamError = options.upstreamError ?? null;
  }
}

export interface ChatGptCapability {
  available: boolean;
  enabled: boolean;
  configured: boolean;
  missing: string[];
  warnings: string[];
  redirectUri: string | null;
  loopbackCallback: boolean;
  deployment: ChatGptDeployment;
  message: string;
}

export interface ChatGptLoginStart {
  authorizationUrl: string;
  /** ISO timestamp after which the pending flow is rejected. */
  expiresAt: string;
}

export interface ChatGptStatus {
  connected: boolean;
  pending: boolean;
  message: string;
  account?: {
    subject: string;
    email?: string;
    name?: string;
  };
  /** Access-token expiry. The connector can refresh after this. */
  expiresAt?: string;
  /** Refresh-token expiry (30 days, rotated on each refresh). */
  refreshExpiresAt?: string;
  /** Set only while a login flow is waiting for the browser callback. */
  pendingExpiresAt?: string;
  /** True when both ChatGPT plan usage scopes were granted. */
  planUsageGranted?: boolean;
}

export interface ChatGptCallbackInput {
  userId: string;
  code: string;
  state: string;
  /** OAuth `error` query parameter, if present. */
  error?: string | null;
  /** Issued `client_id` returned by the callback for a new registration. */
  clientId?: string | null;
}

export interface ChatGptOptions {
  config: ChatGptConfig;
  store: ChatGptTokenStore;
  enabled?: boolean;
  fetch?: FetchLike;
  now?: () => number;
}

export interface ChatGptEnvConfig {
  enabled: boolean;
  config: ChatGptConfig;
  missing: string[];
}

interface ResolvedConfig {
  agentName: string;
  extAgentHostId: string;
  redirectUri: string;
  deployment: ChatGptDeployment;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  resource: string;
  flowTtlMs: number;
  jwksCacheTtlMs: number;
  clockSkewSeconds: number;
  requestTimeoutMs: number;
}

interface PendingFlow {
  userId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}

interface StoredAccount {
  subject: string;
  email?: string;
  name?: string;
}

interface StoredCredential {
  version: 1;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  tokenType: string;
  scopes: string[];
  expiresAt: string;
  refreshExpiresAt: string;
  savedAt: string;
  extAgentHostId: string;
  account: StoredAccount;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  /** Present on authorization_code; optional on refresh (official token-reference). */
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope: string[];
}

interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  sub: string;
  nonce?: string;
  email?: string;
  name?: string;
}

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

function validateHostId(value: string): boolean {
  return (
    /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ||
    /^urn:ietf:params:oauth:jwk-thumbprint:[A-Za-z0-9._~-]+$/.test(value) ||
    /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(value)
  );
}

function validateLoopbackRedirect(value: string): { ok: boolean; reason: string | null } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'must be an absolute URL' };
  }
  if (url.protocol !== 'http:') return { ok: false, reason: 'must use http:// (loopback)' };
  if (url.hostname !== '127.0.0.1') return { ok: false, reason: 'host must be 127.0.0.1 (not localhost)' };
  if (url.port === '') return { ok: false, reason: 'must include an explicit port' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'must not contain credentials' };
  if (url.search !== '' || url.hash !== '') return { ok: false, reason: 'must not contain a query or fragment' };
  // Official SIWC: scheme, host and path are fixed; only the port may vary.
  // https://developers.openai.com/siwc/token-sharing-open-source/sign-in
  if (url.pathname !== '/auth/callback') {
    return { ok: false, reason: 'path must be /auth/callback (only the port may vary)' };
  }
  return { ok: true, reason: null };
}

function safeOpaqueValue(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && /^[\x21-\x7e]+$/.test(value);
}

function fromBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  return Buffer.from(value, 'base64url');
}

function decodeJsonSegment<T>(segment: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(segment).toString('utf8'));
  } catch {
    throw new Error('invalid JSON segment');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON segment must be an object');
  }
  return parsed as T;
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isTokenResponse(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function upstreamErrorCode(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>).error;
  if (typeof error === 'string' && safeOpaqueValue(error, 128)) return error;
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string' && safeOpaqueValue(code, 128)) return code;
  }
  return null;
}

/** Generate a stable host ID candidate for the initial deployment setup. */
export function newAgentHostId(): string {
  return `urn:uuid:${randomUUID()}`;
}

/**
 * Read the connector configuration from environment variables. Missing values
 * are reported (not invented), so `/api/ai/settings` can show an honest
 * capability state instead of failing at startup.
 */
export function chatGptConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ChatGptEnvConfig {
  const enabled = parseBoolean(env.AI_CHATGPT_ENABLED, true);
  const deploymentRaw = (env.AI_CHATGPT_DEPLOYMENT ?? 'local').trim().toLowerCase();
  const deployment: ChatGptDeployment = deploymentRaw === 'remote' ? 'remote' : 'local';
  const agentName = (env.AI_CHATGPT_AGENT_NAME ?? 'wind-up monitor').trim() || 'wind-up monitor';
  const extAgentHostId = (env.AI_CHATGPT_HOST_ID ?? '').trim();
  const redirectUri = (env.AI_CHATGPT_REDIRECT_URI ?? '').trim();

  const missing: string[] = [];
  if (extAgentHostId === '') missing.push('AI_CHATGPT_HOST_ID');
  if (redirectUri === '') missing.push('AI_CHATGPT_REDIRECT_URI');

  return {
    enabled,
    missing,
    config: {
      agentName,
      extAgentHostId,
      redirectUri,
      deployment,
    },
  };
}

export class ChatGptConnector {
  private readonly config: ResolvedConfig;
  private readonly store: ChatGptTokenStore;
  private readonly enabled: boolean;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  private readonly pendingByState = new Map<string, PendingFlow>();
  private readonly pendingByUser = new Map<string, string>();
  private readonly refreshLocks = new Map<string, Promise<ChatGptStatus>>();
  private jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
  private jwksPromise: Promise<Jwk[]> | null = null;

  constructor(options: ChatGptOptions) {
    this.config = {
      agentName: options.config.agentName.trim(),
      extAgentHostId: options.config.extAgentHostId.trim(),
      redirectUri: options.config.redirectUri.trim(),
      deployment: options.config.deployment ?? 'local',
      issuer: options.config.issuer ?? DEFAULT_ISSUER,
      authorizationEndpoint: options.config.authorizationEndpoint ?? DEFAULT_AUTHORIZATION_ENDPOINT,
      tokenEndpoint: options.config.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT,
      jwksUri: options.config.jwksUri ?? DEFAULT_JWKS_URI,
      resource: options.config.resource ?? DEFAULT_RESOURCE,
      flowTtlMs: options.config.flowTtlMs ?? FLOW_TTL_MS,
      jwksCacheTtlMs: options.config.jwksCacheTtlMs ?? JWKS_CACHE_TTL_MS,
      clockSkewSeconds: options.config.clockSkewSeconds ?? CLOCK_SKEW_SECONDS,
      requestTimeoutMs: Math.max(1_000, options.config.requestTimeoutMs ?? 15_000),    };
    this.store = options.store;
    this.enabled = options.enabled ?? true;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * Whether this deployment can start the official loopback flow. It checks
   * configuration only; it cannot detect network topology, so `remote`
   * deployments get a warning explaining the SSH-tunnel requirement.
   */
  capability(): ChatGptCapability {
    const missing = [...this.missingConfig()];
    const problems: string[] = [];
    const warnings: string[] = [];

    const redirect = validateLoopbackRedirect(this.config.redirectUri);
    if (this.config.redirectUri === '') {
      // Already reported as missing.
    } else if (!redirect.ok) {
      problems.push(`AI_CHATGPT_REDIRECT_URI ${redirect.reason ?? 'is invalid'}`);
    }

    if (this.config.extAgentHostId !== '' && !validateHostId(this.config.extAgentHostId)) {
      problems.push(
        'AI_CHATGPT_HOST_ID must be an opaque urn:uuid:<UUIDv4>, urn:ietf:params:oauth:jwk-thumbprint:..., or did:key:... value',
      );
    }

    for (const [label, value] of [
      ['issuer', this.config.issuer],
      ['authorization endpoint', this.config.authorizationEndpoint],
      ['token endpoint', this.config.tokenEndpoint],
      ['JWKS URI', this.config.jwksUri],
      ['resource', this.config.resource],
    ] as const) {
      if (!isHttpsUrl(value)) problems.push(`${label} must be an absolute https URL without query/fragment`);
    }

    if (this.config.deployment === 'remote') {
      warnings.push(
        'remote deployment: the browser calls 127.0.0.1 on the user machine; use an SSH tunnel or a browser on the Core host, otherwise the callback cannot reach Core',
      );
    }

    const configured = missing.length === 0 && problems.length === 0;
    const available = this.enabled && configured;
    let message: string;
    if (!this.enabled) message = 'ChatGPT connector is disabled (AI_CHATGPT_ENABLED=false).';
    else if (missing.length > 0) message = `ChatGPT connector is not configured: missing ${missing.join(', ')}.`;
    else if (!configured) message = 'ChatGPT connector configuration is invalid; see warnings.';
    else if (warnings.length > 0) message = 'ChatGPT connector is ready; review deployment warnings before remote use.';
    else message = 'ChatGPT connector is ready. Sign-in uses the official loopback OAuth flow.';

    return {
      available,
      enabled: this.enabled,
      configured,
      missing,
      warnings: [...problems, ...warnings],
      redirectUri: this.config.redirectUri === '' ? null : this.config.redirectUri,
      loopbackCallback: redirect.ok,
      deployment: this.config.deployment,
      message,
    };
  }

  /**
   * Start a login flow for one user. The returned URL contains only the public
   * OAuth parameters (state, nonce, PKCE challenge); the verifier stays in
   * memory and is never returned to the UI.
   */
  async startLogin(userId: string): Promise<ChatGptLoginStart> {
    this.assertConfigured();
    if (!safeOpaqueValue(userId, 256)) {
      throw new ChatGptError('CHATGPT_INVALID_USER', 400, 'A valid userId is required to start ChatGPT login');
    }

    this.pruneFlows();
    const existing = await this.loadCredentialForLogin(userId);

    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
    const now = this.now();
    const expiresAt = now + this.config.flowTtlMs;

    const clientId = existing?.clientId ?? DYNAMIC_CLIENT_ID;
    const flow: PendingFlow = {
      userId,
      state,
      nonce,
      codeVerifier,
      clientId,
      redirectUri: this.config.redirectUri,
      createdAt: now,
      expiresAt,
    };

    this.removePendingForUser(userId);
    if (this.pendingByState.size >= MAX_PENDING_FLOWS) {
      const oldest = this.pendingByState.values().next().value as PendingFlow | undefined;
      if (oldest) this.removeFlow(oldest.state);
    }
    this.pendingByState.set(state, flow);
    this.pendingByUser.set(userId, state);

    const url = new URL(this.config.authorizationEndpoint);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', CHATGPT_REQUIRED_SCOPES.join(' '));
    url.searchParams.set('resource', this.config.resource);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('ext_agent_host_id', this.config.extAgentHostId);
    if (clientId === DYNAMIC_CLIENT_ID) {
      url.searchParams.set('agent_name_hint', this.config.agentName);
    }

    return { authorizationUrl: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Complete the browser callback. The flow is consumed before the token
   * exchange, so a `state`/code cannot be replayed. `clientId` is the issued
   * `client_id` returned in the callback on first registration.
   */
  async completeCallback(input: ChatGptCallbackInput): Promise<ChatGptStatus> {
    this.assertConfigured();
    const flow = this.consumeFlow(input.state, input.userId);

    if (input.error) {
      throw new ChatGptError(
        'CHATGPT_ACCESS_DENIED',
        403,
        input.error === 'access_denied'
          ? 'ChatGPT sign-in was declined; no permissions were granted.'
          : 'ChatGPT sign-in failed before token exchange.',
        { upstreamError: safeOpaqueValue(input.error, 128) ? input.error : null },
      );
    }

    if (!safeOpaqueValue(input.code, MAX_CODE_LENGTH)) {
      throw new ChatGptError('CHATGPT_FLOW_INVALID', 400, 'Missing or invalid OAuth authorization code');
    }

    const callbackClientId = stringClaim(input.clientId ?? undefined);
    let clientId = flow.clientId;
    if (callbackClientId !== undefined) {
      if (!safeOpaqueValue(callbackClientId, 256) || callbackClientId === DYNAMIC_CLIENT_ID) {
        throw new ChatGptError('CHATGPT_REGISTRATION_INCOMPLETE', 502, 'The callback returned an invalid client_id');
      }
      if (flow.clientId !== DYNAMIC_CLIENT_ID && flow.clientId !== callbackClientId) {
        throw new ChatGptError(
          'CHATGPT_FLOW_INVALID',
          400,
          'The callback client_id does not match the pending authorization',
        );
      }
      clientId = callbackClientId;
    } else if (flow.clientId === DYNAMIC_CLIENT_ID) {
      throw new ChatGptError(
        'CHATGPT_REGISTRATION_INCOMPLETE',
        502,
        'First-time registration did not return an issued client_id; start sign-in again',
      );
    }

    const token = await this.exchangeToken({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: flow.codeVerifier,
      redirect_uri: flow.redirectUri,
      client_id: clientId,
      resource: this.config.resource,
    });

    if (!token.id_token) {
      // Defensive: exchangeToken already enforces this for authorization_code.
      throw new ChatGptError(
        'CHATGPT_TOKEN_RESPONSE_INVALID',
        502,
        'OpenAI token response did not include an ID token',
      );
    }
    const claims = await this.verifyIdToken(token.id_token, {
      clientId,
      nonce: flow.nonce,
    });

    const now = this.now();
    const credential: StoredCredential = {
      version: 1,
      clientId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      idToken: token.id_token,
      tokenType: token.token_type,
      scopes: token.scope,
      expiresAt: new Date(now + token.expires_in * 1000).toISOString(),
      refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(),
      savedAt: new Date(now).toISOString(),
      extAgentHostId: this.config.extAgentHostId,
      account: {
        subject: claims.sub,
        ...(claims.email ? { email: claims.email } : {}),
        ...(claims.name ? { name: claims.name } : {}),
      },
    };

    await this.saveCredential(input.userId, credential);
    return this.status(input.userId);
  }

  /** Connection state without exposing any credential material. */
  async status(userId: string): Promise<ChatGptStatus> {
    this.pruneFlows();
    const pendingState = this.pendingByUser.get(userId);
    const pendingFlow = pendingState ? this.pendingByState.get(pendingState) : undefined;
    const pending = pendingFlow !== undefined;
    const base = {
      pending,
      ...(pendingFlow ? { pendingExpiresAt: new Date(pendingFlow.expiresAt).toISOString() } : {}),
    };

    let credential: StoredCredential | null;
    try {
      credential = await this.loadCredential(userId);
    } catch (error) {
      if (error instanceof ChatGptError && error.code === 'CHATGPT_CREDENTIAL_INVALID') {
        return {
          ...base,
          connected: false,
          message: 'Stored ChatGPT credential is invalid; sign out and sign in again.',
        };
      }
      throw error;
    }

    if (credential === null) {
      return {
        ...base,
        connected: false,
        message: pending ? 'ChatGPT sign-in is waiting for the browser callback.' : 'ChatGPT is not connected.',
      };
    }

    const now = this.now();
    const refreshExpiresAt = Date.parse(credential.refreshExpiresAt);
    const accessExpiresAt = Date.parse(credential.expiresAt);
    const refreshValid = Number.isFinite(refreshExpiresAt) && now < refreshExpiresAt;
    const accessValid = Number.isFinite(accessExpiresAt) && now < accessExpiresAt;
    const planUsageGranted =
      credential.scopes.includes('chatgpt.tokens.use.direct') && credential.scopes.includes('resource.invoke');
    const who = credential.account.email ?? credential.account.subject;

    let message: string;
    if (!refreshValid) message = `ChatGPT session expired${who ? ` for ${who}` : ''}; sign in again.`;
    else if (!planUsageGranted) message = `Signed in as ${who}, but ChatGPT plan usage was not granted; sign in again and allow plan usage.`;
    else if (!accessValid) message = `Connected as ${who}; access token expired and must be refreshed.`;
    else if (pending) message = `Connected as ${who}; a new sign-in is pending.`;
    else message = `Connected as ${who}.`;

    return {
      ...base,
      connected: refreshValid,
      message,
      account: {
        subject: credential.account.subject,
        ...(credential.account.email ? { email: credential.account.email } : {}),
        ...(credential.account.name ? { name: credential.account.name } : {}),
      },
      expiresAt: credential.expiresAt,
      refreshExpiresAt: credential.refreshExpiresAt,
      planUsageGranted,
    };
  }

  /**
   * Refresh the access token. Refresh tokens rotate; the new credential is
   * persisted as one unit. Concurrent refreshes for the same user are
   * serialized in-process (official guidance for rotating tokens). A terminal
   * `invalid_grant` deletes the credential and requires a fresh sign-in.
   */
  async refresh(userId: string): Promise<ChatGptStatus> {
    this.assertConfigured();
    const inFlight = this.refreshLocks.get(userId);
    if (inFlight) return inFlight;

    const pending: Promise<ChatGptStatus> = this.performRefresh(userId).finally(() => {
      if (this.refreshLocks.get(userId) === pending) this.refreshLocks.delete(userId);
    });
    this.refreshLocks.set(userId, pending);
    return pending;
  }

  private async performRefresh(userId: string): Promise<ChatGptStatus> {
    const credential = await this.loadCredential(userId);
    if (credential === null) {
      throw new ChatGptError('CHATGPT_NOT_CONNECTED', 409, 'ChatGPT is not connected');
    }

    const refreshExpiresAt = Date.parse(credential.refreshExpiresAt);
    if (!Number.isFinite(refreshExpiresAt) || this.now() >= refreshExpiresAt) {
      await this.deleteCredential(userId);
      throw new ChatGptError('CHATGPT_REAUTH_REQUIRED', 401, 'ChatGPT refresh token expired; sign in again');
    }

    let token: TokenResponse;
    try {
      token = await this.exchangeToken(
        {
          grant_type: 'refresh_token',
          refresh_token: credential.refreshToken,
          client_id: credential.clientId,
          resource: this.config.resource,
        },
        { requireIdToken: false },
      );
    } catch (error) {
      if (error instanceof ChatGptError && error.upstreamError === 'invalid_grant') {
        await this.deleteCredential(userId);
        throw new ChatGptError('CHATGPT_REAUTH_REQUIRED', 401, 'ChatGPT refresh was rejected; sign in again');
      }
      throw error;
    }

    // Official token-reference only guarantees a new access token and a
    // replacement refresh token. If an ID token is present, verify it fully
    // (signature, issuer, audience, subject); otherwise keep the identity that
    // was verified during authorization-code exchange. Never decode an
    // unsigned/unverified token just to refresh account data.
    const claims = token.id_token
      ? await this.verifyIdToken(token.id_token, {
          clientId: credential.clientId,
          expectedSubject: credential.account.subject,
        })
      : null;

    const now = this.now();
    const next: StoredCredential = {
      ...credential,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      idToken: token.id_token ?? credential.idToken,
      tokenType: token.token_type,
      scopes: token.scope.length > 0 ? token.scope : credential.scopes,
      expiresAt: new Date(now + token.expires_in * 1000).toISOString(),
      refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(),
      savedAt: new Date(now).toISOString(),
      account: claims
        ? {
            subject: claims.sub,
            ...(claims.email
              ? { email: claims.email }
              : credential.account.email
                ? { email: credential.account.email }
                : {}),
            ...(claims.name
              ? { name: claims.name }
              : credential.account.name
                ? { name: credential.account.name }
                : {}),
          }
        : credential.account,
    };

    await this.saveCredential(userId, next);
    return this.status(userId);
  }

  /**
   * Remove the local credential and any pending flow. SIWC does not document
   * a token-revocation endpoint; ChatGPT-side revocation stays in ChatGPT
   * settings. No remote call is made here.
   */
  async logout(userId: string): Promise<void> {
    this.removePendingForUser(userId);
    await this.deleteCredential(userId);
  }

  private assertConfigured(): void {
    const capability = this.capability();
    if (!capability.available) {
      if (!this.enabled) {
        throw new ChatGptError('CHATGPT_DISABLED', 503, capability.message);
      }
      throw new ChatGptError('CHATGPT_NOT_CONFIGURED', 503, capability.message);
    }
  }

  private missingConfig(): string[] {
    const missing: string[] = [];
    if (this.config.extAgentHostId === '') missing.push('AI_CHATGPT_HOST_ID');
    if (this.config.redirectUri === '') missing.push('AI_CHATGPT_REDIRECT_URI');
    if (this.config.agentName === '') missing.push('AI_CHATGPT_AGENT_NAME');
    return missing;
  }

  private pruneFlows(): void {
    const now = this.now();
    for (const [state, flow] of this.pendingByState) {
      if (now >= flow.expiresAt) this.removeFlow(state);
    }
  }

  private removeFlow(state: string): void {
    const flow = this.pendingByState.get(state);
    if (!flow) return;
    this.pendingByState.delete(state);
    if (this.pendingByUser.get(flow.userId) === state) this.pendingByUser.delete(flow.userId);
  }

  private removePendingForUser(userId: string): void {
    const state = this.pendingByUser.get(userId);
    if (state) this.removeFlow(state);
  }

  private consumeFlow(state: string, userId: string): PendingFlow {
    if (!safeOpaqueValue(state, MAX_STATE_LENGTH)) {
      throw new ChatGptError('CHATGPT_FLOW_INVALID', 400, 'Missing or invalid OAuth state');
    }
    const flow = this.pendingByState.get(state);
    if (!flow) {
      throw new ChatGptError('CHATGPT_FLOW_INVALID', 400, 'Unknown or already used OAuth state; start sign-in again');
    }
    if (flow.userId !== userId) {
      // Do not consume a flow belonging to another session.
      throw new ChatGptError('CHATGPT_FLOW_INVALID', 400, 'OAuth state does not belong to this session');
    }

    this.removeFlow(state);
    if (this.now() >= flow.expiresAt) {
      throw new ChatGptError('CHATGPT_FLOW_EXPIRED', 400, 'ChatGPT sign-in flow expired; start sign-in again');
    }
    return flow;
  }

  private async loadCredentialForLogin(userId: string): Promise<StoredCredential | null> {
    try {
      return await this.loadCredential(userId);
    } catch (error) {
      if (error instanceof ChatGptError && error.code === 'CHATGPT_CREDENTIAL_INVALID') {
        throw new ChatGptError(
          'CHATGPT_CREDENTIAL_INVALID',
          500,
          'Stored ChatGPT credential is invalid; sign out before signing in again',
        );
      }
      throw error;
    }
  }

  private async loadCredential(userId: string): Promise<StoredCredential | null> {
    let encrypted: string | null;
    try {
      encrypted = await this.store.load(userId);
    } catch {
      throw new ChatGptError('CHATGPT_STORE_ERROR', 500, 'Could not read the stored ChatGPT credential');
    }
    if (encrypted === null) return null;

    let plaintext: string;
    try {
      plaintext = await this.store.decrypt(encrypted);
    } catch {
      throw new ChatGptError('CHATGPT_CREDENTIAL_INVALID', 500, 'Stored ChatGPT credential could not be decrypted');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new ChatGptError('CHATGPT_CREDENTIAL_INVALID', 500, 'Stored ChatGPT credential is not valid JSON');
    }
    if (!this.isStoredCredential(parsed)) {
      throw new ChatGptError('CHATGPT_CREDENTIAL_INVALID', 500, 'Stored ChatGPT credential has an invalid shape');
    }
    return parsed;
  }

  private isStoredCredential(value: unknown): value is StoredCredential {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const account = record.account;
    return (
      record.version === 1 &&
      typeof record.clientId === 'string' &&
      record.clientId.length > 0 &&
      record.clientId !== DYNAMIC_CLIENT_ID &&
      typeof record.accessToken === 'string' &&
      record.accessToken.length > 0 &&
      typeof record.refreshToken === 'string' &&
      record.refreshToken.length > 0 &&
      typeof record.idToken === 'string' &&
      record.idToken.length > 0 &&
      typeof record.tokenType === 'string' &&
      record.tokenType.length > 0 &&
      Array.isArray(record.scopes) &&
      record.scopes.every((scope) => typeof scope === 'string') &&
      typeof record.expiresAt === 'string' &&
      Number.isFinite(Date.parse(record.expiresAt)) &&
      typeof record.refreshExpiresAt === 'string' &&
      Number.isFinite(Date.parse(record.refreshExpiresAt)) &&
      typeof record.savedAt === 'string' &&
      Number.isFinite(Date.parse(record.savedAt)) &&
      typeof record.extAgentHostId === 'string' &&
      account !== null &&
      typeof account === 'object' &&
      !Array.isArray(account) &&
      typeof (account as Record<string, unknown>).subject === 'string' &&
      ((account as Record<string, unknown>).subject as string).length > 0
    );
  }

  private async saveCredential(userId: string, credential: StoredCredential): Promise<void> {
    let encrypted: string;
    try {
      encrypted = await this.store.encrypt(JSON.stringify(credential));
    } catch {
      throw new ChatGptError('CHATGPT_STORE_ERROR', 500, 'Could not encrypt the ChatGPT credential');
    }
    if (encrypted.length === 0) {
      throw new ChatGptError('CHATGPT_STORE_ERROR', 500, 'Credential encryption returned an empty value');
    }
    try {
      await this.store.save(userId, encrypted);
    } catch {
      throw new ChatGptError('CHATGPT_STORE_ERROR', 500, 'Could not save the ChatGPT credential');
    }
  }

  private async deleteCredential(userId: string): Promise<void> {
    try {
      await this.store.delete(userId);
    } catch {
      throw new ChatGptError('CHATGPT_STORE_ERROR', 500, 'Could not delete the stored ChatGPT credential');
    }
  }

  private async exchangeToken(
    params: Record<string, string>,
    options: { requireIdToken?: boolean } = {},
  ): Promise<TokenResponse> {
    const body = new URLSearchParams(params).toString();
    let response: Response;
    try {
      response = await this.fetchFn(this.config.tokenEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch {
      throw new ChatGptError('CHATGPT_TOKEN_EXCHANGE_FAILED', 502, 'Could not reach the OpenAI token endpoint', {
        retryable: true,
      });
    }

    const text = await this.readLimitedBody(response);
    let parsed: unknown = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const code = upstreamErrorCode(parsed);
      const retryable = response.status === 429 || response.status >= 500;
      throw new ChatGptError(
        'CHATGPT_TOKEN_EXCHANGE_FAILED',
        502,
        `OpenAI token endpoint rejected the request (HTTP ${response.status})`,
        { retryable, upstreamError: code },
      );
    }
    if (!isTokenResponse(parsed)) {
      throw new ChatGptError('CHATGPT_TOKEN_RESPONSE_INVALID', 502, 'OpenAI token endpoint returned invalid JSON');
    }

    const accessToken = stringClaim(parsed.access_token);
    const refreshToken = stringClaim(parsed.refresh_token);
    const idToken = stringClaim(parsed.id_token);
    const tokenType = stringClaim(parsed.token_type) ?? 'Bearer';
    const expiresInRaw = parsed.expires_in;
    const expiresIn =
      typeof expiresInRaw === 'number' && Number.isFinite(expiresInRaw) && expiresInRaw > 0
        ? Math.floor(expiresInRaw)
        : ACCESS_TOKEN_FALLBACK_SECONDS;
    const scopeRaw = parsed.scope;
    const scope =
      typeof scopeRaw === 'string'
        ? scopeRaw.split(/\s+/).filter((item) => item.length > 0)
        : [];

    const requireIdToken = options.requireIdToken ?? true;
    if (!accessToken || !refreshToken || (requireIdToken && !idToken)) {
      throw new ChatGptError(
        'CHATGPT_TOKEN_RESPONSE_INVALID',
        502,
        requireIdToken
          ? 'OpenAI token response did not include access, refresh and ID tokens (offline_access is required)'
          : 'OpenAI token response did not include access and refresh tokens (offline_access is required)',
      );
    }
    if (!safeOpaqueValue(tokenType, 32)) {
      throw new ChatGptError('CHATGPT_TOKEN_RESPONSE_INVALID', 502, 'OpenAI token response had an invalid token type');
    }

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(idToken ? { id_token: idToken } : {}),
      token_type: tokenType,
      expires_in: expiresIn,
      scope,
    };
  }

  private async readLimitedBody(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text.length > MAX_TOKEN_RESPONSE_BYTES ? text.slice(0, MAX_TOKEN_RESPONSE_BYTES) : text;
    } catch {
      throw new ChatGptError('CHATGPT_TOKEN_RESPONSE_INVALID', 502, 'Could not read the OpenAI token response');
    }
  }

  private async verifyIdToken(
    token: string,
    options: { clientId: string; nonce?: string; expectedSubject?: string },
  ): Promise<IdTokenClaims> {
    if (token.length > MAX_ID_TOKEN_LENGTH) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token is too large');
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token is not a valid JWT');
    }
    const [headerPart, payloadPart, signaturePart] = parts;
    if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token is not a valid JWT');
    }

    let header: JwtHeader;
    let payload: Record<string, unknown>;
    try {
      header = decodeJsonSegment<JwtHeader>(headerPart);
      payload = decodeJsonSegment<Record<string, unknown>>(payloadPart);
    } catch {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token has invalid JSON segments');
    }

    if (header.alg !== 'RS256') {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token must use RS256');
    }
    if (typeof header.kid !== 'string' || header.kid.length === 0) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token has no key ID');
    }

    const key = await this.getSigningKey(header.kid);
    let signatureValid = false;
    try {
      signatureValid = verifySignature(
        'RSA-SHA256',
        Buffer.from(`${headerPart}.${payloadPart}`, 'utf8'),
        key,
        fromBase64Url(signaturePart),
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token signature is invalid');
    }

    const nowSeconds = Math.floor(this.now() / 1000);
    const skew = this.config.clockSkewSeconds;
    const issuer = stringClaim(payload.iss);
    if (issuer !== this.config.issuer) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token issuer is invalid');
    }

    const audience = payload.aud;
    const audiences = typeof audience === 'string' ? [audience] : Array.isArray(audience) ? audience : [];
    if (!audiences.includes(options.clientId)) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token audience is invalid');
    }

    const exp = payload.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp) || nowSeconds > exp + skew) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token is expired or has no expiry');
    }
    if (typeof payload.iat === 'number' && payload.iat > nowSeconds + skew) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token was issued in the future');
    }
    if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds + skew) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token is not valid yet');
    }

    const subject = stringClaim(payload.sub);
    if (!subject) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token has no subject');
    }
    if (options.expectedSubject !== undefined && subject !== options.expectedSubject) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token subject does not match the connected account');
    }
    if (options.nonce !== undefined) {
      const nonce = stringClaim(payload.nonce);
      if (nonce !== options.nonce) {
        throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token nonce is invalid');
      }
    }

    const claims: IdTokenClaims = {
      iss: issuer,
      aud: audience as string | string[],
      exp,
      sub: subject,
      ...(typeof payload.iat === 'number' ? { iat: payload.iat } : {}),
      ...(typeof payload.nbf === 'number' ? { nbf: payload.nbf } : {}),
      ...(stringClaim(payload.nonce) ? { nonce: stringClaim(payload.nonce) as string } : {}),
      ...(stringClaim(payload.email) ? { email: stringClaim(payload.email) as string } : {}),
      ...(stringClaim(payload.name) ? { name: stringClaim(payload.name) as string } : {}),
    };
    return claims;
  }

  private async getSigningKey(kid: string): Promise<ReturnType<typeof createPublicKey>> {
    let keys = await this.getJwks(false);
    let jwk = keys.find((candidate) => candidate.kid === kid && candidate.kty === 'RSA');
    if (!jwk) {
      keys = await this.getJwks(true);
      jwk = keys.find((candidate) => candidate.kid === kid && candidate.kty === 'RSA');
    }
    if (!jwk) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token signing key is unknown');
    }
    if (jwk.alg !== undefined && jwk.alg !== 'RS256') {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI ID token signing key has an unexpected algorithm');
    }
    try {
      return createPublicKey({ key: jwk, format: 'jwk' });
    } catch {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 401, 'OpenAI signing key is invalid');
    }
  }

  private async getJwks(forceRefresh: boolean): Promise<Jwk[]> {
    const now = this.now();
    if (!forceRefresh && this.jwksCache !== null && now - this.jwksCache.fetchedAt < this.config.jwksCacheTtlMs) {
      return this.jwksCache.keys;
    }
    if (!forceRefresh && this.jwksPromise !== null) return this.jwksPromise;

    const request = this.fetchJwks();
    this.jwksPromise = request;
    try {
      const keys = await request;
      this.jwksCache = { keys, fetchedAt: now };
      return keys;
    } finally {
      if (this.jwksPromise === request) this.jwksPromise = null;
    }
  }

  private async fetchJwks(): Promise<Jwk[]> {
    let response: Response;
    try {
      response = await this.fetchFn(this.config.jwksUri, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 502, 'Could not reach the OpenAI JWKS endpoint', {
        retryable: true,
      });
    }
    if (!response.ok) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 502, 'OpenAI JWKS endpoint rejected the request', {
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 502, 'OpenAI JWKS response is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 502, 'OpenAI JWKS response is invalid');
    }
    const keys = (parsed as Record<string, unknown>).keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new ChatGptError('CHATGPT_ID_TOKEN_INVALID', 502, 'OpenAI JWKS response contains no keys');
    }
    return keys.filter(
      (key): key is Jwk =>
        key !== null &&
        typeof key === 'object' &&
        !Array.isArray(key) &&
        (key as Record<string, unknown>).kty === 'RSA' &&
        typeof (key as Record<string, unknown>).kid === 'string',
    );
  }
}

// ---------------------------------------------------------------------------
// Backend integration surface (docs/ai-integration-contract.md §8)
// ---------------------------------------------------------------------------

/**
 * Storage adapter owned by the backend. It encrypts at rest (AES-256-GCM,
 * `AI_CREDENTIAL_KEY`) and keeps one record per user. The module passes an
 * opaque credential object; it never sees the ciphertext format.
 */
export interface ChatgptSecretStore {
  save(userId: string, secret: unknown, opts?: { keyHint?: string | null }): Promise<void>;
  load(userId: string): Promise<unknown | null>;
  delete(userId: string): Promise<void>;
}

/** Contract status shape: no tokens, only connection state. */
export interface ChatgptIntegrationStatus {
  connected: boolean;
  pending: boolean;
  message: string | null;
}

export interface ChatgptCallbackParams {
  code: string;
  state: string;
  clientId?: string | null;
  error?: string | null;
}

/**
 * Surface used by the backend AI routes. `completeCallback` is required so the
 * loopback GET callback can finish the flow; the contract lists login/status/
 * logout and this module adds the callback + refresh needed to make it real.
 */
export interface ChatgptIntegration {
  isAvailable(): { ok: boolean; reason: string | null };
  login(userId: string): Promise<{ authorizationUrl: string }>;
  completeCallback(userId: string, params: ChatgptCallbackParams): Promise<ChatgptIntegrationStatus>;
  status(userId: string): Promise<ChatgptIntegrationStatus>;
  logout(userId: string): Promise<void>;
  refresh(userId: string): Promise<ChatgptIntegrationStatus>;
}

export interface ChatgptIntegrationDeps {
  storage: ChatgptSecretStore;
  /** Overrides merged over values read from `env`. */
  config?: Partial<ChatGptConfig>;
  env?: NodeJS.ProcessEnv;
  enabled?: boolean;
  fetch?: FetchLike;
  now?: () => number;
}

function secretStoreAdapter(storage: ChatgptSecretStore): ChatGptTokenStore {
  return {
    // The backend store already persists encrypted objects; the module only
    // handles JSON serialization around it.
    async encrypt(plaintext: string): Promise<string> {
      return plaintext;
    },
    async decrypt(ciphertext: string): Promise<string> {
      return ciphertext;
    },
    async load(userId: string): Promise<string | null> {
      const value = await storage.load(userId);
      if (value === null || value === undefined) return null;
      // Contract adapters normally return the decrypted object. Accept a JSON
      // string too, for stores that serialize before encrypting.
      if (typeof value === 'string') return value;
      return JSON.stringify(value);
    },
    async save(userId: string, payload: string): Promise<void> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        throw new Error('ChatGPT credential payload is not valid JSON');
      }
      await storage.save(userId, parsed, { keyHint: null });
    },
    async delete(userId: string): Promise<void> {
      await storage.delete(userId);
    },
  };
}

function toIntegrationStatus(status: ChatGptStatus): ChatgptIntegrationStatus {
  return {
    connected: status.connected,
    pending: status.pending,
    message: status.message.length > 0 ? status.message : null,
  };
}

/**
 * Build the contract-shaped integration (`ChatgptIntegration`) backed by the
 * connector. The backend calls only these methods; the SIWC flow itself stays
 * inside this module.
 */
export function createChatgptIntegration(deps: ChatgptIntegrationDeps): ChatgptIntegration {
  const envConfig = chatGptConfigFromEnv(deps.env);
  const config: ChatGptConfig = { ...envConfig.config, ...deps.config };
  const connector = new ChatGptConnector({
    config,
    store: secretStoreAdapter(deps.storage),
    enabled: deps.enabled ?? envConfig.enabled,
    fetch: deps.fetch,
    now: deps.now,
  });

  return {
    isAvailable(): { ok: boolean; reason: string | null } {
      const capability = connector.capability();
      return { ok: capability.available, reason: capability.available ? null : capability.message };
    },

    async login(userId: string): Promise<{ authorizationUrl: string }> {
      const start = await connector.startLogin(userId);
      return { authorizationUrl: start.authorizationUrl };
    },

    async completeCallback(userId: string, params: ChatgptCallbackParams): Promise<ChatgptIntegrationStatus> {
      const status = await connector.completeCallback({
        userId,
        code: params.code,
        state: params.state,
        clientId: params.clientId ?? null,
        error: params.error ?? null,
      });
      return toIntegrationStatus(status);
    },

    async status(userId: string): Promise<ChatgptIntegrationStatus> {
      return toIntegrationStatus(await connector.status(userId));
    },

    async logout(userId: string): Promise<void> {
      await connector.logout(userId);
    },

    async refresh(userId: string): Promise<ChatgptIntegrationStatus> {
      return toIntegrationStatus(await connector.refresh(userId));
    },
  };
}
