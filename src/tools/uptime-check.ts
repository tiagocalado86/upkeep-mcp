import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { LIMITS, TIMEOUTS } from '../lib/defaults.js';
import { CheckError } from '../lib/errors.js';
import {
  isPreloadEligible,
  parseHsts,
  readSecurityHeaders,
  type SecurityHeaders,
} from '../lib/http-headers.js';
import type { HttpHopResult } from '../lib/http-client.js';
import { createDefaultPorts, type Ports } from '../lib/ports.js';
import { findingSchema, severitySchema } from '../lib/schemas.js';
import { finding, worstSeverity } from '../lib/severity.js';
import { fail, guard, succeed } from '../lib/tool-result.js';
import type { Finding, HttpHop } from '../types.js';

const inputSchema = z.object({
  url: z
    .string()
    .describe(
      'The page to request, e.g. "https://example.com". A bare domain such as "example.com" is ' +
        'accepted and tried over HTTPS. Include the path when a specific page matters; the ' +
        'homepage is checked otherwise.',
    ),
});

type Input = z.infer<typeof inputSchema>;

const hopSchema = z.object({
  url: z.string().describe('The URL requested at this hop.'),
  status: z.int().describe('HTTP status returned.'),
  location: z
    .string()
    .nullable()
    .describe('The Location header, or null when this was the destination.'),
  elapsedMs: z.int().describe('Wall-clock milliseconds for this hop alone.'),
});

const outputSchema = z.object({
  url: z.string().describe('The URL that was requested first.'),
  finalUrl: z.string().nullable().describe('Where the redirect chain ended.'),
  checkedAt: z.iso.datetime().describe('When the check ran, ISO 8601 in UTC.'),
  severity: severitySchema,
  findings: z.array(findingSchema).describe('What needs attention, worst first.'),

  reachable: z.boolean().describe('Whether the server answered at all.'),
  status: z.int().nullable().describe('Status code at the end of the redirect chain.'),
  responseTimeMs: z
    .int()
    .nullable()
    .describe(
      'Wall-clock milliseconds to the first response headers. Includes DNS, TCP and TLS setup, so ' +
        'it is not server processing time.',
    ),

  redirects: z
    .object({
      hops: z.array(hopSchema).describe('Every hop, in order.'),
      truncated: z.boolean().describe('Whether the chain hit the hop limit before ending.'),
      loopDetected: z
        .boolean()
        .describe('Whether the chain revisited a URL it had already requested.'),
      crossHost: z
        .boolean()
        .describe('Whether the chain ended on a different host than it started.'),
    })
    .describe('The redirect chain, followed manually one hop at a time.'),

  https: z
    .object({
      probedHttp: z.boolean().describe('Whether plain HTTP was probed for an upgrade.'),
      upgradesToHttps: z.boolean().describe('Whether plain HTTP eventually reaches HTTPS.'),
      upgradeOnFirstHop: z
        .boolean()
        .describe('Whether the very first HTTP response redirects to HTTPS.'),
    })
    .describe('Whether visitors arriving over plain HTTP are moved to HTTPS.'),

  hsts: z
    .object({
      present: z.boolean().describe('Whether Strict-Transport-Security was sent over HTTPS.'),
      maxAgeSeconds: z.int().nullable().describe('The max-age directive, in seconds.'),
      activelyDisabled: z
        .boolean()
        .describe(
          'True when max-age=0, which deletes an existing policy rather than weakening it.',
        ),
      includeSubDomains: z.boolean().describe('Whether includeSubDomains is set.'),
      preload: z.boolean().describe('Whether the preload directive is set.'),
      preloadEligible: z
        .boolean()
        .describe(
          'Whether the policy would meet the preload list requirements. Informational only — ' +
            'preload is an opt-in commitment and its absence is never reported as a problem.',
        ),
    })
    .describe('The HSTS policy, read from the HTTPS response only.'),

  securityHeaders: z
    .object({
      contentSecurityPolicy: z.string().nullable(),
      contentSecurityPolicyReportOnly: z
        .boolean()
        .describe('True when the only policy present is report-only, which enforces nothing.'),
      framingProtection: z
        .enum(['csp-frame-ancestors', 'x-frame-options', 'none'])
        .describe('Which mechanism actually prevents the page being framed.'),
      xContentTypeOptions: z.string().nullable(),
      referrerPolicy: z.string().nullable(),
      permissionsPolicy: z.string().nullable().describe('Acted on by Chromium browsers only.'),
      crossOriginOpenerPolicy: z.string().nullable(),
      reportingEndpoints: z.string().nullable(),
      deadHeadersPresent: z
        .array(z.string())
        .describe(
          'Headers present but inert in every current browser. Worth removing, never worth adding.',
        ),
    })
    .describe('Security-relevant response headers.'),
});

