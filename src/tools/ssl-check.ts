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
import { buildFailure, fail, guard, headlineOf, succeed } from '../lib/tool-result.js';
import type { CheckOutcome, Finding, RevocationReport } from '../types.js';

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
        .boolean()
        .describe(
          'Whether a signed answer from the issuing authority established the revocation status. ' +
            'False is common and usually harmless: since 2025 the two largest issuers publish no ' +
            'OCSP responder at all. See `revocation` for what was established and why.',
        ),
    })
    .describe('The certificate chain and whether it verified.'),

  revocation: z
    .object({
      checked: z
        .boolean()
        .describe(
          'Whether a signed answer from the issuing authority was obtained and verified. The one ' +
            'field to branch on: `status` can be set while this is false, which means an answer ' +
            'arrived but could not be traced to the authority that issued the certificate.',
        ),
      status: z
        .enum(['good', 'revoked', 'unknown'])
        .nullable()
        .describe(
          'What the responder said. "good" means not revoked; "revoked" means it was withdrawn ' +
            'before its expiry date and browsers that check will refuse the site; "unknown" means ' +
            'the authority does not recognise the serial number. Null when no answer was obtained.',
        ),
      source: z
        .enum(['stapled', 'responder'])
        .nullable()
        .describe(
          'Where the answer came from. "stapled" means the server included it in the handshake, ' +
            'which costs no request at all; "responder" means the issuing authority was asked ' +
            'directly.',
        ),
      responder: z
        .string()
        .nullable()
        .describe(
          'The OCSP responder that was contacted, e.g. "http://ocsp.digicert.com". Set even when ' +
            'the query failed, so a responder that would not answer is distinguishable from a ' +
            'certificate that names none.',
        ),
      signatureVerified: z
        .boolean()
        .describe(
          "Whether the answer's signature verified against the issuing certificate authority. An " +
            'OCSP response travels over plain HTTP by design; the signature, not the transport, ' +
            'is what makes it evidence.',
        ),
      revokedAt: z.iso
        .datetime()
        .nullable()
        .describe('When the certificate was revoked, ISO 8601 UTC. Null unless revoked.'),
      reason: z
        .string()
        .nullable()
        .describe(
          'Why it was revoked, e.g. "keyCompromise", "superseded", "cessationOfOperation". Null ' +
            'when the responder did not state one.',
        ),
      producedAt: z.iso
        .datetime()
        .nullable()
        .describe('When the responder produced this answer, ISO 8601 UTC.'),
      nextUpdate: z.iso
        .datetime()
        .nullable()
        .describe(
          'When a fresher answer will be published, ISO 8601 UTC. Typically about a week out, ' +
            'because responders pre-sign their answers.',
        ),
      unavailableReason: z
        .string()
        .nullable()
        .describe(
          'Why nothing was established, e.g. "the certificate names no OCSP responder, so its ' +
            'issuer distributes revocation by certificate revocation list only". Null when the ' +
            'status was established.',
        ),
    })
    .describe(
      'Whether the certificate has been revoked, and how confidently that was established.',
    ),

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
        .nullable()
        .describe(
          'Whether "www." resolves at all. Missing www coverage only matters when it does. Null ' +
            'when DNS could not be consulted, in which case that coverage was not judged.',
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
 * Gathers everything an SSL check reports.
 *
 * Separate from {@link runSslCheck} so that `portfolio_report` can have the
 * report itself rather than reading it back out of an MCP result.
 *
 * @param input The validated tool input.
 * @param ports The I/O boundary.
 * @param warnDays Days before expiry at which to warn.
 * @returns The report, or why none could be produced. A handshake that cannot
 *   be completed is a genuine failure — there is nothing to report without one.
 * @throws Never.
 */
async function buildReport(
  input: Input,
  ports: Ports,
  warnDays: number = CERT_EXPIRY_WARNING_DAYS,
) {
  const target = parseTarget(input.domain);
  if (!target.ok) return buildFailure('invalid_input', target.reason);

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
      ? buildFailure(error.code, error.message)
      : buildFailure(
          'network',
          `could not complete a TLS handshake with ${target.ascii}:${String(port)}`,
        );
  }

  const inspection = tlsResult.value;
  // After the handshake, never alongside it: an OCSP query identifies the
  // certificate by hashes of its issuer's name and key, so there is nothing to
  // ask until the chain has been served. It never throws — a responder that will
  // not answer leaves a reason in the report rather than failing the check.
  const revocation = await ports.tls.revocation(inspection);
  // `null`, not `false`: a lookup that failed established nothing, and reading
  // it as "www does not resolve" silently switches off the www coverage check.
  const wwwResolves = dnsResult.status === 'fulfilled' ? dnsResult.value.wwwResolves : null;
  const leaf = inspection.chain.leaf;
  const daysUntilExpiry = daysUntil(leaf?.validTo ?? null, now);
  const severity = expirySeverity(daysUntilExpiry, warnDays);

  const coverage = {
    subjectAltName: inspection.subjectAltName,
    coversRequestedHost: (inspection.hostMatches[target.ascii] ?? null) !== null,
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
      revocation,
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
      revocationChecked: revocation.checked,
    },
    revocation,
    coverage,
    tls: { protocol: inspection.protocol, cipher: inspection.cipher, alpn: inspection.alpn },
  };

  return { ok: true as const, report: result };
}

/**
 * Runs an SSL check.
 *
 * @param input The validated tool input.
 * @param ports The I/O boundary.
 * @returns An MCP result.
 * @throws Never.
 */
export async function runSslCheck(input: Input, ports: Ports): Promise<CallToolResult> {
  const outcome = await buildReport(input, ports);
  return outcome.ok
    ? succeed(summarise(outcome.report), outcome.report)
    : fail(outcome.error.code, outcome.error.message);
}

