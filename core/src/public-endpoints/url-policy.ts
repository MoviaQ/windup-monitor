/**
 * Public-endpoint URL policy (SSRF guard).
 *
 * This iteration is HTTPS-only by policy: only `https://` public DNS names,
 * port 443 (default or explicit). No userinfo, no fragments, bounded length.
 * IP literals are rejected outright; every resolved address must be
 * global-unicast public (fresh DNS per probe AND per redirect hop).
 *
 * Address parsing itself relies on Node's maintained parser (`net.isIP` /
 * c-ares via `node:dns`) — the deny ranges below are explicit CIDRs, not a
 * hand-rolled string allowlist. IPv4-mapped/6to4/Teredo forms are unwrapped
 * to their embedded IPv4 address before classification so a private target
 * cannot hide inside an IPv6 literal.
 */

import net from 'node:net';

export const MAX_URL_LENGTH = 2048;
export const MAX_LABEL_LENGTH = 80;
export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 3600;
export const MAX_TIMEOUT_SECONDS = 10;
export const MAX_ENDPOINTS_PER_SERVICE = 5;

/** Machine-readable validation failures (safe to show, no secrets). */
export type UrlPolicyErrorCode =
  | 'URL_REQUIRED'
  | 'URL_TOO_LONG'
  | 'URL_PARSE_FAILED'
  | 'SCHEME_MUST_BE_HTTPS'
  | 'HTTP_NOT_ALLOWED'
  | 'USERINFO_FORBIDDEN'
  | 'FRAGMENT_FORBIDDEN'
  | 'HOST_REQUIRED'
  | 'IP_LITERAL_FORBIDDEN'
  | 'PORT_FORBIDDEN'
  | 'LABEL_TOO_LONG'
  | 'LABEL_INVALID';

export class UrlPolicyError extends Error {
  readonly code: UrlPolicyErrorCode;
  constructor(code: UrlPolicyErrorCode, message: string) {
    super(message);
    this.name = 'UrlPolicyError';
    this.code = code;
  }
}

const MESSAGES: Record<UrlPolicyErrorCode, string> = {
  URL_REQUIRED: 'Podaj adres URL.',
  URL_TOO_LONG: `Adres URL może mieć maksymalnie ${MAX_URL_LENGTH} znaków.`,
  URL_PARSE_FAILED: 'Nieprawidłowy adres URL. Przykład: https://status.example.com/health',
  SCHEME_MUST_BE_HTTPS: 'Dozwolony jest tylko adres https:// (zwykły HTTP nie jest obsługiwany).',
  HTTP_NOT_ALLOWED: 'Zwykły HTTP nie jest obsługiwany — użyj adresu https://.',
  USERINFO_FORBIDDEN: 'Adres URL nie może zawierać danych logowania (userinfo).',
  FRAGMENT_FORBIDDEN: 'Adres URL nie może zawierać fragmentu (#...).',
  HOST_REQUIRED: 'Adres URL musi zawierać publiczną nazwę hosta DNS.',
  IP_LITERAL_FORBIDDEN: 'Adres IP nie jest dozwolony — użyj publicznej nazwy DNS.',
  PORT_FORBIDDEN: 'Dozwolony jest tylko domyślny port 443 (jawny :443 też jest OK).',
  LABEL_TOO_LONG: `Etykieta może mieć maksymalnie ${MAX_LABEL_LENGTH} znaków.`,
  LABEL_INVALID: 'Etykieta zawiera niedozwolone znaki kontrolne.',
};

/**
 * Normalizes user input: trims, prepends `https://` when no scheme is
 * present (bare `filmy.moviak.quest` → `https://filmy.moviak.quest`), and
 * returns the canonical URL string. Throws UrlPolicyError with a
 * user-facing Polish message on violation.
 */
