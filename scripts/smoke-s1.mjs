#!/usr/bin/env node
/*
 * Windup Monitor S1 end-to-end smoke test (real HTTP against a running Core).
 *
 * Usage:
 *   BOOTSTRAP_TOKEN_FILE=core/data/bootstrap-token \
 *   BASE_URL=http://127.0.0.1:8080 node scripts/smoke-s1.mjs
 *
 * The target instance MUST be freshly migrated and not yet initialised.
 */
import { readFile } from 'node:fs/promises';

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const TOKEN_FILE = process.env.BOOTSTRAP_TOKEN_FILE ?? 'core/data/bootstrap-token';
const EMAIL = process.env.SMOKE_EMAIL ?? 'admin@example.test';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'correct horse battery staple';

let cookie = '';
let csrf = '';
let step = 0;

function ok(message) {
  step += 1;
  console.log(`  \u2713 ${message}`);
}

function fail(message, detail) {
  console.error(`\n  \u2717 ${message}`);
  if (detail !== undefined) console.error('   ', detail);
  process.exit(1);
}

function assert(condition, message, detail) {
  if (!condition) fail(message, detail);
}

async function call(method, path, { body, headers = {}, expect, omitCsrf = false } = {}) {
  const finalHeaders = { accept: 'application/json', origin: BASE_URL, ...headers };
  if (body !== undefined) finalHeaders['content-type'] = 'application/json';
  if (cookie) finalHeaders.cookie = cookie;
  if (csrf && !omitCsrf && method !== 'GET' && method !== 'HEAD') finalHeaders['x-csrf-token'] = csrf;

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    fail(`request failed: ${method} ${path}`, error);
  }

  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    if (pair && (pair.startsWith('sp_session=') || pair.startsWith('__Host-sp_session='))) {
      cookie = pair;
    }
  }

  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (expect !== undefined) {
    assert(
      response.status === expect,
      `unexpected status for ${method} ${path}: ${response.status} (expected ${expect})`,
      text.slice(0, 500),
    );
  }
  return { status: response.status, json, text, headers: response.headers };
}

