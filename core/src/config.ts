import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export type NodeEnv = 'production' | 'development' | 'test';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface AppConfig {
  nodeEnv: NodeEnv;
  host: string;
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  cookieSecure: boolean;
  cookieName: string;
  sessionAbsoluteTtlMs: number;
  sessionSlidingTtlMs: number;
  trustProxy: boolean;
  allowedOrigins: string[];
  bootstrapTokenFile: string;
  bootstrapTtlMs: number;
  bootstrapTokenStdout: boolean;
  enrollTokenTtlMs: number;
  heartbeatIntervalS: number;
  agentStaleSeconds: number;
  agentOfflineSeconds: number;
  lateSampleSeconds: number;
  configVersion: number;
  logLevel: string;
  webDistDir: string;
  loginRateLimit: RateLimitRule;
  bootstrapRateLimit: RateLimitRule;
  enrollRateLimit: RateLimitRule;
  rotateDailyLimit: number;
  /** Raw AI credential key (AI_CREDENTIAL_KEY); null when unset. Never logged. */
  aiCredentialKey: string | null;
  /** Provider API bases (overridable for tests/self-hosted gateways). */
  openrouterBaseUrl: string;
  openaiBaseUrl: string;
  /** Timeout for outbound provider connection checks (ms). */
  aiRequestTimeoutMs: number;
}

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Loads configuration from the environment. Fails fast on missing/invalid
 * required values so a misconfigured deployment never starts half-way.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV as NodeEnv | undefined) ?? 'development';
  if (nodeEnv !== 'production' && nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new Error(`NODE_ENV must be production|development|test, got "${nodeEnv}"`);
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  let sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    if (nodeEnv === 'production') {
      throw new Error('SESSION_SECRET must be at least 32 characters in production');
    }
    // Local development/test convenience only: ephemeral secret (sessions do
    // not survive a restart). Never used in production.
    sessionSecret = randomBytes(48).toString('base64url');
  }

  const cookieSecure = bool(env.COOKIE_SECURE, nodeEnv === 'production');
  // __Host- prefix requires Secure + Path=/ + no Domain, so it is only used
  // when the cookie is actually flagged Secure (TLS / production).
  const cookieName = cookieSecure ? '__Host-sp_session' : 'sp_session';

  const explicitOrigins = csv(env.ALLOWED_ORIGINS);

  return {
    nodeEnv,
    host: env.HOST ?? '127.0.0.1',
    port: int(env.PORT, 8080),
    databaseUrl,
    sessionSecret,
    cookieSecure,
    cookieName,
    sessionAbsoluteTtlMs: int(env.SESSION_ABSOLUTE_TTL_DAYS, 30) * 86_400_000,
    sessionSlidingTtlMs: int(env.SESSION_SLIDING_TTL_DAYS, 7) * 86_400_000,
    trustProxy: bool(env.TRUST_PROXY, false),
    allowedOrigins: [...explicitOrigins, ...DEFAULT_ALLOWED_ORIGINS],
    bootstrapTokenFile: resolve(env.BOOTSTRAP_TOKEN_FILE ?? 'data/bootstrap-token'),
    bootstrapTtlMs: int(env.BOOTSTRAP_TOKEN_TTL_MINUTES, 30) * 60_000,
    bootstrapTokenStdout: bool(env.BOOTSTRAP_TOKEN_STDOUT, false),
    enrollTokenTtlMs: int(env.ENROLL_TOKEN_TTL_MINUTES, 15) * 60_000,
    heartbeatIntervalS: int(env.AGENT_HEARTBEAT_INTERVAL_S, 15),
    agentStaleSeconds: int(env.AGENT_STALE_SECONDS, 45),
    agentOfflineSeconds: int(env.AGENT_OFFLINE_SECONDS, 300),
    lateSampleSeconds: int(env.LATE_SAMPLE_SECONDS, 600),
    configVersion: int(env.CONFIG_VERSION, 1),
    logLevel: env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    webDistDir: resolve(env.WEB_DIST_DIR ?? '../web/dist'),
    loginRateLimit: { limit: int(env.LOGIN_RATE_LIMIT, 5), windowMs: int(env.LOGIN_RATE_WINDOW_MINUTES, 5) * 60_000 },
    bootstrapRateLimit: { limit: int(env.BOOTSTRAP_RATE_LIMIT, 10), windowMs: int(env.BOOTSTRAP_RATE_WINDOW_MINUTES, 10) * 60_000 },
    enrollRateLimit: { limit: int(env.ENROLL_RATE_LIMIT, 10), windowMs: int(env.ENROLL_RATE_WINDOW_MINUTES, 10) * 60_000 },
    rotateDailyLimit: int(env.ROTATE_DAILY_LIMIT, 5),
    // Optional: absence is not a startup failure. Reads of AI settings work
    // without it; storing secrets fails with a clear AI_CREDENTIAL_KEY_MISSING
    // configuration error instead of any random fallback (DEC: fail loud).
    aiCredentialKey: env.AI_CREDENTIAL_KEY && env.AI_CREDENTIAL_KEY.length > 0 ? env.AI_CREDENTIAL_KEY : null,
    openrouterBaseUrl: (env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    openaiBaseUrl: (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
    aiRequestTimeoutMs: int(env.AI_REQUEST_TIMEOUT_MS, 10_000),
  };
}
