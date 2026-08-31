import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DOMAIN_EXPIRY_WARNING_DAYS } from '../lib/defaults.js';
import { parseTarget } from '../lib/domain-name.js';
import { CheckError } from '../lib/errors.js';
import { createDefaultPorts, type Ports } from '../lib/ports.js';
import { findingSchema, severitySchema } from '../lib/schemas.js';
import { expirySeverity, finding, sortFindings, worstSeverity } from '../lib/severity.js';
import { fail, guard, succeed } from '../lib/tool-result.js';
import type { DnsRecords, DnssecStatus, Finding, RdapRegistration } from '../types.js';

const inputSchema = z.object({
  domain: z
    .string()
    .describe(
      'The domain to check, e.g. "example.com" — no scheme, no trailing slash. A full URL such as ' +
        '"https://example.com/pricing" is also accepted and reduced to its hostname. ' +
        'Internationalised names ("café.pt") are accepted and converted automatically. ' +
        'Registration is a property of the registrable domain, so "www.shop.example.co.uk" is ' +
        'checked as "example.co.uk".',
    ),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  domain: z.string().describe('The hostname that was checked, in ASCII (punycode) form.'),
  unicodeDomain: z
    .string()
    .nullable()
    .describe('The Unicode form when the domain is internationalised, otherwise null.'),
  registrableDomain: z
    .string()
    .describe('The domain registration was checked against, e.g. "example.co.uk".'),
  checkedAt: z.iso.datetime().describe('When the check ran, ISO 8601 in UTC.'),
  severity: severitySchema,
  findings: z.array(findingSchema).describe('What needs attention, worst first.'),

  registration: z
    .object({
      source: z
        .enum(['rdap', 'unavailable'])
        .describe('"unavailable" when the registry publishes no usable registration data.'),
      rdapServer: z.string().nullable().describe('The RDAP service that answered.'),
      registrar: z
        .string()
        .nullable()
        .describe('Registrar name, or null when redacted for privacy or not published.'),
      ianaRegistrarId: z
        .string()
        .nullable()
        .describe(
          'IANA registrar ID, which identifies the registrar even when the name is redacted.',
        ),
      statuses: z
        .array(z.string())
        .describe('EPP statuses, lowercased, e.g. "client transfer prohibited".'),
      registeredAt: z.iso.datetime().nullable().describe('First registration date, ISO 8601 UTC.'),
      expiresAt: z.iso.datetime().nullable().describe('Expiry date, ISO 8601 UTC.'),
      daysUntilExpiry: z
        .int()
        .nullable()
        .describe(
          'Whole days until expiry, negative if already expired. Floored, so something expiring ' +
            'in a few hours reads as 0.',
        ),
      expirySeverity: severitySchema,
      unavailableReason: z
        .string()
        .nullable()
        .describe(
          'Why there is no expiry date, in plain words, e.g. "the .de registry does not publish ' +
            'expiry dates". Null when there is one.',
        ),
    })
    .describe('What the registry publishes about this registration.'),

  dns: z
    .object({
      apexResolves: z.boolean().describe('Whether the domain itself has an address record.'),
      wwwResolves: z.boolean().describe('Whether "www." plus the domain has an address record.'),
      a: z.array(z.string()).describe('IPv4 addresses.'),
      aaaa: z.array(z.string()).describe('IPv6 addresses.'),
      ns: z.array(z.string()).describe('Nameservers, lowercased and without a trailing dot.'),
      mx: z
        .array(z.object({ exchange: z.string(), priority: z.int() }))
        .describe(
          'Mail exchangers, lowest priority first. An empty exchange is RFC 7505 "null MX".',
        ),
      txt: z.array(z.string()).describe('TXT records, each already joined from its chunks.'),
      caa: z
        .array(
          z.object({
            critical: z.int(),
            issue: z.string().optional(),
            issuewild: z.string().optional(),
            iodef: z.string().optional(),
            contactemail: z.string().optional(),
            contactphone: z.string().optional(),
          }),
        )
        .describe('CAA records. The tag is the property name, e.g. { critical: 0, issue: "..." }.'),
    })
    .describe('DNS records for the registrable domain.'),

  dnssec: z
    .object({
      delegationSigned: z
        .boolean()
        .nullable()
        .describe(
          'Whether the parent zone publishes a DS record. Null when it could not be established.',
        ),
      source: z
        .enum(['rdap', 'doh', 'unknown'])
        .describe('Where the answer came from. No DNSSEC chain is validated by this tool.'),
    })
    .describe('Whether the delegation is signed. This is not a validation of the DNSSEC chain.'),
});