async function main() {
  console.log(`Windup Monitor S1 smoke test against ${BASE_URL}`);

  const ready = await call('GET', '/api/v1/health/ready', { expect: 200 });
  assert(ready.json?.checks?.database === 'ok', 'readiness does not report database ok', ready.json);
  ok('readiness reports database ok');

  const status = await call('GET', '/api/v1/auth/status', { expect: 200 });
  assert(status.json?.initialized === false, 'instance is already initialised; use a fresh database', status.json);
  ok('fresh instance reports initialized=false');

  const token = (await readFile(TOKEN_FILE, 'utf8')).trim();
  assert(token.length > 20, 'bootstrap token file is empty');

  const boot = await call('POST', '/api/v1/auth/bootstrap', {
    body: { token, email: EMAIL, password: PASSWORD },
    expect: 201,
  });
  assert(boot.json?.user?.email === EMAIL, 'bootstrap did not return the user', boot.json);
  assert(typeof boot.json?.csrfToken === 'string', 'bootstrap did not return a CSRF token', boot.json);
  assert(cookie.startsWith('sp_session='), 'bootstrap did not set the session cookie');
  ok('bootstrap created the admin and a session');

  const second = await call('POST', '/api/v1/auth/bootstrap', {
    body: { token, email: 'other@example.test', password: PASSWORD },
  });
  assert(second.status === 409, 'replayed bootstrap token was accepted', second.text);
  ok('bootstrap token is single-use');

  const me = await call('GET', '/api/v1/auth/me', { expect: 200 });
  csrf = me.json?.csrfToken;
  assert(me.json?.user?.email === EMAIL, '/auth/me returned the wrong user', me.json);
  assert(typeof csrf === 'string' && csrf.length > 20, '/auth/me did not return a CSRF token', me.json);
  ok('authenticated /auth/me returns user + CSRF token');

  const noCsrf = await call('POST', '/api/v1/agents/pairing-tokens', { body: {}, omitCsrf: true });
  assert(noCsrf.status === 403, 'mutation without CSRF token was accepted', noCsrf.text);
  ok('mutations require X-CSRF-Token');

  const pairing = await call('POST', '/api/v1/agents/pairing-tokens', { body: {}, expect: 201 });
  const enrollToken = pairing.json?.token;
  assert(typeof enrollToken === 'string', 'pairing token missing', pairing.json);
  assert(typeof pairing.json?.expiresAt === 'string', 'pairing token expiry missing', pairing.json);
  ok('pairing token issued');

  const enroll = await call('POST', '/api/v1/agent/enroll', {
    body: {
      enroll_token: enrollToken,
      hostname: 'smoke-host',
      agent_version: '0.1.0',
      protocol_version: 1,
      capabilities: ['metrics'],
    },
    headers: { 'agent-protocol-version': '1' },
    expect: 201,
  });
  const agentId = enroll.json?.agent_id;
  const credential = enroll.json?.credential;
  assert(typeof agentId === 'string' && agentId.startsWith('ag_'), 'enroll did not return agent_id', enroll.json);
  assert(typeof credential === 'string' && credential.length > 20, 'enroll did not return a credential', enroll.json);
  ok('agent enrolled (credential returned once)');

  const agentHeaders = {
    'agent-protocol-version': '1',
    'x-agent-id': agentId,
    authorization: `Bearer ${credential}`,
  };

  const envelope = (seq, configVersion) => ({
    seq,
    observed_at: new Date().toISOString(),
    config_version: configVersion,
    metrics: {
      cpu: { usage_pct: 17.5, load1: 0.75 },
      mem: { total_b: 8_000_000_000, used_b: 3_000_000_000, avail_b: 5_000_000_000 },
      disk: [{ mount: '/', total_b: 100_000_000_000, used_b: 42_000_000_000, avail_b: 58_000_000_000 }],
      net: { rx_b: 12_345, tx_b: 54_321, rx_bps: 10.5, tx_bps: 20.5 },
      uptime_s: 987_654,
    },
    docker: { present: false },
    command_results: [],
  });

  const hb1 = await call('POST', '/api/v1/agent/heartbeat', {
    body: envelope(1, 0),
    headers: agentHeaders,
    expect: 200,
  });
  assert(hb1.json?.config_changed === true, 'first heartbeat should request config', hb1.json);
  assert(hb1.json?.code === 'CONFIG_STALE', 'first heartbeat should carry CONFIG_STALE', hb1.json);
  ok('first heartbeat signals CONFIG_STALE');

  const cfg = await call('GET', '/api/v1/agent/config', { headers: agentHeaders, expect: 200 });
  assert(cfg.json?.heartbeat_interval_s === 15, 'unexpected heartbeat interval', cfg.json);
  assert(cfg.json?.queue_ttl_s === 300 && cfg.json?.lease_s === 120, 'unexpected queue config', cfg.json);
  ok('agent config endpoint is canonical');

  const hb2 = await call('POST', '/api/v1/agent/heartbeat', {
    body: envelope(2, 1),
    headers: agentHeaders,
    expect: 200,
  });
  assert(hb2.json?.config_changed === false, 'second heartbeat should be config-current', hb2.json);
  ok('heartbeat ingested (seq=2)');

  const duplicate = await call('POST', '/api/v1/agent/heartbeat', {
    body: envelope(2, 1),
    headers: agentHeaders,
  });
  assert(duplicate.status === 409 && duplicate.json?.code === 'STALE_SEQ', 'duplicate seq was not rejected', duplicate.text);
  ok('duplicate seq rejected with STALE_SEQ');

  const agents = await call('GET', '/api/v1/agents', { expect: 200 });
  const summary = agents.json?.agents?.find((entry) => entry.id === agentId);
  assert(summary, 'enrolled agent missing from /agents', agents.json);
  assert(summary.status === 'online', `agent status is ${summary.status}, expected online`, summary);
  assert(summary.metrics?.cpuPercent === 17.5, 'metrics not exposed in /agents', summary);
  assert(summary.metrics?.diskUsedBytes === 42_000_000_000, 'disk aggregate missing', summary);
  ok('dashboard API lists the agent as online with metrics');

  const history = await call('GET', `/api/v1/agents/${agentId}/metrics?limit=10`, { expect: 200 });
  const samples = history.json?.samples ?? [];
  assert(samples.length === 2, `expected 2 samples, got ${samples.length}`, history.json);
  assert(samples[0].sampledAt <= samples[1].sampledAt, 'samples are not ascending', samples);
  ok('bounded metrics history is ascending');

  const home = await call('GET', '/');
  if (home.status === 200) {
    assert(home.text.includes('<div id="root"') || home.text.includes('<script'), 'SPA dist looks wrong');
    ok('SPA served by Core (same origin)');
  } else {
    console.log('  ~ SPA build not present (API-only mode) — skipped static check');
  }

  const revoked = await call('POST', `/api/v1/agents/${agentId}/revoke`, { body: {}, expect: 200 });
  assert(revoked.json?.status === 'revoked', 'revoke did not report revoked', revoked.json);
  const afterRevoke = await call('POST', '/api/v1/agent/heartbeat', {
    body: envelope(3, 1),
    headers: agentHeaders,
  });
  assert(afterRevoke.status === 401 && afterRevoke.json?.code === 'AGENT_REVOKED', 'revoked agent still accepted', afterRevoke.text);
  ok('revocation is immediate (AGENT_REVOKED)');

  const logout = await call('POST', '/api/v1/auth/logout', { body: {}, expect: 204 });
  cookie = '';
  const meAfter = await call('GET', '/api/v1/auth/me');
  assert(meAfter.status === 401, 'session still valid after logout', meAfter.text);
  ok('logout destroys the session');

  console.log(`\nAll ${step} smoke checks passed.`);
}

main().catch((error) => fail('unexpected error', error));