export function normalizePublicUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new UrlPolicyError('URL_REQUIRED', MESSAGES.URL_REQUIRED);
  }
  if (/[\s<>]/.test(trimmed)) {
    throw new UrlPolicyError('URL_PARSE_FAILED', MESSAGES.URL_PARSE_FAILED);
  }
  if (trimmed.length > MAX_URL_LENGTH + 'https://'.length) {
    throw new UrlPolicyError('URL_TOO_LONG', MESSAGES.URL_TOO_LONG);
  }
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new UrlPolicyError('URL_PARSE_FAILED', MESSAGES.URL_PARSE_FAILED);
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme === 'http:') {
    throw new UrlPolicyError('HTTP_NOT_ALLOWED', MESSAGES.HTTP_NOT_ALLOWED);
  }
  if (scheme !== 'https:') {
    throw new UrlPolicyError('SCHEME_MUST_BE_HTTPS', MESSAGES.SCHEME_MUST_BE_HTTPS);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new UrlPolicyError('USERINFO_FORBIDDEN', MESSAGES.USERINFO_FORBIDDEN);
  }
  if (parsed.hash !== '') {
    throw new UrlPolicyError('FRAGMENT_FORBIDDEN', MESSAGES.FRAGMENT_FORBIDDEN);
  }
  const host = parsed.hostname.toLowerCase();
  if (host === '') {
    throw new UrlPolicyError('HOST_REQUIRED', MESSAGES.HOST_REQUIRED);
  }
  // URL keeps IPv6 literals bracketed (`[::1]`); strip for classification.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new UrlPolicyError('IP_LITERAL_FORBIDDEN', MESSAGES.IP_LITERAL_FORBIDDEN);
  }
  if (net.isIP(bare) !== 0) {
    throw new UrlPolicyError('IP_LITERAL_FORBIDDEN', MESSAGES.IP_LITERAL_FORBIDDEN);
  }
  // Least-surprise host sanity: no trailing dot abuse, valid DNS chars.
  if (host.length > 253 || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host) || host.includes('..')) {
    throw new UrlPolicyError('URL_PARSE_FAILED', MESSAGES.URL_PARSE_FAILED);
  }
  const port = parsed.port;
  if (port !== '' && port !== '443') {
    throw new UrlPolicyError('PORT_FORBIDDEN', MESSAGES.PORT_FORBIDDEN);
  }
  // Canonical form: lowercase host, drop default port, keep path/query.
  parsed.hostname = host;
  if (parsed.port === '443') parsed.port = '';
  const canonical = parsed.toString();
  if (canonical.length > MAX_URL_LENGTH) {
    throw new UrlPolicyError('URL_TOO_LONG', MESSAGES.URL_TOO_LONG);
  }
  return canonical;
}

/** Validates the optional operator label (bounded, no control chars). */
export function assertValidLabel(label: string | undefined): void {
  if (label === undefined) return;
  if (label.length > MAX_LABEL_LENGTH) {
    throw new UrlPolicyError('LABEL_TOO_LONG', MESSAGES.LABEL_TOO_LONG);
  }
  if ([...label].some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127;
  })) {
    throw new UrlPolicyError('LABEL_INVALID', MESSAGES.LABEL_INVALID);
  }
}

/* ------------------------------------------------------------------ */
/* IP classification: every resolved address must be global-unicast.   */
/* ------------------------------------------------------------------ */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value >>> 0;
}

function inCidr4(ipInt: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** Denied IPv4 ranges: RFC1918, loopback, link-local, CGNAT, multicast, etc. */
const DENIED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT shared space
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1 documentation
  ['192.88.99.0', 24], // 6to4 relay (deprecated)
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2 documentation
  ['203.0.113.0', 24], // TEST-NET-3 documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
  ['255.255.255.255', 32], // broadcast
];

function ipv6ToBigint(ip: string): bigint | null {
  // Expand via Node-maintained parsing: use a dummy validation by round-trip.
  // Manual expansion supporting :: compression and embedded IPv4.
  try {
    let head: string[] = [];
    let tail: string[] = [];
    if (ip.includes('::')) {
      const parts = ip.split('::');
      const hPart = parts[0] ?? '';
      const tPart = parts[1] ?? '';
      head = hPart === '' ? [] : hPart.split(':');
      tail = tPart === '' ? [] : tPart.split(':');
    } else {
      head = ip.split(':');
    }
    const expandPart = (part: string): string[] => {
      if (part.includes('.')) {
        const n = ipv4ToInt(part);
        if (n === null) throw new Error('bad embedded v4');
        return [((n >>> 16) & 0xffff).toString(16), (n & 0xffff).toString(16)];
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) throw new Error('bad hextet');
      return [part];
    };
    const headGroups = head.flatMap(expandPart);
    const tailGroups = tail.flatMap(expandPart);
    const missing = 8 - headGroups.length - tailGroups.length;
    if (ip.includes('::')) {
      if (missing < 0) return null;
      const groups = [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups];
      if (groups.length !== 8) return null;
      return groups.reduce((acc, g) => (acc << BigInt(16)) + BigInt(parseInt(g, 16)), BigInt(0));
    }
    if (headGroups.length !== 8) return null;
    return headGroups.reduce((acc, g) => (acc << BigInt(16)) + BigInt(parseInt(g, 16)), BigInt(0));
  } catch {
    return null;
  }
}