/**
 * Runs an uptime check.
 *
 * @param input The validated tool input.
 * @param ports The I/O boundary.
 * @returns An MCP result. A server that never answers is a genuine failure.
 * @throws Never.
 */
export async function runUptimeCheck(input: Input, ports: Ports): Promise<CallToolResult> {
  const start = normaliseUrl(input.url);
  if (start === null) return fail('invalid_input', `"${input.url}" is not a usable URL`);

  const now = ports.now();
  let chain: ChainResult;
  try {
    chain = await followChain(start.toString(), ports);
  } catch (cause) {
    return cause instanceof CheckError
      ? fail(cause.code, cause.message)
      : fail('network', `could not reach ${start.toString()}`);
  }

  const final = chain.hops.at(-1);
  const finalUrl = final === undefined ? null : final.url;
  const https = await probeHttpUpgrade(start, chain, ports);

  const overHttps = finalUrl !== null && new URL(finalUrl).protocol === 'https:';
  // RFC 6797 §8.1: a Strict-Transport-Security header received over plain HTTP
  // must be ignored, so it is only read when the chain ended on HTTPS.
  const hsts = overHttps
    ? parseHsts(chain.finalHeaders?.get('strict-transport-security') ?? null)
    : null;
  const securityHeaders = readSecurityHeaders(chain.finalHeaders ?? new Headers());

  const findings = collectFindings({ chain, https, hsts, securityHeaders, overHttps });

  const report = {
    url: start.toString(),
    finalUrl,
    checkedAt: now.toISOString(),
    severity: worstSeverity(findings),
    findings,
    reachable: chain.hops.length > 0,
    status: final?.status ?? null,
    responseTimeMs: chain.hops[0]?.elapsedMs ?? null,
    redirects: {
      hops: chain.hops,
      truncated: chain.truncated,
      loopDetected: chain.loopDetected,
      crossHost: finalUrl !== null && new URL(finalUrl).host !== start.host,
    },
    https,
    hsts: {
      present: hsts !== null,
      maxAgeSeconds: hsts?.maxAgeSeconds ?? null,
      activelyDisabled: hsts?.activelyDisabled ?? false,
      includeSubDomains: hsts?.includeSubDomains ?? false,
      preload: hsts?.preload ?? false,
      preloadEligible: isPreloadEligible(hsts, https.upgradesToHttps),
    },
    securityHeaders,
  };

  return succeed(summarise(report), report);
}

/**
 * Registers the `uptime_check` tool.
 *
 * @param server The server to register on.
 * @param ports The I/O boundary. Defaults to real network access.
 * @throws Never.
 */
export function registerUptimeCheckTool(
  server: McpServer,
  ports: Ports = createDefaultPorts(),
): void {
  server.registerTool(
    'uptime_check',
    {
      title: 'Site reachability and headers',
      description: [
        'Requests a page and reports whether it answered, how long it took, the full redirect chain',
        'it went through, whether plain HTTP is upgraded to HTTPS, and which security headers came',
        'back.',
        '',
        'Use it to answer "is this site up?", "why does this URL take four redirects to load?",',
        '"does http:// still work and should it?" or "does this site send HSTS?". It is the check',
        'to run when a client reports that a page is down or slow.',
        '',
        'Do not use it to inspect a certificate — that is ssl_check — or for registration and DNS,',
        'which is domain_check. It fetches one page, not a whole site: use seo_audit for crawling.',
        '',
        'Redirects are followed one hop at a time so the whole chain is visible, up to ten hops.',
        'Response time is wall clock to the first response headers and includes DNS, TCP and TLS',
        'setup, so it is not a measure of server processing time. Returns findings ordered by urgency.',
      ].join('\n'),
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    guard((args: Input) => runUptimeCheck(args, ports)),
  );
}

/**
 * Accepts a URL or a bare hostname.
 *
 * A bare hostname is tried over HTTPS: defaulting to plain HTTP would make every
 * such check report an upgrade redirect as though it were the site's real
 * behaviour.
 *
 * @param input Whatever the caller passed.
 * @returns The URL, or `null` when nothing usable could be made of it.
 * @throws Never.
 */
function normaliseUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.hostname === '' ? null : url;
  } catch {
    return null;
  }
}