/**
 * Runs an SSL check for `portfolio_report`.
 *
 * @param host The host whose certificate to inspect.
 * @param ports The I/O boundary.
 * @param warnDays This site's certificate warning window.
 * @returns The outcome, reduced to what a portfolio aggregates.
 * @throws Never.
 */
export async function checkSslForPortfolio(
  host: string,
  ports: Ports,
  warnDays: number,
): Promise<CheckOutcome> {
  const outcome = await buildReport({ domain: host }, ports, warnDays);
  if (!outcome.ok) return outcome;

  return {
    ok: true,
    summary: {
      severity: outcome.report.severity,
      findings: outcome.report.findings,
      daysUntilExpiry: outcome.report.daysUntilExpiry,
      headline: headlineOf(summarise(outcome.report)),
    },
  };
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
        'than refused. Revocation is checked over OCSP, preferring the response a server staples to',
        'the handshake and otherwise asking the issuing authority directly; the answer is only',
        'believed once its signature verifies against that authority. Many healthy certificates',
        'cannot be checked at all, because since 2025 the two largest issuers publish no OCSP',
        'responder and distribute revocation by CRL instead — that is reported as an unavailable',
        'reason rather than as a problem with the site, and produces no finding. Certificate',
        'revocation lists are not downloaded.',
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
    wwwResolves: boolean | null;
  };
  revocation: RevocationReport;
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

  const revoked = revocationFinding(inputs.revocation);
  if (revoked !== null) findings.push(revoked);

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

  if (coverage.wwwResolves === null && coverage.coversApex && !coverage.coversWww) {
    findings.push(
      finding(
        'www_coverage_unjudged',
        'unknown',
        `The certificate does not cover ${inputs.www}, and DNS could not be consulted to find out whether anything is served there.`,
      ),
    );
  }

  if (coverage.coversApex && !coverage.coversWww && coverage.wwwResolves === true) {
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
 * Judges what was established about revocation.
 *
 * Most certificates in a normal portfolio produce nothing here, and that is the
 * point. Since 2025 the two largest issuers publish no OCSP responder at all, so
 * "revocation could not be checked" is the ordinary state of a perfectly healthy
 * site — grading it would put an unactionable line on nearly every row of a
 * portfolio report and teach the reader to skip the column. A responder that was
 * asked and would not answer is different: something that normally works did
 * not, and that is worth one `unknown`.
 *
 * @param revocation What the check established.
 * @returns A finding, or `null` when there is nothing to act on.
 * @throws Never.
 */
function revocationFinding(revocation: RevocationReport): Finding | null {
  const when = revocation.revokedAt?.slice(0, 10) ?? 'an unstated date';
  const why = revocation.reason === null ? '' : ` (${revocation.reason})`;

  if (revocation.status === 'revoked') {
    // An unverified answer still names a date and a reason, and it is still the
    // only claim anyone has made about this certificate — but it has not been
    // shown to come from the authority that issued it, so it ranks below a fact.
    return revocation.checked
      ? finding(
          'cert_revoked',
          'critical',
          `The certificate was revoked on ${when}${why}; browsers that check revocation will refuse the site.`,
        )
      : finding(
          'cert_revoked_unverified',
          'warning',
          `A responder reports the certificate as revoked on ${when}${why}, but the answer's signature did not verify against the issuing authority, so it is not conclusive.`,
        );
  }

  if (revocation.status === 'unknown' && revocation.checked) {
    return finding(
      'revocation_status_unknown',
      'warning',
      'The issuing authority does not recognise this certificate, which it should: a responder answering "unknown" for a certificate it signed points at a certificate that was never properly issued.',
    );
  }

  if (revocation.status !== null && !revocation.checked) {
    return finding(
      'revocation_answer_unverified',
      'unknown',
      `The revocation answer for this certificate could not be verified: ${revocation.unavailableReason ?? 'its signature did not check out'}.`,
    );
  }

  // Nothing was established, and there was something to establish it from — a
  // responder that was asked, or a staple that was examined and refused. Not
  // knowing is worth surfacing; not having anywhere to ask is not.
  if (revocation.status === null && (revocation.responder !== null || revocation.source !== null)) {
    return finding(
      'revocation_check_failed',
      'unknown',
      `Revocation could not be checked: ${revocation.unavailableReason ?? 'the responder did not answer'}.`,
    );
  }

  return null;
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
  revocation: RevocationReport;
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
  lines.push(describeRevocation(report.revocation));

  if (report.findings.length > 0) {
    lines.push('', 'Needs attention:');
    for (const item of report.findings) lines.push(`- [${item.severity}] ${item.message}`);
  }

  return lines.join('\n');
}

/**
 * Puts the revocation verdict into one sentence.
 *
 * Always says something, including when nothing was established. The previous
 * release of this tool printed a flat "Revocation is not checked." on every
 * result; the difference now is that the line says which of several quite
 * different situations applies, and a reader can act on the difference.
 *
 * @param revocation What the check established.
 * @returns One sentence for a transcript.
 * @throws Never.
 */
function describeRevocation(revocation: RevocationReport): string {
  if (revocation.status === 'revoked') {
    const when = revocation.revokedAt?.slice(0, 10) ?? 'an unstated date';
    const why = revocation.reason === null ? '' : ` (${revocation.reason})`;
    return `Revoked on ${when}${why}.`;
  }

  if (revocation.checked && revocation.status === 'good') {
    return revocation.source === 'stapled'
      ? 'Not revoked, per the response the server stapled to the handshake.'
      : `Not revoked, per ${revocation.responder ?? 'the issuing authority'}.`;
  }

  return `Revocation not established: ${revocation.unavailableReason ?? 'no answer was obtained'}.`;
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
