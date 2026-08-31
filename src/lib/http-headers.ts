/**
 * Pure readers for the response headers a maintenance check reports on.
 *
 * Kept free of I/O so the awkward cases — a disabling `max-age=0`, two HSTS
 * headers, a report-only CSP that does not actually override `X-Frame-Options` —
 * are covered by plain unit tests.
 */

/** Directives parsed from a `Strict-Transport-Security` header. */
export interface HstsDirectives {
  /** `max-age` in seconds, or `null` when the directive is absent or malformed. */
  maxAgeSeconds: number | null;
  /** Whether `includeSubDomains` is present. */
  includeSubDomains: boolean;
  /** Whether `preload` is present. */
  preload: boolean;
  /**
   * Whether this header actively switches HSTS **off**.
   *
   * RFC 6797 gives `max-age=0` a specific meaning: delete the existing policy.
   * It is a deliberate disable, not a low value, and must not be reported as
   * merely a weak setting.
   */
  activelyDisabled: boolean;
}

/** The minimum `max-age` the HSTS preload list requires, in seconds: one year. */
export const PRELOAD_MIN_MAX_AGE = 31_536_000;

/**
 * Parses a `Strict-Transport-Security` header value.
 *
 * When a server sends the header more than once, `Headers.get` joins the values
 * with a comma. RFC 6797 §8.1 says a user agent processes only the first, so
 * everything after the first comma is discarded here too.
 *
 * @param value The raw header value, or `null` when absent.
 * @returns The directives, or `null` when the header was not sent.
 * @throws Never.
 */
export function parseHsts(value: string | null): HstsDirectives | null {
  if (value === null) return null;

  const first = value.split(',')[0] ?? '';
  const directives = first
    .split(';')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '');

  const maxAgeDirective = directives.find((part) => part.startsWith('max-age='));
  const rawMaxAge = maxAgeDirective?.slice('max-age='.length).replace(/^"|"$/g, '');
  const maxAgeSeconds =
    rawMaxAge !== undefined && /^\d+$/.test(rawMaxAge) ? Number(rawMaxAge) : null;

  return {
    maxAgeSeconds,
    includeSubDomains: directives.includes('includesubdomains'),
    preload: directives.includes('preload'),
    activelyDisabled: maxAgeSeconds === 0,
  };
}

/**
 * Whether a policy would satisfy the HSTS preload list's requirements.
 *
 * Reported for information only. hstspreload.org explicitly asks tools not to
 * recommend `preload` by default — the directive commits a domain to
 * HTTPS-only in a way that is slow and awkward to undo — so a site without it
 * is never a finding here.
 *
 * @param hsts Parsed directives, or `null`.
 * @param upgradesToHttps Whether plain HTTP redirects to HTTPS on the same host.
 * @returns Whether every published requirement is met.
 * @throws Never.
 */
export function isPreloadEligible(hsts: HstsDirectives | null, upgradesToHttps: boolean): boolean {
  if (hsts === null) return false;
  return (
    hsts.maxAgeSeconds !== null &&
    hsts.maxAgeSeconds >= PRELOAD_MIN_MAX_AGE &&
    hsts.includeSubDomains &&
    hsts.preload &&
    upgradesToHttps
  );
}

/** Security-relevant headers, read from a response. */
export interface SecurityHeaders {
  contentSecurityPolicy: string | null;
  /** Whether the only policy present is report-only, which enforces nothing. */
  contentSecurityPolicyReportOnly: boolean;
  /** Which mechanism, if any, actually prevents the page being framed. */
  framingProtection: 'csp-frame-ancestors' | 'x-frame-options' | 'none';
  xContentTypeOptions: string | null;
  referrerPolicy: string | null;
  permissionsPolicy: string | null;
  crossOriginOpenerPolicy: string | null;
  reportingEndpoints: string | null;
  /**
   * Headers that are present but do nothing in any current browser, such as
   * `X-XSS-Protection`. Worth removing; never worth adding, so their *absence*
   * is not reported.
   */
  deadHeadersPresent: string[];
}

/** Headers that no shipping browser acts on any more. */
const DEAD_HEADERS = ['x-xss-protection', 'expect-ct', 'public-key-pins'];

/**
 * Reads the security headers worth reporting on.
 *
 * @param headers Response headers.
 * @returns What was found, with `null` for anything absent.
 * @throws Never.
 */
export function readSecurityHeaders(headers: Headers): SecurityHeaders {
  const csp = headers.get('content-security-policy');
  const cspReportOnly = headers.get('content-security-policy-report-only');
  const xfo = headers.get('x-frame-options');

  return {
    contentSecurityPolicy: csp ?? cspReportOnly,
    contentSecurityPolicyReportOnly: csp === null && cspReportOnly !== null,
    // `frame-ancestors` overrides X-Frame-Options only when the policy is
    // enforced. A report-only policy does not, so the header still does the work.
    framingProtection:
      csp !== null && csp.toLowerCase().includes('frame-ancestors')
        ? 'csp-frame-ancestors'
        : xfo !== null
          ? 'x-frame-options'
          : 'none',
    xContentTypeOptions: headers.get('x-content-type-options'),
    referrerPolicy: headers.get('referrer-policy'),
    permissionsPolicy: headers.get('permissions-policy'),
    crossOriginOpenerPolicy: headers.get('cross-origin-opener-policy'),
    reportingEndpoints: headers.get('reporting-endpoints'),
    deadHeadersPresent: DEAD_HEADERS.filter((name) => headers.get(name) !== null),
  };
}
