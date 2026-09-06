import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DOMAIN_EXPIRY_WARNING_DAYS } from '../lib/defaults.js';
import { parseTarget } from '../lib/domain-name.js';
import { SPF_LOOKUP_LIMIT, analyseEmailAuth } from '../lib/email-auth.js';
import { CheckError } from '../lib/errors.js';
import { createDefaultPorts, type Ports } from '../lib/ports.js';
import { findingSchema, severitySchema } from '../lib/schemas.js';
import { expirySeverity, finding, sortFindings, worstSeverity } from '../lib/severity.js';
import { buildFailure, fail, guard, headlineOf, succeed } from '../lib/tool-result.js';
import type {
  CheckOutcome,
  DnsRecords,
  DnssecStatus,
  EmailAuth,
  Finding,
  NameserverAnswer,
  NameserverCheck,
  NameserverOutcome,
  RdapRegistration,
} from '../types.js';

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
  checkNameservers: z
    .boolean()
    .optional()
    .describe(
      "Whether to ask the domain's own nameservers whether they agree about it, which no " +
        'recursive resolver can answer. Costs one DNS query over TCP to each nameserver the ' +
        'domain publishes, in parallel, and finds a server left in the delegation that no longer ' +
        'serves the zone and a zone edited on one server and never transferred to the others. ' +
        'Defaults to true. Set false to skip it — the rest of the check is unaffected. ' +
        'Example: false',
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

  dnsResolved: z
    .boolean()
    .describe(
      'Whether the DNS lookup answered at all. When false every field under "dns" is empty ' +
        'because nothing could be read, not because the domain has no records.',
    ),

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
      dmarcTxt: z
        .array(z.string())
        .describe('TXT records at "_dmarc." plus the domain, where DMARC is published.'),
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

  email: z
    .object({
      spf: z
        .object({
          present: z.boolean().describe('Whether any "v=spf1" record is published.'),
          record: z.string().nullable().describe('The record as published, or null if absent.'),
          recordCount: z
            .int()
            .describe('How many "v=spf1" records exist. More than one makes SPF fail entirely.'),
          all: z
            .enum(['fail', 'softfail', 'neutral', 'pass'])
            .nullable()
            .describe(
              'What the "all" mechanism says about unlisted senders: "fail" is -all, "softfail" ' +
                'is ~all, "neutral" is ?all, "pass" is +all or a bare all. Null when absent.',
            ),
          directLookups: z
            .int()
            .describe(
              'Terms in this record that cost a DNS lookup. A lower bound: it does not follow ' +
                'include: or redirect=, so over the limit proves a broken record and under it ' +
                'proves nothing.',
            ),
        })
        .describe('SPF: which servers may send mail as this domain.'),
      dmarc: z
        .object({
          present: z.boolean().describe('Whether a "v=DMARC1" record is published.'),
          record: z.string().nullable().describe('The record as published, or null if absent.'),
          recordCount: z
            .int()
            .describe('How many "v=DMARC1" records exist. More than one is invalid.'),
          policy: z
            .enum(['none', 'quarantine', 'reject'])
            .nullable()
            .describe(
              'The "p=" tag: "none" monitors only, "quarantine" sends failures to spam, ' +
                '"reject" refuses them. Null when the record names no valid policy.',
            ),
          reportingAddresses: z
            .array(z.string())
            .describe('The "rua=" addresses aggregate reports go to, as published.'),
        })
        .describe('DMARC: what receivers should do when authentication does not line up.'),
    })
    .describe(
      "Email authentication, read from the domain's own TXT records. DKIM is not reported: " +
        'finding a DKIM key needs its selector, which cannot be discovered without guessing.',
    ),

  nameservers: z
    .object({
      checked: z
        .boolean()
        .describe(
          'Whether the nameservers were asked directly. False when the caller passed ' +
            'checkNameservers: false, when the domain publishes no NS records, or when the ' +
            'check could not be started at all.',
        ),
      unavailableReason: z
        .string()
        .nullable()
        .describe(
          'Why they were not asked, or which of them were left out when a domain publishes more ' +
            'than this tool will query. Null when every published nameserver was asked.',
        ),
      answers: z
        .array(
          z.object({
            host: z.string().describe('The nameserver, as the domain publishes it.'),
            address: z
              .string()
              .nullable()
              .describe('The address that was asked, or null when the name resolved to none.'),
            outcome: z
              .enum(['authoritative', 'lame', 'unresolvable', 'unreachable'])
              .describe(
                'What came of asking it. "authoritative" is what should happen. "lame" answered ' +
                  'without authority for the zone, so it is in the delegation and not serving ' +
                  'it. "unresolvable" means its own hostname does not resolve, so no resolver ' +
                  'can reach it either. "unreachable" means it could not be asked over TCP port ' +
                  '53, which says nothing about UDP and is not by itself a fault.',
              ),
            serial: z
              .int()
              .nullable()
              .describe(
                'The zone serial this server holds. This is the version number of the zone, and ' +
                  'it is what makes two nameservers comparable.',
              ),
            problem: z
              .string()
              .nullable()
              .describe('Why it did not answer usefully, in plain words. Null when it did.'),
          }),
        )
        .describe('One entry per nameserver asked, in the order the domain publishes them.'),
      serials: z
        .array(z.int())
        .describe('The distinct serials seen, ascending. More than one means disagreement.'),
      agree: z
        .boolean()
        .describe(
          'Whether every nameserver that answered holds the same version of the zone. True when ' +
            'none answered, because nothing was compared.',
        ),
    })
    .describe(
      "What the domain's own nameservers said when each was asked directly, over TCP port 53 " +
        'with recursion off. This is the only way to see a nameserver left in the delegation ' +
        'after a migration, or a zone edited on one server and never transferred to the others; ' +
        'a recursive resolver answers with whatever one server told it and hides which.',
    ),
});