/**
 * Runs a domain check.
 *
 * Registration and DNS are gathered independently and degrade independently: a
 * registry that is down does not hide the DNS records, and a domain that no
 * longer resolves still reports why — which is usually that it expired.
 *
 * @param input The validated tool input.
 * @param ports The I/O boundary.
 * @returns An MCP result, using `isError` only when nothing at all could be learned.
 * @throws Never.
 */
export async function runDomainCheck(input: Input, ports: Ports): Promise<CallToolResult> {
  const target = parseTarget(input.domain);
  if (!target.ok) return fail('invalid_input', target.reason);
  if (target.isIp) {
    return fail('invalid_input', 'an IP address has no domain registration; pass a domain name');
  }

  const registrable = target.registrable ?? target.ascii;
  const now = ports.now();
  const findings: Finding[] = [];

  const [rdapResult, dnsResult] = await Promise.allSettled([
    ports.rdap.lookupDomain(registrable, now),
    ports.dns.resolveRecords(registrable),
  ]);

  if (rdapResult.status === 'rejected' && dnsResult.status === 'rejected') {
    const error = rdapResult.reason as unknown;
    return error instanceof CheckError
      ? fail(error.code, error.message)
      : fail('network', `neither the registry nor DNS could be reached for ${registrable}`);
  }

  const { registration, lookupFailed } = readRegistration(rdapResult, registrable, findings);
  const dns = readDns(dnsResult, registrable, findings);
  const dnssec = await readDnssec(rdapResult, registrable, ports);

  const registrationSeverity = expirySeverity(
    registration.daysUntilExpiry,
    DOMAIN_EXPIRY_WARNING_DAYS,
  );
  collectRegistrationFindings(registration, registrationSeverity, lookupFailed, findings);
  collectDnsFindings(dns, findings);
  if (dnssec.delegationSigned === false) {
    findings.push(
      finding(
        'dnssec_not_enabled',
        'info',
        `${registrable} has no signed delegation (no DS record).`,
      ),
    );
  }

  const report = {
    domain: target.ascii,
    unicodeDomain: target.unicode,
    registrableDomain: registrable,
    checkedAt: now.toISOString(),
    severity: worstSeverity(findings),
    findings: sortFindings(findings),
    registration: { ...registration, expirySeverity: registrationSeverity },
    dns,
    dnssec,
  };

  return succeed(summarise(report), report);
}

/**
 * Registers the `domain_check` tool.
 *
 * @param server The server to register on.
 * @param ports The I/O boundary. Defaults to real network access, constructed
 *   lazily so that importing this module opens nothing.
 * @throws Never.
 */