function inCidr6(value: bigint, base: string, bits: number): boolean {
  const baseVal = ipv6ToBigint(base);
  if (baseVal === null) return false;
  if (bits === 0) return true;
  const shift = BigInt(128 - bits);
  return (value >> shift) === (baseVal >> shift);
}

const DENIED_V6: Array<[string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // IPv4/IPv6 translation (well-known prefix)
  ['64:ff9b:1::', 48], // local-use translation prefix
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments (incl. Teredo 2001::/32)
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation (extra range)
  ['5f00::', 16], // segment routing SIDs (not global unicast)
  ['fc00::', 7], // unique-local (ULA)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];

/**
 * Unwraps special IPv6 forms to the embedded IPv4 address when present:
 * IPv4-mapped (`::ffff:10.0.0.1`), 6to4 (`2002:0a00:0001::`), Teredo
 * (`2001:<...>`) carries the obfuscated client IPv4 in the last 32 bits.
 * Returns the dotted IPv4 string or null when not an embedded form.
 */
export function unwrapEmbeddedIPv4(ip: string): string | null {
  const lowered = ip.toLowerCase();
  // IPv4-mapped or translated: ::ffff:a.b.c.d (also 64:ff9b::a.b.c.d handled by prefix deny).
  const mapped = lowered.match(/^(?:::ffff:(?:0{1,4}:)?)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped?.[1] && net.isIP(mapped[1]) === 4) return mapped[1];
  if (lowered.startsWith('64:ff9b:')) {
    const tail = lowered.split(':').pop() ?? '';
    if (net.isIP(tail) === 4) return tail;
  }
  const value = ipv6ToBigint(ip);
  if (value === null) return null;
  // 6to4: 2002:<v4-high16>:<v4-low16>::/48 — top 16 bits are 0x2002.
  if ((value >> BigInt(112)) === BigInt(0x2002)) {
    const v4 = Number((value >> BigInt(80)) & BigInt(0xffffffff));
    return `${(v4 >>> 24) & 255}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`;
  }
  // Teredo: 2001:0000:/32 — client IPv4 is bitwise-NOT of the last 32 bits.
  if ((value >> BigInt(96)) === BigInt(0x20010000)) {
    const obfuscated = Number(value & BigInt(0xffffffff));
    const v4 = (~obfuscated) >>> 0;
    return `${(v4 >>> 24) & 255}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`;
  }
  // ISATAP: ...:0:5efe:a.b.c.d
  const isatap = lowered.match(/:0:5efe:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (isatap?.[1] && net.isIP(isatap[1]) === 4) return isatap[1];
  return null;
}

/**
 * True only for global-unicast public addresses. Everything else —
 * private, loopback, link-local, CGNAT, multicast, reserved,
 * documentation, benchmarking, unspecified, ULA — is rejected.
 */
export function isPublicIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const n = ipv4ToInt(ip);
    if (n === null) return false;
    return !DENIED_V4.some(([base, bits]) => inCidr4(n, base, bits));
  }
  if (version === 6) {
    const embedded = unwrapEmbeddedIPv4(ip);
    if (embedded) return isPublicIp(embedded);
    const value = ipv6ToBigint(ip);
    if (value === null) return false;
    return !DENIED_V6.some(([base, bits]) => inCidr6(value, base, bits));
  }
  return false;
}

/**
 * Validates a freshly resolved address set for one DNS name: non-empty and
 * every address public. Returns the list unchanged for pinning.
 * Throws UrlPolicyError (HOST_REQUIRED message reused — no address leak).
 */
export function assertAllAddressesPublic(addresses: string[]): string[] {
  if (addresses.length === 0) {
    throw new UrlPolicyError('HOST_REQUIRED', MESSAGES.HOST_REQUIRED);
  }
  for (const address of addresses) {
    if (!isPublicIp(address)) {
      throw new UrlPolicyError(
        'IP_LITERAL_FORBIDDEN',
        'Nazwa hosta nie prowadzi do publicznego adresu (odrzucono ze względów bezpieczeństwa).',
      );
    }
  }
  return addresses;
}