/**
 * Gathers everything a domain check reports.
 *
 * Registration and DNS are gathered independently and degrade independently: a
 * registry that is down does not hide the DNS records, and a domain that no
 * longer resolves still reports why — which is usually that it expired.
 *
 * Separate from {@link runDomainCheck} so that `portfolio_report` can have the
 * report itself rather than having to read it back out of an MCP result.
 *
 * @param input The validated tool input.
 * @param ports The I/O boundary.
 * @param warnDays Days before expiry at which to warn. Sites carry their own
 *   value in the portfolio file; the default is the project-wide one.
 * @returns The report, or why none could be produced.
 * @throws Never.
 */
async function buildReport(
  input: Input,
  ports: Ports,
  warnDays: number = DOMAIN_EXPIRY_WARNING_DAYS,
) {
  const target = parseTarget(input.domain);
  if (!target.ok) return buildFailure('invalid_input', target.reason);
  if (target.isIp) {
    return buildFailure(
      'invalid_input',
      'an IP address has no domain registration; pass a domain name',
    );
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
      ? buildFailure(error.code, error.message)
      : buildFailure('network', `neither the registry nor DNS could be reached for ${registrable}`);
  }

  const { registration, lookupFailed } = readRegistration(rdapResult, registrable, findings);
  const dnsResolved = dnsResult.status === 'fulfilled';
  const dns = readDns(dnsResult, registrable, findings);
  const dnssec = await readDnssec(rdapResult, registrable, ports);

  const email = analyseEmailAuth(dns.txt, dns.dmarcTxt);
  const nameservers = await readNameservers(input, registrable, dns, ports);

  const registrationSeverity = expirySeverity(registration.daysUntilExpiry, warnDays);
  collectRegistrationFindings(registration, registrationSeverity, lookupFailed, findings);
  if (dnsResolved) {
    collectDnsFindings(dns, findings);
    // Two conditions, not one. The empty records standing in for a failed lookup
    // are indistinguishable from a domain that publishes nothing, so a lookup
    // that never answered must not be read as "no SPF". Neither must a domain
    // that answered and resolves to nothing: telling someone their expired
    // domain also lacks DMARC is true, useless, and in the way of the finding
    // that matters.
    if (resolvesAtAll(dns)) collectEmailFindings(email, findings);
  }
  if (nameservers.checked) collectNameserverFindings(nameservers, findings);
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
    dnsResolved,
    dnssec,
    email,
    nameservers,
  };

  return { ok: true as const, report };
}

/**
 * Runs a domain check.
 *
 * @param input The validated tool input.
 * @param ports The I/O boundary.
 * @returns An MCP result, using `isError` only when nothing at all could be learned.
 * @throws Never.
 */
