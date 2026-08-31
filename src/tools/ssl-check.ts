import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { CERT_EXPIRY_WARNING_DAYS } from '../lib/defaults.js';
import { parseTarget } from '../lib/domain-name.js';
import { CheckError } from '../lib/errors.js';
import { createDefaultPorts, type Ports } from '../lib/ports.js';
import { findingSchema, severitySchema } from '../lib/schemas.js';
import {
  daysUntil,
  expirySeverity,
  finding,
  sortFindings,
  worstSeverity,
} from '../lib/severity.js';
import type { TlsInspection } from '../lib/tls.js';
import { fail, guard, succeed } from '../lib/tool-result.js';
import type { Finding } from '../types.js';

/**
 * TLS versions still considered acceptable for a client-facing site.
 *
 * An allow-list rather than a comparison: version strings do not order usefully,
 * and a future `TLSv1.4` should not be judged by this release's opinion of it.
 */
const ACCEPTABLE_PROTOCOLS = new Set(['TLSv1.2', 'TLSv1.3']);

const inputSchema = z.object({
  domain: z
    .string()
    .describe(
      'The host whose certificate should be inspected, e.g. "example.com" — no scheme, no ' +
        'trailing slash. A full URL is also accepted and reduced to its hostname. The certificate ' +
        'is read for exactly this host, so "www.example.com" and "example.com" are different checks.',
    ),
  port: z
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe(
      'TCP port to connect to. Defaults to 443. Use 8443, 993 and so on for other services.',
    ),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  host: z.string().describe('The host that was contacted, in ASCII (punycode) form.'),
  port: z.int().describe('The port that was contacted.'),
  checkedAt: z.iso.datetime().describe('When the check ran, ISO 8601 in UTC.'),
  severity: severitySchema,
  findings: z.array(findingSchema).describe('What needs attention, worst first.'),

  expiresAt: z.iso.datetime().nullable().describe('When the certificate expires, ISO 8601 UTC.'),
  daysUntilExpiry: z
    .int()
    .nullable()
    .describe(
      'Whole days until the certificate expires, negative if already expired. Floored, so a ' +
        'certificate expiring in a few hours reads as 0.',
    ),
  issuedAt: z.iso
    .datetime()
    .nullable()
    .describe('Start of the certificate validity, ISO 8601 UTC.'),
  issuer: z.string().nullable().describe('Issuer common name, e.g. "R11" or "GTS CA 1P5".'),
  subject: z.string().nullable().describe('Subject common name.'),
  serialNumber: z.string().nullable().describe('Certificate serial number, hexadecimal.'),
  fingerprintSha256: z.string().nullable().describe('SHA-256 fingerprint of the certificate.'),

  chain: z
    .object({
      valid: z.boolean().describe('Whether the chain verified against the system trust store.'),
      error: z
        .string()
        .nullable()
        .describe(
          'Why it did not verify, e.g. "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ' +
            '(a missing intermediate). Only one reason is reported even when several things are wrong.',
        ),
      length: z
        .int()
        .describe('Certificates in the chain, including the trust-store root when verified.'),
      issuers: z.array(z.string()).describe('Issuer common names, from the leaf upwards.'),
      revocationChecked: z
        .literal(false)
        .describe('Always false: this tool does not perform CRL or OCSP checks, and says so.'),
    })
    .describe('The certificate chain and whether it verified.'),

  coverage: z
    .object({
      subjectAltName: z
        .string()
        .nullable()
        .describe('The raw subjectAltName extension, for display.'),
      coversRequestedHost: z
        .boolean()
        .describe('Whether the certificate is valid for the host asked about.'),
      matchedVia: z
        .string()
        .nullable()
        .describe('Which SAN entry matched, e.g. "*.example.com". Null when nothing matched.'),
      coversApex: z
        .boolean()
        .describe('Whether the certificate covers the registrable domain itself.'),
      coversWww: z
        .boolean()
        .describe('Whether the certificate covers "www." plus the registrable domain.'),
      wwwResolves: z
        .boolean()
        .describe(
          'Whether "www." resolves at all. Missing www coverage only matters when it does.',
        ),
    })
    .describe('Which hostnames this certificate is valid for.'),

  tls: z
    .object({
      protocol: z.string().nullable().describe('Negotiated TLS version, e.g. "TLSv1.3".'),
      cipher: z.string().nullable().describe('Negotiated cipher suite.'),
      alpn: z
        .string()
        .nullable()
        .describe('Negotiated ALPN protocol, e.g. "h2". Null when none was agreed.'),
    })
    .describe('What the handshake negotiated.'),
});

/**
 * Runs an SSL check.
 *
 * @param input The validated tool input.
 * @param ports The I/O boundary.
 * @returns An MCP result. A handshake that cannot be completed is a genuine
 *   failure — there is nothing to report without one.
 * @throws Never.
 */