export function registerDomainCheckTool(
  server: McpServer,
  ports: Ports = createDefaultPorts(),
): void {
  server.registerTool(
    'domain_check',
    {
      title: 'Domain registration and DNS',
      description: [
        'Reports when a domain registration expires, who the registrar is, and how the domain is',
        'configured in DNS — nameservers, address records, mail exchangers, TXT and CAA records,',
        'and whether the delegation is signed with DNSSEC.',
        '',
        'Use it to answer "is this domain about to lapse?", "who do we renew this with?", "where',
        'does this domain point?" or "why does the apex not work when www does?". It is the right',
        'first call when a site has gone dark for no obvious reason.',
        '',
        'Do not use it to check whether a website responds — that is uptime_check — or to inspect',
        'an SSL certificate, which is ssl_check. It reads only what registries and DNS publish.',
        '',
        'Registration data comes from RDAP. Some country registries (.de, .nl, .no, .au, .fi)',
        'publish no expiry date at all; the result says so explicitly rather than reporting a gap',
        'as if it were an unknown. An expiry inside 30 days is reported as a warning and inside',
        'seven days as critical — a manual renewal needs that much lead time. Returns findings',
        'ordered by how much attention they need, worst first.',
      ].join('\n'),
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    guard((args: Input) => runDomainCheck(args, ports)),
  );
}

/**
 * Turns the RDAP outcome into a registration, recording a finding when it failed.
 *
 * @param result The settled RDAP lookup.
 * @param registrable The domain being checked.
 * @param findings Collector, appended to in place.
 * @returns The registration, plus whether the lookup itself failed — which is
 *   what stops the same problem being reported twice.
 * @throws Never.
 */
function readRegistration(
  result: PromiseSettledResult<{ registration: RdapRegistration }>,
  registrable: string,
  findings: Finding[],
): { registration: RdapRegistration; lookupFailed: boolean } {
  if (result.status === 'fulfilled') {
    return { registration: result.value.registration, lookupFailed: false };
  }

  const error = result.reason as unknown;
  const message = error instanceof Error ? error.message : String(error);
  const notRegistered = error instanceof CheckError && error.code === 'not_found';

  findings.push(
    notRegistered
      ? finding('domain_not_registered', 'critical', message)
      : finding(
          'registration_lookup_failed',
          'warning',
          `Could not read registration data for ${registrable}: ${message}`,
        ),
  );

  return {
    registration: {
      source: 'unavailable',
      rdapServer: null,
      registrar: null,
      ianaRegistrarId: null,
      statuses: [],
      registeredAt: null,
      expiresAt: null,
      daysUntilExpiry: null,
      unavailableReason: message,
    },
    lookupFailed: true,
  };
}

/**
 * Turns the DNS outcome into records, recording a finding when it failed.
 *
 * @param result The settled DNS lookup.
 * @param registrable The domain being checked.
 * @param findings Collector, appended to in place.
 * @returns The records, empty if the lookup failed.
 * @throws Never.
 */
function readDns(
  result: PromiseSettledResult<DnsRecords>,
  registrable: string,
  findings: Finding[],
): DnsRecords {
  if (result.status === 'fulfilled') return result.value;

  const error = result.reason as unknown;
  const message = error instanceof Error ? error.message : String(error);
  findings.push(
    finding('dns_lookup_failed', 'warning', `Could not read DNS for ${registrable}: ${message}`),
  );

  return {
    apexResolves: false,
    wwwResolves: false,
    a: [],
    aaaa: [],
    ns: [],
    mx: [],
    txt: [],
    caa: [],
  };
}

/**
 * Establishes DNSSEC delegation, preferring the registry's own view.
 *
 * The registry is the parent zone's operator, so its answer is authoritative and
 * free — it arrived with the registration lookup. Only when it says nothing is a
 * DNS-over-HTTPS query worth making.
 *
 * @param result The settled RDAP lookup.
 * @param registrable The domain being checked.
 * @param ports The I/O boundary.
 * @returns The delegation status and where it came from.
 * @throws Never.
 */
async function readDnssec(
  result: PromiseSettledResult<{ delegationSigned: boolean | null }>,
  registrable: string,
  ports: Ports,
): Promise<DnssecStatus> {
  if (result.status === 'fulfilled' && result.value.delegationSigned !== null) {
    return { delegationSigned: result.value.delegationSigned, source: 'rdap' };
  }
  const viaDoh = await ports.dns.hasDsRecord(registrable);
  return viaDoh === null
    ? { delegationSigned: null, source: 'unknown' }
    : { delegationSigned: viaDoh, source: 'doh' };
}

/**
 * Appends findings about the registration itself.
 *
 * @param registration The registration.
 * @param severity Its expiry severity.
 * @param lookupFailed Whether the lookup itself failed and has already been
 *   reported. A registry that answered but publishes no date is a different
 *   thing from one that could not be reached, and only the first is worth a
 *   note about the missing date.
 * @param findings Collector, appended to in place.
 * @throws Never.
 */
function collectRegistrationFindings(
  registration: RdapRegistration,
  severity: ReturnType<typeof expirySeverity>,
  lookupFailed: boolean,
  findings: Finding[],
): void {
  const days = registration.daysUntilExpiry;
  if (days !== null && severity !== 'ok') {
    findings.push(
      days < 0
        ? finding(
            'domain_expired',
            'critical',
            `The registration expired ${String(Math.abs(days))} days ago.`,
          )
        : finding(
            'domain_expires_soon',
            severity,
            `The registration expires in ${String(days)} days.`,
          ),
    );
  }

  if (
    !lookupFailed &&
    registration.source === 'unavailable' &&
    registration.unavailableReason !== null &&
    days === null
  ) {
    // Only informational: an absent date is a property of the registry, not of
    // the domain, and treating it as a problem would cry wolf on every .de site.
    findings.push(
      finding(
        'registration_expiry_unavailable',
        'info',
        capitalise(registration.unavailableReason),
      ),
    );
  }

  for (const status of registration.statuses) {
    if (status.includes('hold')) {
      findings.push(
        finding('domain_on_hold', 'critical', `The registry has this domain on "${status}".`),
      );
    }
    if (status.includes('pending delete') || status.includes('redemption')) {
      findings.push(
        finding('domain_pending_delete', 'critical', `The registry status is "${status}".`),
      );
    }
  }
}

/**
 * Appends findings about how the domain resolves.
 *
 * @param dns The records.
 * @param findings Collector, appended to in place.
 * @throws Never.
 */
function collectDnsFindings(dns: DnsRecords, findings: Finding[]): void {
  if (!dns.apexResolves && !dns.wwwResolves && dns.ns.length === 0) {
    findings.push(
      finding('domain_does_not_resolve', 'critical', 'The domain does not resolve at all.'),
    );
    return;
  }
  if (!dns.apexResolves && dns.wwwResolves) {
    findings.push(
      finding(
        'apex_does_not_resolve',
        'warning',
        'The domain itself has no address record; only "www." resolves.',
      ),
    );
  }
}

/**
 * Renders the human-readable half of the result.
 *
 * @param report The structured report.
 * @returns Text for someone reading a transcript.
 * @throws Never.
 */
function summarise(report: {
  registrableDomain: string;
  registration: RdapRegistration;
  dns: DnsRecords;
  dnssec: DnssecStatus;
  findings: Finding[];
}): string {
  const lines: string[] = [];
  const { registration, dns, dnssec } = report;

  if (registration.expiresAt !== null && registration.daysUntilExpiry !== null) {
    lines.push(
      `${report.registrableDomain} expires ${registration.expiresAt.slice(0, 10)} ` +
        `(${String(registration.daysUntilExpiry)} days).`,
    );
  } else {
    lines.push(`${report.registrableDomain}: no expiry date available.`);
  }

  if (registration.registrar !== null) lines.push(`Registrar: ${registration.registrar}.`);
  if (dns.ns.length > 0) lines.push(`Nameservers: ${dns.ns.join(', ')}.`);
  lines.push(
    `Resolves: apex ${dns.apexResolves ? 'yes' : 'no'}, www ${dns.wwwResolves ? 'yes' : 'no'}. ` +
      `DNSSEC: ${describeDnssec(dnssec)}.`,
  );

  if (report.findings.length > 0) {
    lines.push('', 'Needs attention:');
    for (const item of report.findings) lines.push(`- [${item.severity}] ${item.message}`);
  }

  return lines.join('\n');
}

/**
 * @param dnssec The delegation status.
 * @returns A phrase that does not overclaim — nothing here validates a chain.
 * @throws Never.
 */
function describeDnssec(dnssec: DnssecStatus): string {
  if (dnssec.delegationSigned === null) return 'not established';
  return dnssec.delegationSigned ? 'delegation signed' : 'not signed';
}

/**
 * @param text Any sentence fragment.
 * @returns The same text with its first character upper-cased.
 * @throws Never.
 */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