export async function runDomainCheck(input: Input, ports: Ports): Promise<CallToolResult> {
  const outcome = await buildReport(input, ports);
  return outcome.ok
    ? succeed(summarise(outcome.report), outcome.report)
    : fail(outcome.error.code, outcome.error.message);
}

/**
 * Runs a domain check for `portfolio_report`.
 *
 * @param domain The registrable domain to check.
 * @param ports The I/O boundary.
 * @param warnDays This site's expiry warning window.
 * @returns The outcome, reduced to what a portfolio aggregates.
 * @throws Never.
 */
export async function checkDomainForPortfolio(
  domain: string,
  ports: Ports,
  warnDays: number,
): Promise<CheckOutcome> {
  // The nameservers are not asked here, and that is deliberate on two counts.
  // A portfolio pays this per site — up to eight TCP connections each, on their
  // own deadlines — which is the same argument that keeps `site_crawl` out of a
  // portfolio run. And a deployment whose egress does not allow TCP port 53
  // would report `unknown` for every site at once, which outranks `info` and
  // would reorder a report whose whole job is to say what needs doing first.
  // A domain worth looking at gets `domain_check` called on it directly.
  const outcome = await buildReport({ domain, checkNameservers: false }, ports, warnDays);
  if (!outcome.ok) return outcome;

  return {
    ok: true,
    summary: {
      severity: outcome.report.severity,
      findings: outcome.report.findings,
      daysUntilExpiry: outcome.report.registration.daysUntilExpiry,
      headline: headlineOf(summarise(outcome.report)),
    },
  };
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
        'whether the delegation is signed with DNSSEC, and what its SPF and DMARC records say',
        'about who may send email as it.',
        '',
        'Use it to answer "is this domain about to lapse?", "who do we renew this with?", "where',
        'does this domain point?" or "why does the apex not work when www does?". It is the right',
        'first call when a site has gone dark for no obvious reason.',
        '',
        'Use it too for "why is this client\'s email going to spam?" or "can someone spoof this',
        'domain?" — SPF and DMARC are read from the domain\'s own DNS.',
        '',
        "It also asks each of the domain's own nameservers, directly, whether they agree about",
        'the zone. That answers "why does this site work for some people and not others?" and',
        '"is this old nameserver still in the delegation?" — a question no recursive resolver can',
        'answer, because it replies with whatever one server told it and does not say which.',
        'Pass checkNameservers: false to skip it.',
        '',
        'Do not use it to check whether a website responds — that is uptime_check — or to inspect',
        'an SSL certificate, which is ssl_check. It reads only what registries and DNS publish.',
        'It reports no DKIM: finding a DKIM key needs its selector, and a selector cannot be',
        'discovered without guessing at names, which this project will not do.',
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
    dmarcTxt: [],
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
 * Only ever called when the lookup actually answered. The empty records that
 * stand in for a failed lookup are indistinguishable from a domain that
 * resolves to nothing, and reading them as fact is how a DNS timeout came to be
 * reported as "The domain does not resolve at all" — critical, and beside a
 * warning saying the lookup had failed.
 *
 * @param dns The records.
 * @param findings Collector, appended to in place.
 * @throws Never.
 */
function collectDnsFindings(dns: DnsRecords, findings: Finding[]): void {
  if (!resolvesAtAll(dns)) {
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
 * Asks the zone's own nameservers about it, when there is something to ask.
 *
 * @param input The validated tool input, which may have turned this off.
 * @param registrable The zone, which is what the nameservers are authoritative
 *   for.
 * @param dns The records, whose NS set names who to ask.
 * @param ports The I/O boundary.
 * @returns What each nameserver said, or why none was asked.
 * @throws Never. A nameserver that will not answer is a finding, and so is a
 *   whole check that could not run.
 */
async function readNameservers(
  input: Input,
  registrable: string,
  dns: DnsRecords,
  ports: Ports,
): Promise<NameserverCheck> {
  if (input.checkNameservers === false) {
    return notAsked('the caller asked for the nameservers not to be queried');
  }
  if (dns.ns.length === 0) {
    return notAsked('the domain publishes no NS records, so there was nothing to ask');
  }

  try {
    return await ports.dns.nameservers(registrable, dns.ns);
  } catch (cause) {
    return notAsked(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * @param reason Why nothing was asked, in plain words.
 * @returns A check that did not run.
 * @throws Never.
 */
function notAsked(reason: string): NameserverCheck {
  return { checked: false, unavailableReason: reason, answers: [], serials: [], agree: true };
}

/**
 * Appends findings about what the zone's own nameservers said.
 *
 * The grading turns on one distinction: what is broken for everybody, and what
 * is only unestablished from here. A resolver asks a nameserver over UDP and
 * falls back to TCP; this server can only use TCP, because UDP to arbitrary
 * hosts does not leave every platform it is deployed to. So a nameserver that
 * refuses TCP is not a broken nameserver — sapo.pt's four all refuse it and the
 * domain resolves perfectly — while one whose hostname does not resolve, or
 * that answers without authority for the zone, is broken for every resolver on
 * the internet.
 *
 * **Serials disagreeing is `info`, not a warning.** Two ordinary things produce
 * it. A domain served by two providers that do not transfer between them has
 * two independent serials by design: github.com's NS1 servers report
 * 1656468023 while its Route 53 servers report 1, and nothing is wrong.
 * And a zone edited a minute ago has not reached every server yet: gov.uk's two
 * sets were 301 apart when this was written, and were equal again later. What
 * is left over — a transfer that has been stuck for a week — is real and worth
 * reporting, and it cannot be told from the other two in one snapshot, so this
 * says what it saw and what it means rather than grading a guess.
 *
 * @param check What each nameserver said.
 * @param findings Collector, appended to in place.
 * @throws Never.
 */
function collectNameserverFindings(check: NameserverCheck, findings: Finding[]): void {
  const withOutcome = (outcome: NameserverOutcome): NameserverAnswer[] =>
    check.answers.filter((answer) => answer.outcome === outcome);

  const authoritative = withOutcome('authoritative');
  const unresolvable = withOutcome('unresolvable');
  const lame = withOutcome('lame');
  const unreachable = withOutcome('unreachable');

  if (unresolvable.length > 0) {
    findings.push(
      finding(
        'nameserver_does_not_resolve',
        'warning',
        `${describeHosts(unresolvable)} is listed as a nameserver for this domain and its own ` +
          'hostname does not resolve, so no resolver can reach it. It is almost always a server ' +
          'that was decommissioned and left in the delegation.',
      ),
    );
  }

  if (lame.length > 0) {
    findings.push(
      finding(
        'nameserver_not_authoritative',
        'warning',
        `${String(lame.length)} of the ${String(check.answers.length)} nameservers this domain ` +
          'publishes answered without authority for the zone, which means they are in the ' +
          `delegation but are not serving it: ${describeProblems(lame)}.`,
      ),
    );
  }

  if (authoritative.length === 0 && unreachable.length > 0) {
    findings.push(
      finding(
        'nameservers_not_established',
        'unknown',
        `None of the ${String(check.answers.length)} nameservers could be asked over TCP port 53, ` +
          'so nothing was established about them either way. That is a nameserver serving UDP ' +
          'only, or a network here that does not let DNS out — not evidence of a fault: ' +
          `${describeProblems(unreachable)}.`,
      ),
    );
  } else if (unreachable.length > 0) {
    findings.push(
      finding(
        'nameserver_not_asked',
        'info',
        `${describeHosts(unreachable)} could not be asked over TCP port 53, so it was left out ` +
          'of the comparison. Resolvers use UDP first, so this is not by itself a fault.',
      ),
    );
  }

  if (!check.agree) {
    findings.push(
      finding(
        'nameservers_disagree',
        'info',
        'The nameservers hold different versions of the zone: ' +
          `${describeSerials(authoritative)}. That is normal for a domain served by two providers ` +
          'that do not transfer between them, and normal for a minute after a change; a gap that ' +
          'is still there tomorrow is a transfer that has stopped working.',
      ),
    );
  }
}

/**
 * Names nameservers with what was wrong with each, grouped by what that was.
 *
 * Grouped because the interesting case is four servers failing the same way,
 * and repeating one sentence four times with four addresses in it is how a
 * finding becomes something nobody reads.
 *
 * @param answers Nameservers that had a problem.
 * @returns e.g. `ns1.example.com, ns2.example.com: it refused a connection on
 *   TCP port 53`.
 * @throws Never.
 */
function describeProblems(answers: readonly NameserverAnswer[]): string {
  const byProblem = new Map<string, string[]>();

  for (const answer of answers) {
    const problem = answer.problem ?? 'no answer';
    byProblem.set(problem, [...(byProblem.get(problem) ?? []), answer.host]);
  }

  return [...byProblem].map(([problem, hosts]) => `${hosts.join(', ')}: ${problem}`).join('; ');
}

/**
 * @param answers Some nameservers.
 * @returns Their hostnames, joined.
 * @throws Never.
 */
function describeHosts(answers: readonly NameserverAnswer[]): string {
  return answers.map((answer) => answer.host).join(', ');
}

/**
 * Names which servers hold which version of the zone.
 *
 * Grouped by serial rather than listed per server, because the shape of the
 * answer is the point: four servers on one version and four on another is a
 * domain with two providers, and seven on one and one on another is a server
 * that has fallen behind.
 *
 * @param answers Nameservers that answered with authority.
 * @returns e.g. `1656468023 on dns1.p08.nsone.net, dns2.p08.nsone.net; 1 on
 *   ns-421.awsdns-52.com`.
 * @throws Never.
 */
function describeSerials(answers: readonly NameserverAnswer[]): string {
  const bySerial = new Map<string, string[]>();

  for (const answer of answers) {
    const serial = answer.serial === null ? 'no serial' : String(answer.serial);
    bySerial.set(serial, [...(bySerial.get(serial) ?? []), answer.host]);
  }

  return [...bySerial].map(([serial, hosts]) => `${serial} on ${hosts.join(', ')}`).join('; ');
}

/**
 * Says what the nameservers themselves reported, in a clause.
 *
 * A clause rather than a line of its own: on a healthy domain this is one more
 * fact about a list that is already being printed, and a report that gives
 * every check a line is a report nobody reads to the end.
 *
 * @param check What each nameserver said.
 * @returns A clause to append to the nameserver line, empty when none was asked.
 * @throws Never.
 */
function describeAgreement(check: NameserverCheck): string {
  if (!check.checked) return '';

  const authoritative = check.answers.filter((answer) => answer.outcome === 'authoritative');
  if (authoritative.length === 0) return ' (none of them could be asked directly)';

  const counted = `${String(authoritative.length)} of ${String(check.answers.length)} answered`;
  const [serial] = check.serials;

  // No serial at all is its own sentence. An SOA too short to hold one reads
  // back as `null`, and without this the summary ended on a dangling "serials ".
  if (serial === undefined) return ` (${counted}, none of them with a readable serial)`;

  return check.agree
    ? ` (${counted}, all on serial ${String(serial)})`
    : ` (${counted}, serials ${check.serials.map(String).join(' and ')})`;
}

/**
 * Whether the domain exists in the DNS in any form.
 *
 * Nameservers count even with no address record: a domain delegated but not yet
 * pointed anywhere is a configuration state, not an absence.
 *
 * @param dns The records, from a lookup that actually answered.
 * @returns Whether anything at all is published for this domain.
 * @throws Never.
 */
function resolvesAtAll(dns: DnsRecords): boolean {
  return dns.apexResolves || dns.wwwResolves || dns.ns.length > 0;
}

/**
 * Appends findings about email authentication.
 *
 * The severity split is deliberate and narrower than it first looks. A record
 * that is **absent** is informational: it is a standing improvement, not
 * something that broke this week, and `portfolio_report` ranks a whole
 * portfolio by severity — grading every unconfigured client as a warning would
 * bury the certificate that expires on Friday. A record that is **present and
 * wrong** is a warning, because it fails right now: two SPF records make
 * receivers skip SPF altogether, and `+all` is worse than publishing nothing.
 *
 * @param email The parsed policies.
 * @param findings Collector, appended to in place.
 * @throws Never.
 */
function collectEmailFindings(email: EmailAuth, findings: Finding[]): void {
  const { spf, dmarc } = email;

  if (!spf.present) {
    findings.push(
      finding(
        'spf_not_published',
        'info',
        'There is no SPF record, so nothing states which servers may send email as this domain.',
      ),
    );
  } else {
    if (spf.recordCount > 1) {
      findings.push(
        finding(
          'spf_multiple_records',
          'warning',
          `There are ${String(spf.recordCount)} SPF records. Receivers treat more than one as an ` +
            'error and skip SPF entirely, so none of them applies.',
        ),
      );
    }
    if (spf.all === 'pass') {
      findings.push(
        finding(
          'spf_allows_any_sender',
          'warning',
          'The SPF record ends in "+all", which authorises every server on the internet to send ' +
            'email as this domain.',
        ),
      );
    }
    if (spf.all === 'neutral' || spf.all === null) {
      findings.push(
        finding(
          'spf_no_policy_for_unlisted',
          'info',
          'The SPF record says nothing about senders it does not list, so each receiver decides ' +
            'for itself.',
        ),
      );
    }
    if (spf.directLookups > SPF_LOOKUP_LIMIT) {
      findings.push(
        finding(
          'spf_too_many_lookups',
          'warning',
          `The SPF record needs at least ${String(spf.directLookups)} DNS lookups, above the ` +
            `limit of ${String(SPF_LOOKUP_LIMIT)} receivers enforce, so it fails before it is read.`,
        ),
      );
    }
  }

  if (!dmarc.present) {
    findings.push(
      finding(
        'dmarc_not_published',
        'info',
        'There is no DMARC record, so each receiver decides for itself what to do with email ' +
          'that fails authentication as this domain.',
      ),
    );
    return;
  }

  if (dmarc.recordCount > 1) {
    findings.push(
      finding(
        'dmarc_multiple_records',
        'warning',
        `There are ${String(dmarc.recordCount)} DMARC records. More than one is invalid and ` +
          'receivers ignore all of them.',
      ),
    );
  }
  if (dmarc.policy === null) {
    findings.push(
      finding(
        'dmarc_policy_invalid',
        'warning',
        'The DMARC record names no valid policy, which receivers treat as if it were not ' +
          'published at all.',
      ),
    );
  }
  if (dmarc.policy === 'none') {
    findings.push(
      finding(
        'dmarc_not_enforcing',
        'info',
        'DMARC is set to "none", which watches without asking receivers to act on failures.',
      ),
    );
  }
  if (dmarc.reportingAddresses.length === 0) {
    findings.push(
      finding(
        'dmarc_no_reporting_address',
        'info',
        'DMARC publishes no "rua" address, so no reports arrive to show whether it is working.',
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
  dnsResolved: boolean;
  dnssec: DnssecStatus;
  email: EmailAuth;
  nameservers: NameserverCheck;
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
  if (dns.ns.length > 0) {
    lines.push(`Nameservers: ${dns.ns.join(', ')}${describeAgreement(report.nameservers)}.`);
  }
  lines.push(
    report.dnsResolved
      ? `Resolves: apex ${dns.apexResolves ? 'yes' : 'no'}, www ${dns.wwwResolves ? 'yes' : 'no'}. ` +
          `DNSSEC: ${describeDnssec(dnssec)}.`
      : `Resolves: not established, the DNS lookup failed. DNSSEC: ${describeDnssec(dnssec)}.`,
  );

  if (report.dnsResolved) lines.push(`Email: ${describeEmail(report.email)}.`);

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
 * @param email The parsed policies.
 * @returns A phrase naming what each record says, e.g. "SPF -all, DMARC p=reject".
 * @throws Never.
 */
function describeEmail(email: EmailAuth): string {
  const spf = email.spf.present ? `SPF ${SPF_ALL_NOTATION[email.spf.all ?? 'absent']}` : 'no SPF';
  const dmarc = email.dmarc.present
    ? `DMARC ${email.dmarc.policy === null ? 'invalid' : `p=${email.dmarc.policy}`}`
    : 'no DMARC';
  return `${spf}, ${dmarc}`;
}

/** The notation an SPF record is written in, which is how an administrator will recognise it. */
const SPF_ALL_NOTATION: Record<'fail' | 'softfail' | 'neutral' | 'pass' | 'absent', string> = {
  fail: '-all',
  softfail: '~all',
  neutral: '?all',
  pass: '+all',
  absent: 'with no "all"',
};

/**
 * @param text Any sentence fragment.
 * @returns The same text with its first character upper-cased.
 * @throws Never.
 */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
