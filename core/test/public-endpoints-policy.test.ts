/**
 * Public-endpoint URL policy + IP classification (pure unit tests, no DB).
 *
 * Covers: scheme enforcement, canonicalization, label bounds, limit/unique
 * constants, and the SSRF deny surface (IP literals, private/loopback/
 * link-local/CGNAT/multicast/reserved/documentation, IPv4-mapped IPv6,
 * 6to4/Teredo/ISATAP with embedded private IPv4, mixed public+private DNS
 * answers, DNS rebinding shape via assertAllAddressesPublic).
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_ENDPOINTS_PER_SERVICE,
  assertAllAddressesPublic,
  assertValidLabel,
  isPublicIp,
  normalizePublicUrl,
  unwrapEmbeddedIPv4,
} from '../src/public-endpoints/url-policy.js';

describe('normalizePublicUrl', () => {
  it('prepends https:// when the user types a bare domain', () => {
    expect(normalizePublicUrl('filmy.moviak.quest')).toBe('https://filmy.moviak.quest/');
  });

  it('keeps an explicit https URL with path and query, canonical host', () => {
    expect(normalizePublicUrl('https://filmy.moviak.quest/Health')).toBe(
      'https://filmy.moviak.quest/Health',
    );
    expect(normalizePublicUrl('HTTPS://Filmy.Moviak.Quest/Health')).toBe(
      'https://filmy.moviak.quest/Health',
    );
  });

  it('accepts an explicit :443 and drops it in canonical form', () => {
    expect(normalizePublicUrl('https://example.com:443/a')).toBe('https://example.com/a');
  });

  it('rejects plain http without silent downgrade', () => {
    expect(() => normalizePublicUrl('http://example.com/')).toThrowError(/HTTP/i);
  });

  it('rejects other schemes, userinfo, fragments, ports and literals', () => {
    expect(() => normalizePublicUrl('ftp://example.com/')).toThrowError(/https/i);
    expect(() => normalizePublicUrl('https://user:pass@example.com/')).toThrowError(/logowania|userinfo/i);
    expect(() => normalizePublicUrl('https://example.com/#frag')).toThrowError(/fragment/i);
    expect(() => normalizePublicUrl('https://example.com:8443/')).toThrowError(/443/);
    expect(() => normalizePublicUrl('https://93.184.216.34/')).toThrowError(/nazwy DNS|IP/i);
    expect(() => normalizePublicUrl('https://[::1]/')).toThrowError(/nazwy DNS|IP/i);
    expect(() => normalizePublicUrl('https://localhost:443/')).toThrowError(/nazwy DNS|IP/i);
    expect(() => normalizePublicUrl('')).toThrowError(/Podaj adres/);
    expect(() => normalizePublicUrl('https://exa mple.com/')).toThrowError(/Nieprawid/);
  });

  it('validates labels usefully (bounded, no control chars)', () => {
    expect(() => assertValidLabel('x'.repeat(81))).toThrowError(/80/);
    expect(() => assertValidLabel('bad\x07label')).toThrowError(/niedozwolone/);
    expect(() => assertValidLabel('Jellyfin (publiczny)')).not.toThrow();
    expect(() => assertValidLabel(undefined)).not.toThrow();
  });

  it('caps endpoints per service at 5', () => {
    expect(MAX_ENDPOINTS_PER_SERVICE).toBe(5);
  });
});

describe('isPublicIp', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ])('accepts global-unicast %s', (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });

  it.each([
    // RFC1918 + loopback + link-local + CGNAT + multicast + reserved.
    '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '127.0.0.1', '169.254.10.20', '100.64.0.1', '100.127.255.254',
    '224.0.0.1', '255.255.255.255', '0.0.0.0',
    // IETF assignments, documentation, benchmarking.
    '192.0.2.1', '198.51.100.7', '203.0.113.9', '192.0.0.170',
    '198.18.0.1', '192.88.99.1',
    // IPv6 non-global: loopback, unspecified, link-local, ULA, multicast, docs.
    '::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', 'ff02::1',
    '2001:db8::1', '64:ff9b::192.0.2.1',
  ])('rejects non-public %s', (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it('rejects IPv4-mapped IPv6 hiding a private address', () => {
    expect(isPublicIp('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicIp('::ffff:192.168.1.1')).toBe(false);
    expect(isPublicIp('::ffff:8.8.8.8')).toBe(true);
  });

  it('rejects 6to4/Teredo/ISATAP wrapping private IPv4', () => {
    // 6to4 2002:0a00:0001:: embeds 10.0.0.1.
    expect(isPublicIp('2002:0a00:0001::1')).toBe(false);
    // 6to4 embedding public 8.8.8.8 stays public.
    expect(isPublicIp('2002:0808:0808::1')).toBe(true);
    // ISATAP with private tail.
    expect(isPublicIp('fe80::0:5efe:10.0.0.1')).toBe(false);
    // Teredo 2001:0000::/32 with obfuscated private client: use loopback
    // 127.0.0.1 -> obfuscated last32 = ~0x7f000001 = 0x80fffffe.
    expect(isPublicIp('2001:0000:4136:e378:8000:63bf:80ff:fffe')).toBe(false);
    expect(unwrapEmbeddedIPv4('2002:0a00:0001::1')).toBe('10.0.0.1');
  });
});

describe('assertAllAddressesPublic', () => {
  it('passes a clean public set through for pinning', () => {
    expect(assertAllAddressesPublic(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])).toHaveLength(2);
  });

  it('rejects empty answers and mixed public+private sets (rebinding shape)', () => {
    expect(() => assertAllAddressesPublic([])).toThrowError();
    expect(() => assertAllAddressesPublic(['93.184.216.34', '10.0.0.1'])).toThrowError(
      /publicznego adresu/,
    );
    expect(() => assertAllAddressesPublic(['::ffff:127.0.0.1'])).toThrowError(/publicznego adresu/);
  });
});
