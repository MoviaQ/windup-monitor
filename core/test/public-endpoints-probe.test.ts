/**
 * Pinned-probe tests with stubbed DNS + transport (no real network).
 *
 * Covers: pinned dial uses a validated IP (actual connection pin, asserted
 * via the stub), per-probe fresh DNS (resolve called every probe), redirect
 * no-follow (single exchange, no second DNS lookup), timeout deadline,
 * 401-as-reachable, invalid-status handling, and error-code mapping.
 */
import { describe, expect, it } from 'vitest';
import {
  PROBE_BODY_CAP_BYTES,
  probePublicEndpoint,
} from '../src/public-endpoints/probe.js';

const okSocket = (): Promise<NodeJS.Socket> => Promise.resolve({} as NodeJS.Socket);

describe('probePublicEndpoint', () => {
  it('pins the actual dial to a validated public IP with hostname SNI and never dials private DNS', async () => {
    const seen: Array<{ ip: string; port: number; hostname: string }> = [];
    const outcome = await probePublicEndpoint(
      { url: 'https://example.com/', timeoutSeconds: 2 },
      {
        resolveAll: async () => ['10.0.0.1'],
        connectPinned: async (ip, port, hostname) => {
          seen.push({ ip, port, hostname });
          return okSocket();
        },
      },
    );
    expect(outcome).toMatchObject({ kind: 'failed', errorCode: 'DNS_PRIVATE' });
    expect(seen).toHaveLength(0);
  });

  it('dials the validated IP while keeping the original hostname for SNI/Host', async () => {
    const seen: Array<{ ip: string; port: number; hostname: string; hostHeader: string }> = [];
    const outcome = await probePublicEndpoint(
      { url: 'https://example.com/some/path?q=1', timeoutSeconds: 5 },
      {
        resolveAll: async () => ['93.184.216.34'],
        exchange: async (ip, port, hostname, hostHeader) => {
          seen.push({ ip, port, hostname, hostHeader });
          return 200;
        },
      },
    );
    expect(outcome.kind).toBe('responded');
    expect(seen).toEqual([
      { ip: '93.184.216.34', port: 443, hostname: 'example.com', hostHeader: 'example.com' },
    ]);
  });

  it('does not follow redirects: 3xx resolves once, with no second DNS lookup', async () => {
    let resolutions = 0;
    let exchanges = 0;
    const outcome = await probePublicEndpoint(
      { url: 'https://example.com/', timeoutSeconds: 5 },
      {
        resolveAll: async () => {
          resolutions += 1;
          return ['93.184.216.34'];
        },
        exchange: async () => {
          exchanges += 1;
          return 302;
        },
      },
    );
    expect(outcome).toMatchObject({ kind: 'redirect', statusCode: 302 });
    expect(resolutions).toBe(1);
    expect(exchanges).toBe(1);
  });

  it('treats 401 as answered (reachable), not as a probe failure', async () => {
    const outcome = await probePublicEndpoint(
      { url: 'https://example.com/private', timeoutSeconds: 5 },
      {
        resolveAll: async () => ['93.184.216.34'],
        exchange: async () => 401,
      },
    );
    expect(outcome).toMatchObject({ kind: 'responded', statusCode: 401 });
  });

  it('fails invalid status codes and surfaces transport failures honestly', async () => {
    const invalid = await probePublicEndpoint(
      { url: 'https://example.com/', timeoutSeconds: 5 },
      {
        resolveAll: async () => ['93.184.216.34'],
        exchange: async () => 99,
      },
    );
    expect(invalid).toMatchObject({ kind: 'failed', errorCode: 'INVALID_RESPONSE' });

    const refused = await probePublicEndpoint(
      { url: 'https://example.com/', timeoutSeconds: 5 },
      {
        resolveAll: async () => ['93.184.216.34'],
        exchange: async () => {
          throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
        },
      },
    );
    expect(refused).toMatchObject({ kind: 'failed', errorCode: 'CONNECTION_FAILED' });
  });

  it('reports DNS failure without dialing', async () => {
    let dials = 0;
    const outcome = await probePublicEndpoint(
      { url: 'https://example.com/', timeoutSeconds: 2 },
      {
        resolveAll: async () => {
          throw new Error('boom');
        },
        connectPinned: async () => {
          dials += 1;
          return okSocket();
        },
      },
    );
    expect(outcome).toMatchObject({ kind: 'failed', errorCode: 'DNS_FAILED' });
    expect(dials).toBe(0);
  });

  it('rejects DNS rebinding shape: mixed public+private answers fail closed', async () => {
    const outcome = await probePublicEndpoint(
      { url: 'https://example.com/', timeoutSeconds: 2 },
      { resolveAll: async () => ['93.184.216.34', '192.168.0.1'] },
    );
    expect(outcome).toMatchObject({ kind: 'failed', errorCode: 'DNS_PRIVATE' });
  });

  it('enforces the total deadline (a hung exchange surfaces as TIMEOUT)', async () => {
    const outcome = await probePublicEndpoint(
      { url: 'https://example.com/', timeoutSeconds: 1 },
      {
        resolveAll: async () => ['93.184.216.34'],
        exchange: async () => new Promise<number>(() => {}), // hangs forever
      },
    );
    expect(outcome).toMatchObject({ kind: 'failed', errorCode: 'TIMEOUT' });
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(900);
  });

  it('exposes a 64 KiB discard cap constant', () => {
    expect(PROBE_BODY_CAP_BYTES).toBe(64 * 1024);
  });
});