export async function runSslCheck(input: Input, ports: Ports): Promise<CallToolResult> {
  const target = parseTarget(input.domain);
  if (!target.ok) return fail('invalid_input', target.reason);

  const port = input.port ?? 443;
  const now = ports.now();
  const apex = target.registrable ?? target.ascii;
  const www = `www.${apex}`;
  const names = [...new Set([target.ascii, apex, www])];

  // `www` coverage only matters when `www` exists. Resolving it first is what
  // stops the check warning about a missing name on every domain that has none.
  const [dnsResult, tlsResult] = await Promise.allSettled([
    ports.dns.resolveRecords(apex),
    ports.tls.inspect(target.ascii, port, names),
  ]);

  if (tlsResult.status === 'rejected') {
    const error = tlsResult.reason as unknown;
    return error instanceof CheckError
      ? fail(error.code, error.message)
      : fail('network', `could not complete a TLS handshake with ${target.ascii}:${String(port)}`);
  }

  const inspection = tlsResult.value;
  const wwwResolves = dnsResult.status === 'fulfilled' ? dnsResult.value.wwwResolves : false;
  const leaf = inspection.chain.leaf;
  const daysUntilExpiry = daysUntil(leaf?.validTo ?? null, now);
  const severity = expirySeverity(daysUntilExpiry, CERT_EXPIRY_WARNING_DAYS);

  const coverage = {
    subjectAltName: inspection.subjectAltName,
    coversRequestedHost: inspection.hostMatches[target.ascii] !== null,
    matchedVia: inspection.hostMatches[target.ascii] ?? null,
    coversApex: (inspection.hostMatches[apex] ?? null) !== null,
    coversWww: (inspection.hostMatches[www] ?? null) !== null,
    wwwResolves,
  };

  const findings = sortFindings(
    collectFindings({
      host: target.ascii,
      port,
      inspection,
      coverage,
      daysUntilExpiry,
      severity,
      apex,
      www,
    }),
  );

  const result = {
    host: target.ascii,
    port,
    checkedAt: now.toISOString(),
    severity: worstSeverity(findings),
    findings,
    expiresAt: leaf?.validTo ?? null,
    daysUntilExpiry,
    issuedAt: leaf?.validFrom ?? null,
    issuer: leaf?.issuer ?? null,
    subject: leaf?.subject ?? null,
    serialNumber: leaf?.serialNumber ?? null,
    fingerprintSha256: leaf?.fingerprintSha256 ?? null,
    chain: {
      valid: inspection.chain.valid,
      error: inspection.chain.error,
      length: inspection.chain.length,
      issuers: inspection.chain.issuers,
      revocationChecked: false as const,
    },
    coverage,
    tls: { protocol: inspection.protocol, cipher: inspection.cipher, alpn: inspection.alpn },
  };

  return succeed(summarise(result), result);
}

/**
 * Registers the `ssl_check` tool.
 *
 * @param server The server to register on.
 * @param ports The I/O boundary. Defaults to real network access.
 * @throws Never.
 */
