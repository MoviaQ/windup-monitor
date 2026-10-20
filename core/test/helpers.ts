import { readFile } from 'node:fs/promises';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createPrismaClient, type Db } from '../src/db/client.js';
import { createContext } from '../src/context.js';
import { buildApp } from '../src/app.js';
import { ensureBootstrapState } from '../src/bootstrap/state.js';

/**
 * Per-process scratch root. Concurrent full-suite runs (separate workers or
 * separate `vitest` processes against different databases) must never share
 * the bootstrap token file — a shared path lets one run overwrite the token
 * another run just wrote to its (freshly truncated) database, producing
 * spurious INVALID_BOOTSTRAP_TOKEN failures. Each OS process gets its own
 * directory; only the owning process removes it (see global-teardown.ts).
 */
export function testTmpRoot(): string {
  return join(tmpdir(), `sp-test-${process.pid}`);
}

// Best-effort removal of only this process's own scratch directory on exit.
// Concurrent `vitest` runs use distinct `sp-test-<pid>` directories, so one
// run never deletes another run's bootstrap token file.
process.once('exit', () => {
  try {
    rmSync(testTmpRoot(), { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures: a leftover empty token dir is harmless and
    // swept by cleanupStaleTestTmp() once it is clearly not an active run.
  }
});

/**
 * Removes `sp-test-*` scratch directories that are older than two hours and
 * do not belong to this process. Active runs (including concurrent suites)
 * are minutes old and therefore never touched — only long-dead leftovers
 * (e.g. after a SIGKILLed worker, where the `exit` hook cannot run) are
 * swept. Runs on every harness creation, so it is idempotent and bounded.
 */
function cleanupStaleTestTmp(): void {
  const cutoff = Date.now() - 2 * 3_600_000;
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith('sp-test-') || entry === `sp-test-${process.pid}`) continue;
    const dir = join(tmpdir(), entry);
    let mtime = 0;
    try {
      mtime = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (mtime > cutoff) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Another process may own it; never fail tests over scratch cleanup.
    }
  }
}

export interface Harness {
  app: FastifyInstance;
  db: Db;
  config: AppConfig;
  close: () => Promise<void>;
}

export function testConfig(): AppConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must be set for tests');
  cleanupStaleTestTmp();
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789abcdef',
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'silent',
    BOOTSTRAP_TOKEN_FILE: join(testTmpRoot(), 'bootstrap-token'),
    WEB_DIST_DIR: join(testTmpRoot(), 'no-web-build'),
    ALLOWED_ORIGINS: 'http://localhost:8080',
    // Deterministic AI secret key for tests (AES via passphrase derivation).
    AI_CREDENTIAL_KEY: 'test-ai-credential-key-0123456789abcdef',
  });
}

export async function createHarness(now: () => number = Date.now): Promise<Harness> {
  const config = testConfig();
  const db = createPrismaClient(config.databaseUrl);
  const app = await buildApp(createContext(config, db, now));
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

/** Empties all application tables between tests (real Postgres, no mocks). */
export async function resetDb(db: Db): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE ai_usage_events, ai_credentials, ai_settings, audit_log, service_incidents, service_results, services, discovered_services, disk_samples, metric_samples, sessions, agents, enroll_tokens, users, bootstrap_state RESTART IDENTITY CASCADE',
  );
}

export const ORIGIN = 'http://localhost:8080';

export async function seedBootstrapToken(db: Db, config: AppConfig): Promise<string> {
  await ensureBootstrapState(db, config);
  return (await readFile(config.bootstrapTokenFile, 'utf8')).trim();
}

function sessionCookie(res: LightMyRequestResponse, config: AppConfig): string {
  const cookie = res.cookies.find((item) => item.name === config.cookieName);
  if (!cookie) throw new Error(`missing session cookie ${config.cookieName}`);
  return cookie.value;
}

export interface Session {
  cookie: string;
  csrfToken: string;
}

export function cookieHeader(config: AppConfig, session: Session): string {
  return `${config.cookieName}=${session.cookie}`;
}

export function authHeaders(config: AppConfig, session: Session): Record<string, string> {
  return {
    cookie: cookieHeader(config, session),
    'x-csrf-token': session.csrfToken,
    origin: ORIGIN,
  };
}

export async function bootstrapAdmin(
  harness: Harness,
  input: { email?: string; password?: string } = {},
): Promise<Session> {
  const token = await seedBootstrapToken(harness.db, harness.config);
  const res = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    headers: { origin: ORIGIN },
    payload: {
      token,
      email: input.email ?? 'admin@example.test',
      password: input.password ?? 'correct horse battery staple',
    },
  });
  if (res.statusCode !== 201) throw new Error(`bootstrap failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { csrfToken: string };
  return { cookie: sessionCookie(res, harness.config), csrfToken: body.csrfToken };
}

export async function login(harness: Harness, email: string, password: string): Promise<Session> {
  const res = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { csrfToken: string };
  return { cookie: sessionCookie(res, harness.config), csrfToken: body.csrfToken };
}

export interface EnrolledAgent {
  agentId: string;
  credential: string;
}

export async function createPairingToken(harness: Harness, session: Session): Promise<string> {
  const res = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/agents/pairing-tokens',
    headers: authHeaders(harness.config, session),
    payload: {},
  });
  if (res.statusCode !== 201) throw new Error(`pairing token failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { token: string }).token;
}

