import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { invalidBody } from '../lib/errors.js';

/**
 * Server-side validation for custom provider base URLs
 * (docs/ai-integration-contract.md §5). Goal: an operator can point the app at
 * a self-hosted OpenAI-compatible server (loopback and private ranges are
 * legitimate targets), while obvious SSRF pivots stay closed: cloud metadata
 * endpoints (169.254.169.254 and friends), link-local, multicast and
 * unspecified addresses are rejected. Redirects are never followed with
 * credentials (see providers.ts: `redirect: 'manual'`).
 */

const BLOCKED_V4: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'unspecified range'],
  ['169.254.0.0', 16, 'link-local range (includes cloud metadata endpoints)'],
  ['224.0.0.0', 4, 'multicast range'],
  ['255.255.255.255', 32, 'broadcast address'],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function blockedV4Reason(ip: string): string | null {
  const value = ipv4ToInt(ip);
  if (value === null) return 'invalid IPv4 address';
  for (const [base, prefix, reason] of BLOCKED_V4) {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((value & mask) === (baseValue & mask)) return reason;
  }
  return null;
}

/** Expands an IPv6 literal into eight 16-bit groups (handles `::` and a trailing embedded IPv4). */
function expandIpv6(ip: string): number[] | null {
  let value = ip;
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (dotted) {
    const v4 = ipv4ToInt(dotted[1] ?? '');
    if (v4 === null) return null;
    value = `${value.slice(0, dotted.index + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null;
  return [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
}

/**
 * Returns a human-readable reason when the literal IP must not be dialed.
 * Handles normalized v4-mapped (`::ffff:a9fe:a9fe`) and NAT64 (`64:ff9b::…`)
 * forms produced by the WHATWG URL parser, not just dotted-quad spellings.
 */
export function blockedIpReason(raw: string): string | null {
  const ip = raw.replace(/^\[|\]$/g, '');
  const family = isIP(ip);
  if (family === 4) return blockedV4Reason(ip);
  if (family !== 6) return 'invalid IP address';

  const groups = expandIpv6(ip.toLowerCase());
  if (!groups) return 'invalid IP address';

  const allZero = (from: number, to: number): boolean =>
    groups.slice(from, to).every((group) => group === 0);

  // v4-mapped ::ffff:a.b.c.d → evaluate the embedded IPv4 against v4 rules.
  if (allZero(0, 5) && groups[5] === 0xffff) {
    return blockedV4Reason(`${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`);
  }
  // NAT64 64:ff9b::/96 → likewise for the embedded IPv4.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && allZero(2, 6)) {
    return blockedV4Reason(`${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`);
  }
  if (allZero(0, 8)) return 'unspecified address';
  if ((groups[0]! & 0xffc0) === 0xfe80) return 'link-local range';
  if ((groups[0]! & 0xff00) === 0xff00) return 'multicast range';
  return null;
}

/**
 * Parses and validates a custom provider base URL. Returns the normalized URL
 * (trailing slashes stripped). Throws `INVALID_BODY` on any violation.
 */
export function parseCustomBaseUrl(raw: string): string {
  const value = raw.trim();
  if (value.length === 0 || value.length > 2000) throw invalidBody('Invalid provider base URL');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidBody('Invalid provider base URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidBody('Provider base URL must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw invalidBody('Provider base URL must not contain credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw invalidBody('Provider base URL must not contain a query or fragment');
  }
  if (url.hostname === '') throw invalidBody('Provider base URL must contain a host');

  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) !== 0) {
    const reason = blockedIpReason(literal);
    if (reason) throw invalidBody(`Provider base URL host is not allowed: ${reason}`);
  }

  // Strip trailing slashes so callers can join `/models` reliably.
  return url.toString().replace(/\/+$/, '');
}

export type LookupFn = (hostname: string) => Promise<string[]>;

const defaultLookup: LookupFn = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
};

/**
 * Resolves a hostname before any outbound call and rejects the target when any
 * resolved address falls into a blocked range. IP literals are checked
 * directly. Known limitation (documented): this closes the obvious metadata /
 * link-local pivots but does not eliminate DNS rebinding between this check
 * and the connection.
 */
export async function assertResolvableSafeHost(
  baseUrl: string,
  resolve: LookupFn = defaultLookup,
): Promise<void> {
  const url = new URL(parseCustomBaseUrl(baseUrl));
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) !== 0) return; // already validated in parseCustomBaseUrl

  let addresses: string[];
  try {
    addresses = await resolve(url.hostname);
  } catch {
    throw invalidBody('Provider base URL host cannot be resolved');
  }
  if (addresses.length === 0) throw invalidBody('Provider base URL host cannot be resolved');
  for (const address of addresses) {
    const reason = blockedIpReason(address);
    if (reason) {
      throw invalidBody(`Provider base URL host resolves to a blocked address: ${reason}`);
    }
  }
}