/** The outcome of following a redirect chain. */
interface ChainResult {
  hops: HttpHop[];
  truncated: boolean;
  loopDetected: boolean;
  /** Headers from the last response, which is where the policy headers live. */
  finalHeaders: Headers | null;
}

/**
 * Follows redirects one hop at a time.
 *
 * Manual rather than `redirect: 'follow'` because the chain itself is the
 * interesting part: a site that takes four hops to serve its homepage is a
 * finding, and `follow` would hide it.
 *
 * @param startUrl Where to begin.
 * @param ports The I/O boundary.
 * @returns Every hop, plus whether the chain looped or was cut short.
 * @throws {CheckError} When the very first request fails; a failure part-way
 *   through is reported as the end of the chain instead.
 */
async function followChain(startUrl: string, ports: Ports): Promise<ChainResult> {
  const hops: HttpHop[] = [];
  const seen = new Set<string>();
  const budget = AbortSignal.timeout(TIMEOUTS.httpChainMs);

  let current = startUrl;
  let headers: Headers | null = null;
  let truncated = false;
  let loopDetected = false;

  for (let hop = 0; hop < LIMITS.maxRedirects; hop += 1) {
    if (seen.has(current)) {
      loopDetected = true;
      break;
    }
    seen.add(current);

    let response: HttpHopResult;
    try {
      response = await ports.http.hop(current, TIMEOUTS.httpHopMs, budget);
    } catch (cause) {
      // Only the first hop failing means the site is unreachable. A later failure
      // is still a useful, partially mapped chain.
      if (hops.length === 0) throw cause;
      break;
    }

    headers = response.headers;
    hops.push({
      url: response.url,
      status: response.status,
      location: response.location,
      elapsedMs: response.elapsedMs,
    });

    if (response.location === null || response.status < 300 || response.status >= 400) break;

    let next: URL;
    try {
      next = new URL(response.location, current);
    } catch {
      break;
    }
    current = next.toString();

    if (hop === LIMITS.maxRedirects - 1) truncated = true;
  }

  return { hops, truncated, loopDetected, finalHeaders: headers };
}

/** Whether plain HTTP reaches HTTPS. */
interface HttpsUpgrade {
  probedHttp: boolean;
  upgradesToHttps: boolean;
  upgradeOnFirstHop: boolean;
}

/**
 * Probes plain HTTP to see whether visitors are moved to HTTPS.
 *
 * A separate request from the main chain, because a check started at an
 * `https://` URL never touches port 80 and so can say nothing about it.
 *
 * @param start The URL the check began with.
 * @param mainChain The chain already followed, reused when it already started
 *   on plain HTTP so the same host is not requested twice.
 * @param ports The I/O boundary.
 * @returns What plain HTTP does, or an unprobed result when it could not be reached.
 * @throws Never.
 */
async function probeHttpUpgrade(
  start: URL,
  mainChain: ChainResult,
  ports: Ports,
): Promise<HttpsUpgrade> {
  const httpUrl = new URL(start.toString());
  httpUrl.protocol = 'http:';

  if (start.protocol === 'http:') return describeUpgrade(mainChain, httpUrl);

  try {
    return describeUpgrade(await followChain(httpUrl.toString(), ports), httpUrl);
  } catch {
    // A refused connection on port 80 is a legitimate configuration, not a
    // failure of the check.
    return { probedHttp: false, upgradesToHttps: false, upgradeOnFirstHop: false };
  }
}

/**
 * Reads an HTTP chain as an upgrade verdict.
 *
 * @param chain A chain that began on plain HTTP.
 * @param base The HTTP URL it began at, for resolving a relative Location.
 * @returns Whether and how quickly it reached HTTPS.
 * @throws Never.
 */
function describeUpgrade(chain: ChainResult, base: URL): HttpsUpgrade {
  const firstHop = chain.hops[0];
  const finalHop = chain.hops.at(-1);
  return {
    probedHttp: chain.hops.length > 0,
    upgradesToHttps: finalHop !== undefined && new URL(finalHop.url).protocol === 'https:',
    upgradeOnFirstHop:
      firstHop?.location != null && new URL(firstHop.location, base).protocol === 'https:',
  };
}

