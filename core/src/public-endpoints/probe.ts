/**
 * Pinned HTTPS probe for public endpoints.
 *
 * Security contract:
 * - HTTPS only, no proxy env (`node:https` never consults proxy variables;
 *   we additionally never read them), no cookies, no auth headers, no
 *   redirect following (a 3xx is reported as "reachable redirect", never
 *   silently chased — each hop would need fresh DNS revalidation).
 * - DNS is resolved fresh for EVERY probe; every returned address must be
 *   global-unicast public (see url-policy). The TCP/TLS connection dials the
 *   validated IP literally while SNI + certificate verification still use
 *   the original hostname (`servername`), and the HTTP `Host` header carries
 *   the original host. This pins the actual connection (DNS-rebinding safe:
 *   a record swap between resolve and connect cannot redirect the socket).
 * - Total deadline 8 s (bounded by the caller's timeoutSeconds), response
 *   body capped at 64 KiB then discarded (never stored, never logged).
 * - Reachability phrasing is deliberately modest: any 200..399 status means
 *   "publiczny adres odpowiada" — NOT "accessible from everywhere". 401/403
 *   therefore count as reachable (the server answered); only the UI copy
 *   distinguishes "odpowiada" from "zdrowy".
 */

import dns from 'node:dns';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { assertAllAddressesPublic } from './url-policy.js';

export const PROBE_BODY_CAP_BYTES = 64 * 1024;

export type ProbeOutcome =
  | { kind: 'responded'; statusCode: number; latencyMs: number }
  | { kind: 'redirect'; statusCode: number; latencyMs: number }
  | { kind: 'failed'; errorCode: string; latencyMs: number };

/** Error codes stored in lastErrorCode / history (bounded ASCII set). */
export const PROBE_ERROR_CODES = [
  'TIMEOUT',
  'DNS_FAILED',
  'DNS_PRIVATE',
  'CONNECTION_FAILED',
  'TLS_FAILED',
  'INVALID_RESPONSE',
] as const;

export interface ProbeDeps {
  /** Fresh DNS resolution; defaults to dns.promises.lookup(all:true). */
  resolveAll?: (hostname: string) => Promise<string[]>;
  /** TCP connect override (tests); defaults to a real pinned socket. */
  connectPinned?: (ip: string, port: number, hostname: string) => Promise<NodeJS.Socket>;
  /**
   * HTTPS-exchange override (tests only): replaces the real TLS-backed
   * request once the socket is pinned. The default performs the actual
   * exchange over the pinned socket. Never set in production.
   */
  exchange?: (
    ip: string,
    port: number,
    hostname: string,
    hostHeader: string,
    path: string,
    timeoutMs: number,
    connectPinned: NonNullable<ProbeDeps['connectPinned']>,
  ) => Promise<number>;
}

const defaultResolveAll = async (hostname: string): Promise<string[]> => {
  let records: dns.LookupAddress[];
  try {
    records = await dns.promises.lookup(hostname, { all: true });
  } catch {
    throw probeFailure('DNS_FAILED');
  }
  return records.map((record) => record.address);
};

export class ProbeFailure extends Error {
  readonly errorCode: string;
  constructor(errorCode: string) {
    super(errorCode);
    this.name = 'ProbeFailure';
    this.errorCode = errorCode;
  }
}

const probeFailure = (errorCode: string): ProbeFailure => new ProbeFailure(errorCode);

function classifySocketError(error: unknown): ProbeFailure {
  const code = (error as { code?: string }).code ?? '';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ECONNABORTED') {
    return probeFailure('TIMEOUT');
  }
  if (typeof code === 'string' && code.startsWith('CERT_') ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return probeFailure('TLS_FAILED');
  }
  return probeFailure('CONNECTION_FAILED');
}

function defaultConnectPinned(ip: string, port: number, hostname: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: ip,
        port,
        servername: hostname, // SNI + cert verification against the real name.
        ALPNProtocols: ['http/1.1'],
        rejectUnauthorized: true,
      },
      () => {
        if (!socket.authorized) {
          socket.destroy();
          reject(probeFailure('TLS_FAILED'));
          return;
        }
        resolve(socket);
      },
    );
    socket.once('error', (error) => {
      socket.destroy();
      reject(classifySocketError(error));
    });
  });
}

export interface ProbeTarget {
  /** Canonical https:// URL (already validated by url-policy). */
  url: string;
  /** Total deadline in seconds (bounded 1..10 by the API layer). */
  timeoutSeconds: number;
}

/**
 * Probes one public endpoint. Redirects are NOT followed: 3xx resolves to
 * `{ kind: 'redirect' }` so the UI can report "Przekierowanie" honestly while
 * never fetching an unvalidated hop.
 */