export function registerSslCheckTool(server: McpServer, ports: Ports = createDefaultPorts()): void {
  server.registerTool(
    'ssl_check',
    {
      title: 'SSL certificate',
      description: [
        'Inspects the TLS certificate a host actually serves: when it expires, who issued it,',
        'whether the chain verifies, which hostnames it covers, and which TLS version was',
        'negotiated.',
        '',
        'Use it to answer "when does this certificate need renewing?", "why does the browser warn',
        'about this site?" or "does the certificate cover www as well as the bare domain?" — the',
        'last being one of the most common real-world misconfigurations, along with a missing',
        'intermediate certificate, which is reported as UNABLE_TO_VERIFY_LEAF_SIGNATURE.',
        '',
        'Do not use it for domain registration expiry, which is a different date entirely — that is',
        'domain_check. It connects to the host but does not request a page; use uptime_check for that.',
        '',
        'Certificates that are expired, self-signed or untrusted are inspected and reported rather',
        'than refused. Revocation is not checked: Node performs no CRL or OCSP lookup, so a revoked',
        'certificate will be reported as a valid chain.',
        '',
        'A certificate is reported as a warning inside 14 days and as critical inside seven.',
        'That window is deliberately shorter than the one domain_check uses for registrations:',
        'ACME clients renew with 30 days left, so 28 days remaining is a healthy site in the',
        'middle of a normal renewal, not a problem. Returns findings ordered by urgency, worst first.',
      ].join('\n'),
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    guard((args: Input) => runSslCheck(args, ports)),
  );
}

/** What {@link collectFindings} needs to judge a certificate. */
interface FindingInputs {
  host: string;
  port: number;
  inspection: TlsInspection;
  coverage: {
    coversApex: boolean;
    coversWww: boolean;
    coversRequestedHost: boolean;
    wwwResolves: boolean;
  };
  daysUntilExpiry: number | null;
  severity: ReturnType<typeof expirySeverity>;
  apex: string;
  www: string;
}

/**
 * Judges a certificate.
 *
 * @param inputs Everything the handshake and DNS established.
 * @returns Findings in the order they were detected. The caller orders them.
 * @throws Never.
 */
function collectFindings(inputs: FindingInputs): Finding[] {
  const findings: Finding[] = [];
  const { inspection, coverage, daysUntilExpiry, severity } = inputs;

  if (daysUntilExpiry === null) {
    // Not `ok`: the check failed to establish the date, which is not the same
    // as establishing that the date is fine. Left as `ok` it would read in a
    // portfolio report as a certificate with nothing wrong with it.
    findings.push(
      finding(
        'cert_dates_unavailable',
        'unknown',
        `The certificate served by ${inputs.host} has no readable expiry date.`,
      ),
    );
  } else if (severity !== 'ok') {
    findings.push(
      daysUntilExpiry < 0
        ? finding(
            'cert_expired',
            'critical',
            `The certificate expired ${String(Math.abs(daysUntilExpiry))} days ago.`,
          )
        : finding(
            'cert_expires_soon',
            severity,
            `The certificate expires in ${String(daysUntilExpiry)} days.`,
          ),
    );
  }

  // A hostname mismatch also makes Node report the chain as unverified, but
  // `host_not_covered` below says the same thing more precisely. Reporting both
  // would describe one problem as two.
  const mismatchOnly = inspection.chain.error === 'ERR_TLS_CERT_ALTNAME_INVALID';
  if (!inspection.chain.valid && !mismatchOnly) {
    findings.push(
      finding(
        'chain_invalid',
        'critical',
        `The certificate chain does not verify: ${inspection.chain.error ?? 'unknown reason'}.`,
      ),
    );
  }

  if (!coverage.coversRequestedHost) {
    findings.push(
      finding(
        'host_not_covered',
        'critical',
        `The certificate is not valid for ${inputs.host}; browsers will warn.`,
      ),
    );
  }

  if (coverage.coversApex && !coverage.coversWww && coverage.wwwResolves) {
    findings.push(
      finding(
        'www_not_covered',
        'warning',
        `${inputs.www} resolves but the certificate does not cover it.`,
      ),
    );
  }

  if (!coverage.coversApex && coverage.coversWww) {
    findings.push(
      finding(
        'apex_not_covered',
        'warning',
        `The certificate does not cover ${inputs.apex} itself.`,
      ),
    );
  }

  if (inspection.protocol !== null && !ACCEPTABLE_PROTOCOLS.has(inspection.protocol)) {
    findings.push(
      finding(
        'tls_version_outdated',
        'warning',
        `The connection negotiated ${inspection.protocol}; TLS 1.2 is the oldest version still considered acceptable.`,
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
  host: string;
  port: number;
  expiresAt: string | null;
  daysUntilExpiry: number | null;
  issuer: string | null;
  chain: { valid: boolean; error: string | null };
  coverage: { matchedVia: string | null };
  tls: { protocol: string | null };
  findings: Finding[];
}): string {
  const lines: string[] = [];

  lines.push(
    report.expiresAt === null || report.daysUntilExpiry === null
      ? `${report.host}:${String(report.port)}: no certificate dates available.`
      : `${report.host}:${String(report.port)} certificate expires ${report.expiresAt.slice(0, 10)} ` +
          `(${String(report.daysUntilExpiry)} days).`,
  );

  if (report.issuer !== null) lines.push(`Issued by ${report.issuer}.`);
  lines.push(
    `Chain ${describeChain(report.chain)}. Negotiated ${report.tls.protocol ?? 'unknown'}.`,
  );
  if (report.coverage.matchedVia !== null) {
    lines.push(`Host matched via ${report.coverage.matchedVia}.`);
  }
  lines.push('Revocation is not checked.');

  if (report.findings.length > 0) {
    lines.push('', 'Needs attention:');
    for (const item of report.findings) lines.push(`- [${item.severity}] ${item.message}`);
  }

  return lines.join('\n');
}

/**
 * Describes a chain verdict without blaming the chain for a hostname mismatch.
 *
 * Node reports `authorized: false` for a certificate that is perfectly valid but
 * issued for a different name. Saying "the chain does not verify" there sends
 * someone looking for a missing intermediate that does not exist.
 *
 * @param chain The chain verdict.
 * @returns A phrase to follow the word "Chain".
 * @throws Never.
 */
function describeChain(chain: { valid: boolean; error: string | null }): string {
  if (chain.valid) return 'verifies';
  if (chain.error === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'verifies, but not for this hostname';
  return `does not verify (${chain.error ?? 'unknown'})`;
}