/**
 * Judges what the requests found.
 *
 * @param inputs The chain, the upgrade probe and the headers.
 * @returns Findings, in the order they were detected.
 * @throws Never.
 */
function collectFindings(inputs: {
  chain: ChainResult;
  https: HttpsUpgrade;
  hsts: ReturnType<typeof parseHsts>;
  securityHeaders: SecurityHeaders;
  overHttps: boolean;
}): Finding[] {
  const findings: Finding[] = [];
  const { chain, https, hsts, securityHeaders, overHttps } = inputs;
  const final = chain.hops.at(-1);

  if (final !== undefined) {
    if (final.status >= 500) {
      findings.push(
        finding('server_error', 'critical', `The server answered ${String(final.status)}.`),
      );
    } else if (final.status >= 400) {
      findings.push(
        finding('client_error', 'critical', `The page returned ${String(final.status)}.`),
      );
    }
  }

  if (chain.loopDetected) {
    findings.push(finding('redirect_loop', 'critical', 'The redirects loop back on themselves.'));
  }
  if (chain.truncated) {
    findings.push(
      finding(
        'redirect_chain_too_long',
        'warning',
        `The chain was still redirecting after ${String(LIMITS.maxRedirects)} hops.`,
      ),
    );
  }
  if (chain.hops.length > 3) {
    findings.push(
      finding(
        'redirect_chain_long',
        'info',
        `It takes ${String(chain.hops.length)} requests to reach the final page.`,
      ),
    );
  }

  if (https.probedHttp && !https.upgradesToHttps) {
    findings.push(
      finding('no_https_redirect', 'warning', 'Plain HTTP does not redirect to HTTPS.'),
    );
  }

  if (overHttps) {
    if (hsts === null) {
      findings.push(
        finding('hsts_missing', 'warning', 'No Strict-Transport-Security header is sent.'),
      );
    } else if (hsts.activelyDisabled) {
      findings.push(
        finding(
          'hsts_disabled',
          'critical',
          'Strict-Transport-Security is set to max-age=0, which switches the policy off.',
        ),
      );
    }
  }

  if (securityHeaders.contentSecurityPolicy === null) {
    findings.push(finding('csp_missing', 'info', 'No Content-Security-Policy header is sent.'));
  } else if (securityHeaders.contentSecurityPolicyReportOnly) {
    findings.push(
      finding(
        'csp_report_only',
        'info',
        'The Content-Security-Policy is report-only, so it enforces nothing.',
      ),
    );
  }

  if (securityHeaders.xContentTypeOptions === null) {
    findings.push(
      finding('nosniff_missing', 'info', 'No X-Content-Type-Options: nosniff header is sent.'),
    );
  }

  if (securityHeaders.deadHeadersPresent.length > 0) {
    findings.push(
      finding(
        'dead_headers_present',
        'info',
        `These headers do nothing in current browsers and can be removed: ${securityHeaders.deadHeadersPresent.join(', ')}.`,
      ),
    );
  }

  return findings;
}

/**
 * Renders the human-readable half of the result.
 *
 * @param report The structured report.
 * @returns Text for someone reading a transcript.
 * @throws Never.
 */
function summarise(report: {
  url: string;
  finalUrl: string | null;
  status: number | null;
  responseTimeMs: number | null;
  redirects: { hops: HttpHop[] };
  hsts: { present: boolean; maxAgeSeconds: number | null };
  findings: Finding[];
}): string {
  const lines: string[] = [];

  lines.push(
    `${report.url} answered ${String(report.status ?? 0)} in ${String(report.responseTimeMs ?? 0)}ms.`,
  );
  if (report.finalUrl !== null && report.finalUrl !== report.url) {
    lines.push(
      `Ends at ${report.finalUrl} after ${String(report.redirects.hops.length)} requests.`,
    );
  }
  lines.push(
    report.hsts.present
      ? `HSTS: max-age=${String(report.hsts.maxAgeSeconds ?? 0)}.`
      : 'HSTS: not sent.',
  );

  if (report.findings.length > 0) {
    lines.push('', 'Needs attention:');
    for (const item of report.findings) lines.push(`- [${item.severity}] ${item.message}`);
  }

  return lines.join('\n');
}
