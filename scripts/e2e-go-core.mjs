#!/usr/bin/env node
/*
 * Windup Monitor S1 real end-to-end test: actual Go agent binary <-> real Core.
 *
 * No mocks, no hand-crafted ingest: the compiled Go binary performs enroll
 * and continuous heartbeats over HTTP; assertions check PostgreSQL rows and
 * the authenticated dashboard API.
 *
 * Usage:
 *   node scripts/e2e-go-core.mjs
 *
 * Env overrides: PG_CONTAINER (auto-detected via port 55432 if unset),
 * PG_USER/PG_PASSWORD (default statuspilot), E2E_DB (default
 * statuspilot_e2e), CORE_PORT (default 18081), HEARTBEAT_S (default 5).
 *
 * Isolated database: statuspilot_e2e is dropped+recreated at start and
 * dropped at the end, so the dev/review databases are never touched.
 * Port 18081 is used to avoid the foreign service on 8080 and the review
 * stack on 18080.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const CORE_PORT = Number(process.env.CORE_PORT ?? 18081);
const BASE_URL = `http://127.0.0.1:${CORE_PORT}`;
const E2E_DB = process.env.E2E_DB ?? 'statuspilot_e2e';
const PG_USER = process.env.PG_USER ?? 'statuspilot';
const PG_PASSWORD = process.env.PG_PASSWORD ?? 'statuspilot';
const HEARTBEAT_S = Number(process.env.HEARTBEAT_S ?? 5);
const EMAIL = 'e2e@example.test';
const PASSWORD = 'correct horse battery staple extra';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
function pass(message) {
  step += 1;
  console.log(`  ✓ ${message}`);
}
function fail(message, detail) {
  console.error(`\n  ✗ ${message}`);
  if (detail !== undefined) console.error('   ', String(detail).slice(0, 2000));
  throw new Error(message);
}
function assert(cond, message, detail) {
  if (!cond) fail(message, detail);
}

let pgContainer = process.env.PG_CONTAINER ?? '';
async function detectPg() {
  if (pgContainer) return pgContainer;
  const { stdout } = await execFileAsync('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}']);
  for (const line of stdout.split('\n')) {
    if (line.includes('55432')) {
      pgContainer = line.split('\t')[0].trim();
      return pgContainer;
    }
  }
  throw new Error('no docker container publishing PG port 55432 (run ./scripts/dev-db.sh)');
}
async function psql(db, sql) {
  const { stdout } = await execFileAsync('docker', [
    'exec', pgContainer, 'psql', '-U', PG_USER, '-d', db, '-tAc', sql,
  ]);
  return stdout.trim();
}

const procs = [];
function track(child, name) {
  procs.push({ child, name });
  return child;
}
async function killAll() {
  for (const { child, name } of procs.reverse()) {
    if (child.exitCode === null) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }
  await sleep(1500);
  for (const { child } of procs) {
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
}

async function waitFor(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}: ${url}`);
    await sleep(500);
  }
}

// Minimal cookie jar for the UI session.
let cookie = '';
let csrf = '';
async function api(method, path, { body, headers = {}, expect } = {}) {
  const finalHeaders = { accept: 'application/json', origin: BASE_URL, ...headers };
  if (body !== undefined) finalHeaders['content-type'] = 'application/json';
  if (cookie) finalHeaders.cookie = cookie;
  if (csrf && method !== 'GET' && method !== 'HEAD') finalHeaders['x-csrf-token'] = csrf;
  const res = await fetch(`${BASE_URL}${path}`, {
    method, headers: finalHeaders, body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    if (pair?.startsWith('sp_session=') || pair?.startsWith('__Host-sp_session=')) cookie = pair;
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (expect !== undefined) assert(res.status === expect, `${method} ${path}: got ${res.status}, want ${expect}`, text);
  return { status: res.status, json, text };
}

function agentEnvelope(seq, configVersion) {
  return {
    seq,
    observed_at: new Date().toISOString(),
    config_version: configVersion,
    metrics: {
      cpu: { usage_pct: 9.5, load1: 0.3 },
      mem: { total_b: 8_000_000_000, used_b: 1_000_000_000, avail_b: 7_000_000_000 },
      disk: [{ mount: '/', total_b: 50_000_000_000, used_b: 5_000_000_000, avail_b: 45_000_000_000 }],
      net: { rx_b: 100, tx_b: 200, rx_bps: 1.0, tx_bps: 2.0 },
      uptime_s: 60,
    },
    docker: { present: false },
    command_results: [],
  };
}

async function main() {
  pgContainer = await detectPg();
  console.log(`PG container: ${pgContainer}, isolated DB: ${E2E_DB}, Core: ${BASE_URL}`);

  const workdir = await mkdtemp(join(tmpdir(), 'sp-e2e-'));
  const stateDir = join(workdir, 'agent-state');
  const agentBin = join(workdir, 'windup-monitor-agent');
  const bootstrapTokenFile = join(workdir, 'bootstrap-token');
  const coreLogPath = join(workdir, 'core.log');
  const agentLogPath = join(workdir, 'agent.log');
  const { createWriteStream } = await import('node:fs');
  const coreLog = createWriteStream(coreLogPath);
  const agentLog = createWriteStream(agentLogPath);

  // 1. Isolated database (drop+create; dev/review DBs untouched).
  await psql('postgres', `DROP DATABASE IF EXISTS ${E2E_DB}`);
  await psql('postgres', `CREATE DATABASE ${E2E_DB}`);
  const dbUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:55432/${E2E_DB}?schema=public`;
  pass('isolated e2e database created');

  // 2. Migrate + build real artifacts.
  await execFileAsync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: join(ROOT, 'core'), env: { ...process.env, DATABASE_URL: dbUrl },
  });
  pass('migrations applied to e2e database');
  await execFileAsync('npm', ['run', 'build', '--workspace', 'core'], { cwd: ROOT });
  await execFileAsync('npm', ['run', 'build', '--workspace', 'web'], { cwd: ROOT });
  pass('core + web built from source');
  await execFileAsync('go', ['build', '-o', agentBin, './cmd/windup-monitor-agent'], {
    cwd: join(ROOT, 'agent'),
  });
  pass('real Go agent binary built');

  // 3. Start Core (production mode, loopback, SPA served by Core).
  const coreEnv = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(CORE_PORT),
    DATABASE_URL: dbUrl,
    SESSION_SECRET: randomBytes(48).toString('base64url'),
    COOKIE_SECURE: 'false',
    TRUST_PROXY: 'false',
    ALLOWED_ORIGINS: BASE_URL,
    BOOTSTRAP_TOKEN_FILE: bootstrapTokenFile,
    WEB_DIST_DIR: join(ROOT, 'web', 'dist'),
    LOG_LEVEL: 'warn',
    AGENT_HEARTBEAT_INTERVAL_S: String(HEARTBEAT_S),
  };
  const core = track(spawn('node', [join(ROOT, 'core', 'dist', 'index.js')], {
    env: coreEnv, stdio: ['ignore', 'pipe', 'pipe'],
  }), 'core');
  core.stdout.pipe(coreLog);
  core.stderr.pipe(coreLog);
  core.on('exit', (code) => { if (code !== 0 && code !== null) console.error(`core exited with ${code}`); });
  await waitFor(`${BASE_URL}/api/v1/health/ready`, 60_000, 'core readiness');
  pass('Core ready (real HTTP, production dist)');

  const status = await api('GET', '/api/v1/auth/status', { expect: 200 });
  assert(status.json?.initialized === false, 'e2e DB must be fresh', status.text);
  pass('fresh instance reports initialized=false');

  // 4. Bootstrap + session.
  const token = (await readFile(bootstrapTokenFile, 'utf8')).trim();
  assert(token.length > 20, 'bootstrap token file empty');
  const boot = await api('POST', '/api/v1/auth/bootstrap', {
    body: { token, email: EMAIL, password: PASSWORD }, expect: 201,
  });
  assert(boot.json?.user?.email === EMAIL, 'bootstrap email mismatch', boot.text);
  pass('bootstrap created admin + session cookie');
  await api('POST', '/api/v1/auth/bootstrap', {
    body: { token, email: 'other@example.test', password: PASSWORD },
  }).then((r) => assert(r.status === 409, 'replayed bootstrap token accepted', r.text));
  pass('bootstrap token is single-use');
  const me = await api('GET', '/api/v1/auth/me', { expect: 200 });
  csrf = me.json?.csrfToken;
  assert(typeof csrf === 'string' && csrf.length > 20, 'missing CSRF token', me.text);
  pass('session + CSRF token issued');

  // 5. Invalid auth/CSRF negatives (real HTTP).
  const savedCookie = cookie; const savedCsrf = csrf;
  cookie = ''; csrf = '';
  const unauth = await api('GET', '/api/v1/agents');
  assert(unauth.status === 401, 'unauthenticated /agents accepted', unauth.text);
  cookie = savedCookie; // cookie but no CSRF
  const noCsrf = await api('POST', '/api/v1/agents/pairing-tokens', { body: {} });
  assert(noCsrf.status === 403, 'mutation without CSRF accepted', noCsrf.text);
  const badOrigin = await api('POST', '/api/v1/agents/pairing-tokens', {
    body: {}, headers: { origin: 'https://evil.test' },
  });
  assert(badOrigin.status === 403, 'foreign Origin accepted', badOrigin.text);
  csrf = savedCsrf;
  pass('invalid auth (401) / missing CSRF (403) / foreign Origin (403) rejected');

  // 6. Pairing token + enroll via the REAL Go binary.
  const pairing = await api('POST', '/api/v1/agents/pairing-tokens', { body: {}, expect: 201 });
  const enrollToken = pairing.json?.token;
  assert(typeof enrollToken === 'string' && enrollToken.length > 20, 'no pairing token', pairing.text);
  pass('pairing token issued');

  await execFileAsync(agentBin, [
    'enroll', '--core-url', BASE_URL, '--allow-insecure-http', '--state-dir', stateDir,
  ], { env: { ...process.env, WINDUP_MONITOR_ENROLL_TOKEN: enrollToken } });
  pass('Go binary enrolled (one-time token consumed)');
  const credRaw = await readFile(join(stateDir, 'credential.json'), 'utf8');
  const cred = JSON.parse(credRaw);
  assert(typeof cred.agent_id === 'string' && typeof cred.credential === 'string', 'bad credential.json', credRaw);
  const credMode = (await stat(join(stateDir, 'credential.json'))).mode & 0o777;
  assert(credMode === 0o600, `credential.json mode is ${credMode.toString(8)}, want 600`);
  const agentId = cred.agent_id;
  const agentCred = cred.credential;
  pass(`credential stored 0600 for ${agentId}`);

  // 7. Continuous heartbeat via the REAL Go binary.
  const run1 = track(spawn(agentBin, [
    'run', '--core-url', BASE_URL, '--allow-insecure-http', '--state-dir', stateDir,
  ], { stdio: ['ignore', 'pipe', 'pipe'] }), 'agent-run-1');
  run1.stdout.pipe(agentLog);
  run1.stderr.pipe(agentLog);
  await sleep((HEARTBEAT_S * 3 + 6) * 1000);
  assert(run1.exitCode === null, `agent run exited early with ${run1.exitCode}`, await readFile(agentLogPath, 'utf8').catch(() => ''));
  pass('Go binary ran continuous heartbeats without exiting');

  const agents = await api('GET', '/api/v1/agents', { expect: 200 });
  const summary = agents.json?.agents?.find((a) => a.id === agentId);
  assert(summary, 'enrolled agent missing from dashboard API', agents.text);
  assert(summary.status === 'online', `agent status is ${summary.status}, want online`, summary);
  assert(summary.metrics !== null && typeof summary.metrics.cpuPercent === 'number', 'no host metrics in dashboard', summary);
  pass('dashboard API lists the Go agent as online with real host metrics');

  const history = await api('GET', `/api/v1/agents/${agentId}/metrics?limit=10`, { expect: 200 });
  const samples = history.json?.samples ?? [];
  assert(samples.length >= 2, `want >=2 real samples, got ${samples.length}`, history.text);
  pass(`metrics history holds ${samples.length} real samples from the Go binary`);
  const dbCount1 = Number(await psql(E2E_DB, `select count(*) from metric_samples where agent_id='${agentId}'`));
  assert(dbCount1 >= 2, `DB has ${dbCount1} samples, want >=2`);
  pass(`PostgreSQL holds ${dbCount1} metric_samples rows for the agent`);

  // 8. Reconnect: kill + restart must resume with persistent seq (no STALE_SEQ).
  const seqBefore = Number((await readFile(join(stateDir, 'seq'), 'utf8')).trim());
  assert(Number.isFinite(seqBefore) && seqBefore >= 2, `bad seq file: ${seqBefore}`);
  run1.kill('SIGTERM');
  await sleep(2000);
  const run2 = track(spawn(agentBin, [
    'run', '--core-url', BASE_URL, '--allow-insecure-http', '--state-dir', stateDir,
  ], { stdio: ['ignore', 'pipe', 'pipe'] }), 'agent-run-2');
  run2.stdout.pipe(agentLog);
  run2.stderr.pipe(agentLog);
  await sleep((HEARTBEAT_S * 2 + 5) * 1000);
  assert(run2.exitCode === null, `restarted agent exited with ${run2.exitCode}`);
  const seqAfter = Number((await readFile(join(stateDir, 'seq'), 'utf8')).trim());
  assert(seqAfter > seqBefore, `seq did not advance across restart (${seqBefore} -> ${seqAfter})`);
  const dbCount2 = Number(await psql(E2E_DB, `select count(*) from metric_samples where agent_id='${agentId}'`));
  assert(dbCount2 > dbCount1, `DB samples did not grow after reconnect (${dbCount1} -> ${dbCount2})`);
  const agentLogText = await readFile(agentLogPath, 'utf8').catch(() => '');
  assert(!agentLogText.includes('STALE_SEQ'), 'agent hit STALE_SEQ after restart', agentLogText.slice(-2000));
  pass(`reconnect resumes with persistent seq (${seqBefore} -> ${seqAfter}), no STALE_SEQ`);
  run2.kill('SIGTERM');
  await sleep(2000);

  // 9. Duplicate envelope: same seq over raw HTTP -> 409, no extra metric row.
  const countBefore = Number(await psql(E2E_DB, `select count(*) from metric_samples where agent_id='${agentId}'`));
  const dupRes = await fetch(`${BASE_URL}/api/v1/agent/heartbeat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'agent-protocol-version': '1',
      'x-agent-id': agentId,
      authorization: `Bearer ${agentCred}`,
    },
    body: JSON.stringify(agentEnvelope(seqAfter, 1)),
  });
  const dupText = await dupRes.text();
  assert(dupRes.status === 409 && dupText.includes('STALE_SEQ'), `duplicate seq not rejected: ${dupRes.status}`, dupText);
  const countAfterDup = Number(await psql(E2E_DB, `select count(*) from metric_samples where agent_id='${agentId}'`));
  assert(countAfterDup === countBefore, `duplicate envelope added rows (${countBefore} -> ${countAfterDup})`);
  pass('duplicate envelope rejected (STALE_SEQ), no extra metric row');

  // 10. Invalid agent auth negatives.
  const badBearer = await fetch(`${BASE_URL}/api/v1/agent/heartbeat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'agent-protocol-version': '1',
      'x-agent-id': agentId, authorization: 'Bearer wrong-credential-value',
    },
    body: JSON.stringify(agentEnvelope(seqAfter + 100, 1)),
  });
  assert(badBearer.status === 401, `bad bearer accepted: ${badBearer.status}`);
  const unknownAgent = await fetch(`${BASE_URL}/api/v1/agent/heartbeat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'agent-protocol-version': '1',
      'x-agent-id': 'ag_does_not_exist', authorization: 'Bearer whatever',
    },
    body: JSON.stringify(agentEnvelope(1, 1)),
  });
  assert(unknownAgent.status === 401, `unknown agent accepted: ${unknownAgent.status}`);
  pass('bad credential / unknown agent rejected (401)');

  // 11. Revoke is immediate.
  await api('POST', `/api/v1/agents/${agentId}/revoke`, { body: {}, expect: 200 });
  const afterRevoke = await fetch(`${BASE_URL}/api/v1/agent/heartbeat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'agent-protocol-version': '1',
      'x-agent-id': agentId, authorization: `Bearer ${agentCred}`,
    },
    body: JSON.stringify(agentEnvelope(seqAfter + 101, 1)),
  });
  const revokeText = await afterRevoke.text();
  assert(afterRevoke.status === 401 && revokeText.includes('AGENT_REVOKED'), `revoked agent still accepted: ${afterRevoke.status}`, revokeText);
  const revokedList = await api('GET', '/api/v1/agents', { expect: 200 });
  assert(revokedList.json?.agents?.find((a) => a.id === agentId)?.status === 'revoked', 'agent not revoked in dashboard', revokedList.text);
  pass('revocation is immediate (AGENT_REVOKED), dashboard shows revoked');

  // 12. SPA served by Core (same origin).
  const home = await fetch(`${BASE_URL}/`);
  const homeText = await home.text();
  assert(home.status === 200 && homeText.includes('<div id="root"'), `SPA not served: ${home.status}`, homeText.slice(0, 300));
  pass('production SPA served by Core on the same origin');

  // 13. Logout destroys the session.
  await api('POST', '/api/v1/auth/logout', { body: {}, expect: 204 });
  cookie = '';
  const meAfter = await api('GET', '/api/v1/auth/me');
  assert(meAfter.status === 401, 'session alive after logout', meAfter.text);
  pass('logout destroys the session');

  // 14. No secrets leaked into process logs (S1 gate: grep-test).
  const coreLogText = await readFile(coreLogPath, 'utf8').catch(() => '');
  const agentLogText2 = await readFile(agentLogPath, 'utf8').catch(() => '');
  for (const [label, text] of [['core', coreLogText], ['agent', agentLogText2]]) {
    for (const [name, secret] of [['agent credential', agentCred], ['admin password', PASSWORD], ['enroll token', enrollToken], ['bootstrap token', token]]) {
      assert(!text.includes(secret), `${label} log contains ${name}`);
    }
  }
  pass('no secrets in Core/agent logs (grep over full run logs)');

  console.log(`\nAll ${step} e2e checks passed (Go binary -> Core -> PostgreSQL -> dashboard API).`);
  console.log(`Logs kept for this run only: ${workdir}`);
}

try {
  await main();
} catch (error) {
  console.error(`\nE2E FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  await killAll().catch(() => {});
  try {
    if (!pgContainer) pgContainer = await detectPg().catch(() => '');
    if (pgContainer) await psql('postgres', `DROP DATABASE IF EXISTS ${E2E_DB}`);
  } catch { /* best effort */ }
}