export async function enrollAgent(
  harness: Harness,
  token: string,
  hostname = 'test-host',
  capabilities: string[] = ['metrics'],
): Promise<{ agentId: string; credential: string; res: LightMyRequestResponse }> {
  const res = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/agent/enroll',
    headers: { 'agent-protocol-version': '1', 'content-type': 'application/json' },
    payload: {
      enroll_token: token,
      hostname,
      agent_version: '0.1.0',
      protocol_version: 1,
      capabilities,
    },
  });
  if (res.statusCode !== 201) throw new Error(`enroll failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { agent_id: string; credential: string };
  return { agentId: body.agent_id, credential: body.credential, res };
}

export function agentHeaders(agent: EnrolledAgent): Record<string, string> {
  return {
    'agent-protocol-version': '1',
    'x-agent-id': agent.agentId,
    authorization: `Bearer ${agent.credential}`,
    'content-type': 'application/json',
  };
}

export function heartbeatPayload(seq: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq,
    observed_at: new Date().toISOString(),
    config_version: 1,
    metrics: {
      cpu: { usage_pct: 12.5, load1: 0.5 },
      mem: { total_b: 8_000_000_000, used_b: 4_000_000_000, avail_b: 4_000_000_000 },
      disk: [{ mount: '/', total_b: 100_000_000_000, used_b: 40_000_000_000, avail_b: 60_000_000_000 }],
      net: { rx_b: 1_000, tx_b: 2_000, rx_bps: 1.5, tx_bps: 2.5 },
      uptime_s: 12_345,
    },
    docker: { present: false },
    command_results: [],
    ...overrides,
  };
}

export async function sendHeartbeat(
  harness: Harness,
  agent: EnrolledAgent,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url: '/api/v1/agent/heartbeat',
    headers: agentHeaders(agent),
    payload,
  });
}

/** Full flow: bootstrap admin, pair, enroll. Returns auth session + agent. */
export async function bootstrapAndEnroll(
  harness: Harness,
  hostname = 'test-host',
  capabilities: string[] = ['metrics'],
): Promise<{ session: Session; agent: EnrolledAgent }> {
  const session = await bootstrapAdmin(harness);
  const token = await createPairingToken(harness, session);
  const { agentId, credential } = await enrollAgent(harness, token, hostname, capabilities);
  return { session, agent: { agentId, credential } };
}

export interface TestCandidate {
  candidate_id: string;
  name?: string;
  kind?: string;
  port: number;
  transport?: string;
  source?: string;
  confidence?: string;
  monitorable?: boolean;
  name_source?: string;
  process_started_at?: string | null;
  suggested_path?: string | null;
  suggested_statuses?: number[];
}

/** Builds a wire-shaped discovery candidate with safe defaults. */
export function candidate(port: number, overrides: Partial<TestCandidate> = {}): TestCandidate {
  const has = <K extends keyof TestCandidate>(key: K): boolean =>
    Object.prototype.hasOwnProperty.call(overrides, key);
  return {
    candidate_id: overrides.candidate_id ?? `jellyfin-${port}`,
    name: overrides.name ?? 'Jellyfin',
    kind: overrides.kind ?? 'jellyfin',
    port,
    transport: overrides.transport ?? 'http',
    source: overrides.source ?? 'docker-proxy',
    confidence: overrides.confidence ?? 'medium',
    ...(has('monitorable') ? { monitorable: overrides.monitorable } : {}),
    ...(has('name_source') ? { name_source: overrides.name_source } : {}),
    process_started_at: has('process_started_at') ? (overrides.process_started_at ?? null) : null,
    suggested_path: has('suggested_path') ? (overrides.suggested_path ?? null) : '/Health',
    suggested_statuses: has('suggested_statuses')
      ? (overrides.suggested_statuses ?? [])
      : [200],
  };
}

export function discoveryPayload(
  candidates: TestCandidate[],
  overrides: { observed_at?: string; complete?: boolean } = {},
): Record<string, unknown> {
  return {
    observed_at: overrides.observed_at ?? new Date().toISOString(),
    complete: overrides.complete ?? true,
    candidates,
  };
}

export interface TestServiceResult {
  check_id: string;
  config_revision: number;
  observed_at?: string;
  ok: boolean;
  status_code?: number | null;
  latency_ms?: number;
  error_code?: string | null;
}

export function resultPayload(result: TestServiceResult): Record<string, unknown> {
  return {
    check_id: result.check_id,
    config_revision: result.config_revision,
    observed_at: result.observed_at ?? new Date().toISOString(),
    ok: result.ok,
    status_code: result.status_code ?? (result.ok ? 200 : null),
    latency_ms: result.latency_ms ?? 3.5,
    error_code: result.error_code ?? (result.ok ? null : 'SERVICE_UNAVAILABLE'),
  };
}

/** Sends a heartbeat carrying discovery and/or results (seq must increase). */
export async function sendServiceHeartbeat(
  harness: Harness,
  agent: EnrolledAgent,
  seq: number,
  payload: { discovery?: Record<string, unknown>; results?: Array<Record<string, unknown>> },
): Promise<LightMyRequestResponse> {
  return sendHeartbeat(harness, agent, heartbeatPayload(seq, {
    ...(payload.discovery ? { service_discovery: payload.discovery } : {}),
    ...(payload.results ? { service_results: payload.results } : {}),
  }));
}

/** Creates a service through the authenticated UI API and returns its DTO. */
export async function createServiceViaApi(
  harness: Harness,
  session: Session,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/services',
    headers: authHeaders(harness.config, session),
    payload: body,
  });
  if (res.statusCode !== 201) throw new Error(`create service failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { service: Record<string, unknown> }).service;
}
