import { describe, expect, it } from 'vitest';
import { isPreloadEligible, parseHsts, readSecurityHeaders } from '../../src/lib/http-headers.js';

describe('parseHsts', () => {
  it('is null when the header was not sent', () => {
    expect(parseHsts(null)).toBeNull();
  });

  it('reads max-age and the directives', () => {
    expect(parseHsts('max-age=31536000; includeSubDomains; preload')).toEqual({
      maxAgeSeconds: 31_536_000,
      includeSubDomains: true,
      preload: true,
      activelyDisabled: false,
    });
  });

  it('is case- and whitespace-insensitive about directives', () => {
    expect(parseHsts('Max-Age=600 ;  IncludeSubDomains')).toMatchObject({
      maxAgeSeconds: 600,
      includeSubDomains: true,
    });
  });

  it('treats max-age=0 as an active disable, not a weak setting', () => {
    // RFC 6797 gives this a specific meaning: delete the existing policy.
    expect(parseHsts('max-age=0')).toMatchObject({ maxAgeSeconds: 0, activelyDisabled: true });
  });

  it('processes only the first policy when a server sends several', () => {
    // Headers.get joins repeated headers with a comma; RFC 6797 says a user
    // agent processes only the first.
    expect(parseHsts('max-age=600, max-age=31536000; preload')).toMatchObject({
      maxAgeSeconds: 600,
      preload: false,
    });
  });

  it('accepts a quoted max-age', () => {
    expect(parseHsts('max-age="600"')?.maxAgeSeconds).toBe(600);
  });

  it('is null for a malformed max-age rather than guessing', () => {
    expect(parseHsts('max-age=forever')?.maxAgeSeconds).toBeNull();
    expect(parseHsts('includeSubDomains')?.maxAgeSeconds).toBeNull();
  });
});

describe('isPreloadEligible', () => {
  const full = 'max-age=31536000; includeSubDomains; preload';

  it('needs every published requirement, including the HTTP redirect', () => {
    expect(isPreloadEligible(parseHsts(full), true)).toBe(true);
    expect(isPreloadEligible(parseHsts(full), false)).toBe(false);
  });

  it('needs a full year of max-age', () => {
    expect(isPreloadEligible(parseHsts('max-age=31535999; includeSubDomains; preload'), true)).toBe(
      false,
    );
  });

  it('needs both directives', () => {
    expect(isPreloadEligible(parseHsts('max-age=31536000; preload'), true)).toBe(false);
    expect(isPreloadEligible(parseHsts('max-age=31536000; includeSubDomains'), true)).toBe(false);
  });

  it('is false when no policy is sent at all', () => {
    expect(isPreloadEligible(null, true)).toBe(false);
  });
});

describe('readSecurityHeaders', () => {
  it('reports nothing found on a bare response', () => {
    const result = readSecurityHeaders(new Headers());
    expect(result).toMatchObject({
      contentSecurityPolicy: null,
      contentSecurityPolicyReportOnly: false,
      framingProtection: 'none',
      deadHeadersPresent: [],
    });
  });

  it('recognises frame-ancestors as the framing protection', () => {
    const headers = new Headers({ 'content-security-policy': "frame-ancestors 'none'" });
    expect(readSecurityHeaders(headers).framingProtection).toBe('csp-frame-ancestors');
  });

  it('keeps X-Frame-Options as the protection when the policy is report-only', () => {
    // A report-only policy enforces nothing, so it does not override the header.
    const headers = new Headers({
      'content-security-policy-report-only': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    });
    const result = readSecurityHeaders(headers);
    expect(result.framingProtection).toBe('x-frame-options');
    expect(result.contentSecurityPolicyReportOnly).toBe(true);
  });

  it('does not call a policy report-only when an enforcing one is also present', () => {
    const headers = new Headers({
      'content-security-policy': "default-src 'self'",
      'content-security-policy-report-only': "default-src 'none'",
    });
    expect(readSecurityHeaders(headers).contentSecurityPolicyReportOnly).toBe(false);
  });

  it('lists headers that are present but inert in current browsers', () => {
    const headers = new Headers({ 'x-xss-protection': '1; mode=block' });
    expect(readSecurityHeaders(headers).deadHeadersPresent).toEqual(['x-xss-protection']);
  });

  it('reads the headers worth reporting', () => {
    const headers = new Headers({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'geolocation=()',
      'cross-origin-opener-policy': 'same-origin',
      'reporting-endpoints': 'default="https://example.com/reports"',
    });
    expect(readSecurityHeaders(headers)).toMatchObject({
      xContentTypeOptions: 'nosniff',
      referrerPolicy: 'strict-origin-when-cross-origin',
      permissionsPolicy: 'geolocation=()',
      crossOriginOpenerPolicy: 'same-origin',
      reportingEndpoints: 'default="https://example.com/reports"',
    });
  });
});