export async function probePublicEndpoint(
  target: ProbeTarget,
  deps: ProbeDeps = {},
): Promise<ProbeOutcome> {
  const startedAt = Date.now();
  const latency = (): number => Date.now() - startedAt;
  const parsed = new URL(target.url);
  const hostname = parsed.hostname;
  const port = parsed.port === '' ? 443 : Number(parsed.port);
  const path = `${parsed.pathname}${parsed.search}`;

  const resolveAll = deps.resolveAll ?? defaultResolveAll;
  let addresses: string[];
  try {
    addresses = await resolveAll(hostname);
  } catch (error) {
    if (error instanceof ProbeFailure) {
      return { kind: 'failed', errorCode: error.errorCode, latencyMs: latency() };
    }
    return { kind: 'failed', errorCode: 'DNS_FAILED', latencyMs: latency() };
  }
  try {
    assertAllAddressesPublic(addresses);
  } catch {
    return { kind: 'failed', errorCode: 'DNS_PRIVATE', latencyMs: latency() };
  }

  const timeoutMs = Math.min(Math.max(1, target.timeoutSeconds), 10) * 1000;
  const connectPinned = deps.connectPinned ?? defaultConnectPinned;
  const exchange = deps.exchange
    ?? ((ip, port, hostname, hostHeader, path, timeout, connect) =>
      requestOverPinnedSocket(ip, port, hostname, hostHeader, path, timeout, connect));

  // The deadline binds the whole per-address attempt, including stubbed
  // transports in tests — a hung exchange can never stall the scheduler.
  const withDeadline = <T>(work: Promise<T>, budgetMs: number): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(probeFailure('TIMEOUT')), Math.max(1, budgetMs));
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });

  const errors: ProbeFailure[] = [];
  for (const ip of addresses) {
    if (Date.now() - startedAt >= timeoutMs) break;
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    try {
      const statusCode = await withDeadline(exchange(
        ip,
        port,
        hostname,
        parsed.host,
        path,
        remainingMs,
        connectPinned,
      ), remainingMs);
      if (statusCode >= 300 && statusCode < 400) {
        return { kind: 'redirect', statusCode, latencyMs: latency() };
      }
      if (statusCode < 100 || statusCode > 599) {
        return { kind: 'failed', errorCode: 'INVALID_RESPONSE', latencyMs: latency() };
      }
      return { kind: 'responded', statusCode, latencyMs: latency() };
    } catch (error) {
      if (error instanceof ProbeFailure) {
        if (error.errorCode === 'TIMEOUT') {
          return { kind: 'failed', errorCode: 'TIMEOUT', latencyMs: latency() };
        }
        errors.push(error);
        continue; // try the next validated address
      }
      return { kind: 'failed', errorCode: 'CONNECTION_FAILED', latencyMs: latency() };
    }
  }
  const first = errors[0];
  return { kind: 'failed', errorCode: first?.errorCode ?? 'CONNECTION_FAILED', latencyMs: latency() };
}

function requestOverPinnedSocket(
  ip: string,
  port: number,
  hostname: string,
  hostHeader: string,
  path: string,
  timeoutMs: number,
  connectPinned: NonNullable<ProbeDeps['connectPinned']>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(probeFailure('TIMEOUT'));
      }
    }, timeoutMs);
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    connectPinned(ip, port, hostname).then(
      (socket) => {
        const req = https.request(
          {
            path,
            method: 'GET',
            headers: { Host: hostHeader, Accept: '*/*', Connection: 'close' },
            // No agent reuse, no proxy: raw pinned socket only.
            createConnection: (
              _opts: unknown,
              oncreate: (err: Error | null, s: Duplex) => void,
            ): Duplex => {
              const duplex = socket as unknown as Duplex;
              oncreate(null, duplex);
              return duplex;
            },
            timeout: timeoutMs,
          },
          (res: import('node:http').IncomingMessage) => {
            let bytes = 0;
            res.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > PROBE_BODY_CAP_BYTES) {
                // Body cap: stop reading, report the status line only.
                res.destroy();
              }
            });
            res.on('end', () => {
              done(() => resolve(res.statusCode ?? 0));
            });
            res.on('error', () => {
              done(() => reject(probeFailure('INVALID_RESPONSE')));
            });
          },
        );
        req.on('timeout', () => {
          req.destroy();
          done(() => reject(probeFailure('TIMEOUT')));
        });
        req.on('error', (error) => {
          done(() => reject(classifySocketError(error)));
        });
        req.end();
      },
      (error: unknown) => {
        done(() => reject(error instanceof ProbeFailure ? error : probeFailure('CONNECTION_FAILED')));
      },
    );
  });
}
