import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { CERT_EXPIRY_WARNING_DAYS } from '../lib/defaults.js';
import type { RunSnapshot } from '../lib/history.js';
import {
  CHECK_NAMES,
  IMPLEMENTED_CHECKS,
  filterByTags,
  readPortfolio,
  readPortfolioText,
  type CheckName,
  type Site,
} from '../lib/portfolio.js';
import { createDefaultPorts, type Ports } from '../lib/ports.js';
import { findingSchema, severitySchema } from '../lib/schemas.js';
import { finding, sortFindings, worstSeverity } from '../lib/severity.js';
import { fail, guard, succeed } from '../lib/tool-result.js';
import { checkAccessibilityForPortfolio } from './accessibility-audit.js';
import { checkDomainForPortfolio } from './domain-check.js';
import { checkSeoForPortfolio } from './seo-audit.js';
import { checkSslForPortfolio } from './ssl-check.js';
import { checkUptimeForPortfolio } from './uptime-check.js';
import type { CheckOutcome, Finding, Severity } from '../types.js';

/** The portfolio file read when the caller names none. */
const DEFAULT_FILE = 'sites.json';

/**
 * Sites worked on at once.
 *
 * The per-host limiter already paces requests to any one host; this bounds how
 * many sites are in flight, so a portfolio of eighty does not build eighty
 * pending results before the first finishes. Four is deliberately modest: the
 * checks themselves are mostly waiting, and a report that finishes a little
 * later is worth less than a portfolio owner's reputation with their hosts.
 */
const SITE_CONCURRENCY = 4;

const siteInputSchema = z.object({
  name: z.string().describe('Human label used in the report, e.g. "Example Bakery".'),
  url: z
    .string()
    .describe('The address a visitor would use, e.g. "https://www.example.com". Scheme optional.'),
  domain: z
    .string()
    .optional()
    .describe(
      'Registrable domain for registration and DNS checks, e.g. "example.com". Derived from the ' +
        'URL when omitted; set it when the site lives on a subdomain.',
    ),
  checks: z
    .array(z.enum(CHECK_NAMES))
    .optional()
    .describe('Which checks to run for this site. Defaults to domain, ssl and uptime.'),
  expiryWarningDays: z
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe('Warn this many days before the registration expires. Defaults to 30.'),
  maxLinks: z
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe(
      'Internal links the seo check may request for this site, 0 to check none. Defaults to 25. ' +
        'This is what a portfolio run spends its time on: one request per link, paced at half a ' +
        'second per host, so twenty-five links is roughly twelve seconds for that site.',
    ),
  tags: z.array(z.string()).optional().describe('Free-form labels, for filtering a report.'),
  notes: z.string().optional().describe('Context carried through into the report.'),
});

const inputSchema = z.object({
  sites: z
    .array(siteInputSchema)
    .optional()
    .describe(
      'The portfolio, passed inline. Use this for a one-off report over a handful of sites. ' +
        'When omitted, the portfolio is read from the local file instead.',
    ),
  file: z
    .string()
    .optional()
    .describe(
      'Path to a portfolio JSON file, relative to where the server runs. Defaults to ' +
        '"sites.json". Ignored when "sites" is given. The format is documented in ' +
        'sites.example.json; only .json files can be read.',
    ),
  checks: z
    .array(z.enum(CHECK_NAMES))
    .optional()
    .describe(
      'Run exactly these checks for every site, ignoring what the file says. Use it for a quick ' +
        'pass — ["uptime"] answers "is anything down right now?" in a fraction of the time.',
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'Only report on sites carrying at least one of these tags, e.g. ["retainer"]. Matched ' +
        'case-insensitively. Omit to report on the whole portfolio.',
    ),
});

type Input = z.infer<typeof inputSchema>;

const checkResultSchema = z.object({
  check: z.enum(CHECK_NAMES).describe('Which check this was.'),
  ran: z.boolean().describe('False when the check could not run at all.'),
  severity: severitySchema,
  headline: z.string().describe("The check's own one-line summary."),
  error: z
    .string()
    .nullable()
    .describe('Why the check could not run, when it could not. Null otherwise.'),
});

const siteResultSchema = z.object({
  name: z.string().describe('The site as named in the portfolio.'),
  url: z.string().describe('The URL that was checked.'),
  domain: z.string().describe('The registrable domain that was checked.'),
  tags: z.array(z.string()).describe('The tags this site carries in the portfolio file.'),
  notes: z.string().nullable().describe('Whatever the portfolio file said about this site.'),
  severity: severitySchema,
  soonestExpiryDays: z
    .int()
    .nullable()
    .describe(
      'Days until the first thing about this site expires — registration or certificate, ' +
        'whichever is sooner. Null when nothing with a date could be read.',
    ),
  findings: z
    .array(findingSchema.extend({ check: z.enum(CHECK_NAMES) }))
    .describe('Everything found for this site, worst first, each tagged with the check.'),
  checks: z.array(checkResultSchema).describe('One entry per check that was asked for.'),
});

const outputSchema = z.object({
  generatedAt: z.iso.datetime().describe('When the report was produced, ISO 8601 in UTC.'),
  source: z.enum(['inline', 'file']).describe('Where the portfolio came from.'),
  file: z.string().nullable().describe('The file it was read from, when it was read from one.'),
  siteCount: z.int().describe('How many sites the report covers, after any tag filter.'),
  severity: severitySchema,
  summary: z
    .object({
      critical: z.int(),
      warning: z.int(),
      unknown: z.int(),
      info: z.int(),
      ok: z.int(),
    })
    .describe('How many sites landed at each severity.'),
  needsAttention: z
    .array(
      z.object({
        site: z.string(),
        url: z.string(),
        check: z.enum(CHECK_NAMES),
        code: z.string(),
        severity: severitySchema,
        message: z.string(),
      }),
    )
    .describe(
      'Everything worth acting on, worst first. This is the list the report exists to produce.',
    ),
  changes: z
    .object({
      comparedWithPreviousRun: z
        .boolean()
        .describe(
          'False when this server process has not run a report before, in which case nothing ' +
            'can be said about what changed — history is kept in memory only.',
        ),
      previousRunAt: z.iso.datetime().nullable().describe('When the previous run happened.'),
      sitesCompared: z
        .int()
        .describe(
          'How many sites this run could actually be compared against. A site is comparable only ' +
            'when both runs measured the same checks: comparing a quick uptime-only pass with a ' +
            'full run would invent regressions, or hide them.',
        ),
      regressed: z
        .array(z.object({ site: z.string(), from: severitySchema, to: severitySchema }))
        .describe('Sites that got worse since the previous run.'),
      improved: z
        .array(z.object({ site: z.string(), from: severitySchema, to: severitySchema }))
        .describe('Sites that got better.'),
      newFindings: z
        .array(z.object({ site: z.string(), code: z.string() }))
        .describe('Findings that were not present in the previous run.'),
    })
    .describe('What changed since the previous run in this server process.'),
  notes: z
    .array(z.string())
    .describe('Anything the report could not do, said plainly rather than left out.'),
  sites: z.array(siteResultSchema).describe('Every site, most urgent first.'),
});

/**
 * Runs every requested check across a whole portfolio and ranks the results.
 *
 * This is the tool the rest of the project exists to make possible: one call
 * that answers "what needs attention this week?" across every client site,
 * rather than four calls per site and a spreadsheet.
 *
 * @param input The validated tool input.
 * @param ports The I/O boundary.
 * @returns An MCP result. A portfolio that cannot be read is an error; a site
 *   that cannot be checked is a finding.
 * @throws Never.
 */
export async function runPortfolioReport(input: Input, ports: Ports): Promise<CallToolResult> {
  const loaded = await loadSites(input, ports);
  if (!loaded.ok) return fail(loaded.code, loaded.reason);

  const selected = filterByTags(loaded.sites, input.tags ?? []);
  if (selected.length === 0) {
    return fail(
      'not_found',
      input.tags === undefined
        ? 'the portfolio has no sites'
        : `no site in the portfolio carries any of the tags ${input.tags.join(', ')}`,
    );
  }

  const now = ports.now();
  const notes: string[] = [];
  const results = await mapWithConcurrency(selected, SITE_CONCURRENCY, (site) =>
    checkSite(site, input.checks, ports),
  );

  const skipped = countSkippedChecks(selected, input.checks);
  for (const [check, count] of skipped) {
    notes.push(
      `${check} was requested by ${String(count)} site${count === 1 ? '' : 's'} but is not implemented yet, so it was not run.`,
    );
  }

  const ranked = [...results].sort(compareUrgency);
  const changes = compareWithPrevious(ranked, ports);
  ports.history.record(snapshotOf(ranked, now));

  const report = {
    generatedAt: now.toISOString(),
    source: loaded.source,
    file: loaded.file,
    siteCount: ranked.length,
    severity: worstSeverity(ranked.map((site) => finding('site', site.severity, site.name))),
    summary: countSeverities(ranked),
    needsAttention: needsAttentionOf(ranked),
    changes,
    notes,
    sites: ranked,
  };

  return succeed(summarise(report), report);
}

/**
 * Registers the `portfolio_report` tool.
 *
 * @param server The server to register on.
 * @param ports The I/O boundary. Defaults to real network access.
 * @throws Never.
 */
export function registerPortfolioReportTool(
  server: McpServer,
  ports: Ports = createDefaultPorts(),
): void {
  server.registerTool(
    'portfolio_report',
    {
      title: 'Whole portfolio, ranked by urgency',
      description: [
        'Runs the maintenance checks across every site in a portfolio and returns one report',
        'ordered by what needs action first: what is down, what expires soonest, what regressed',
        'since the last run.',
        '',
        'Use it to answer "what needs attention this week?", "is anything down?" or "what do I put',
        'in this quarter\'s report?" across a whole client list. It is the right call whenever the',
        'question is about more than one site — running domain_check, ssl_check and uptime_check',
        'once per site by hand is what this replaces.',
        '',
        'The portfolio comes from the "sites" argument, or from a local JSON file ("sites.json" by',
        'default) whose format is documented in sites.example.json. Pass "checks" to override what',
        'each site asks for — ["uptime"] answers "is anything down right now?" in a fraction of the',
        'time — and "tags" to report on part of the portfolio.',
        '',
        'Do not use it to answer a question about one site: domain_check, ssl_check, uptime_check',
        'and seo_audit answer those directly and in a fraction of the time. It runs checks and',
        'reports; it never changes a site, and it never writes to the portfolio file.',
        '',
        'A site that cannot be checked is reported as a finding, never as a failure of the whole',
        'report. Only a portfolio that cannot be read at all is an error.',
        '',
        'What changed since the previous run is compared in memory, so it is available only while',
        'this server process keeps running, and the report says when it has nothing to compare',
        'against rather than implying nothing changed. Only sites that both runs measured the same',
        'way are compared, so a quick uptime-only pass never invents regressions in the run after it.',
      ].join('\n'),
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    guard((args: Input) => runPortfolioReport(args, ports)),
  );
}

/** A finding, tagged with the check that produced it. */
interface TaggedFinding extends Finding {
  check: CheckName;
}

/** One check's outcome, as reported. */
interface CheckResult {
  check: CheckName;
  ran: boolean;
  severity: Severity;
  headline: string;
  error: string | null;
}

/** One site's whole outcome. */
interface SiteResult {
  name: string;
  url: string;
  domain: string;
  tags: string[];
  notes: string | null;
  severity: Severity;
  soonestExpiryDays: number | null;
  findings: TaggedFinding[];
  checks: CheckResult[];
}

/**
 * Runs the checks one site asks for.
 *
 * The checks run together: they touch different hosts and different protocols,
 * and the per-host limiter is what keeps that polite. A check that fails
 * becomes a finding on the site rather than an exception, because a registry
 * being down is not a reason to lose the other three answers.
 *
 * @param site The site, with its defaults already applied.
 * @param override Checks to run instead of the site's own, when the caller
 *   asked for a specific pass.
 * @param ports The I/O boundary.
 * @returns Everything found for that site.
 * @throws Never.
 */
async function checkSite(
  site: Site,
  override: CheckName[] | undefined,
  ports: Ports,
): Promise<SiteResult> {
  const asked = override ?? site.checks;
  const wanted = asked.filter((check) => IMPLEMENTED_CHECKS.includes(check));
  const unavailable = asked.filter((check) => !IMPLEMENTED_CHECKS.includes(check));

  const outcomes = await Promise.all(
    wanted.map(async (check): Promise<{ check: CheckName; outcome: CheckOutcome }> => ({
      check,
      outcome: await runCheck(check, site, ports),
    })),
  );

  const findings: TaggedFinding[] = [];
  // One entry per check that was asked for, as the schema promises — including
  // the ones that do not exist yet, which would otherwise vanish from the site's
  // own row and leave only a note at the end of the report.
  const checks: CheckResult[] = unavailable.map((check) => ({
    check,
    ran: false,
    severity: 'unknown',
    headline: `The ${check} check is not implemented yet.`,
    error: 'not implemented yet',
  }));
  let soonestExpiryDays: number | null = null;

  for (const { check, outcome } of outcomes) {
    if (!outcome.ok) {
      const message = `The ${check} check could not run: ${outcome.error.message}`;
      findings.push({ check, code: `${check}_check_failed`, severity: 'unknown', message });
      checks.push({
        check,
        ran: false,
        severity: 'unknown',
        headline: message,
        error: outcome.error.message,
      });
      continue;
    }

    const { summary } = outcome;
    for (const item of summary.findings) findings.push({ ...item, check });
    checks.push({
      check,
      ran: true,
      severity: summary.severity,
      headline: summary.headline,
      error: null,
    });

    if (summary.daysUntilExpiry !== null) {
      soonestExpiryDays =
        soonestExpiryDays === null
          ? summary.daysUntilExpiry
          : Math.min(soonestExpiryDays, summary.daysUntilExpiry);
    }
  }

  if (wanted.length === 0) {
    // Nothing ran, so nothing is known. Without this the site reports `ok` and
    // the summary counts it among the ones with nothing to do — a portfolio
    // could read as entirely healthy having checked nothing at all.
    findings.push({
      check: asked[0] ?? 'domain',
      code: 'no_checks_ran',
      severity: 'unknown',
      message:
        asked.length === 0
          ? 'No checks were requested for this site, so nothing is known about it.'
          : `None of the checks this site asks for can run yet (${asked.join(', ')}), so nothing is known about it.`,
    });
  }

  const ordered = sortFindings(findings);

  return {
    name: site.name,
    url: site.url,
    domain: site.domain,
    tags: site.tags,
    notes: site.notes,
    severity: worstSeverity(findings),
    soonestExpiryDays,
    findings: ordered,
    checks,
  };
}

/**
 * Dispatches one check for one site.
 *
 * The switch is exhaustive and has no default: a sixth check added to
 * `CheckName` fails to compile here until it is dispatched, which is a better
 * reminder than a branch returning "not implemented yet" at runtime.
 *
 * @param check Which check to run.
 * @param site The site.
 * @param ports The I/O boundary.
 * @returns The outcome.
 * @throws Never.
 */
async function runCheck(check: CheckName, site: Site, ports: Ports): Promise<CheckOutcome> {
  switch (check) {
    case 'domain':
      return checkDomainForPortfolio(site.domain, ports, site.expiryWarningDays);
    case 'ssl':
      // The site's own window is for its registration; a certificate keeps the
      // shorter one unless the site asks for something shorter still, because
      // an ACME renewal at 30 days out is a healthy site, not a warning.
      return checkSslForPortfolio(
        new URL(site.url).hostname,
        ports,
        Math.min(site.expiryWarningDays, CERT_EXPIRY_WARNING_DAYS),
      );
    case 'uptime':
      return checkUptimeForPortfolio(site.url, ports);
    case 'seo':
      return checkSeoForPortfolio(site.url, ports, site.maxLinks);
    case 'accessibility':
      // A site that asks for this and runs where no browser is installed gets
      // a check that could not run — reported as `unknown` for that site, never
      // as a clean result.
      return checkAccessibilityForPortfolio(site.url, ports);
  }
}

/**
 * Loads the portfolio from wherever the caller pointed.
 *
 * @param input The tool input.
 * @param ports The I/O boundary.
 * @returns The sites and where they came from, or why they could not be read.
 * @throws Never.
 */
async function loadSites(
  input: Input,
  ports: Ports,
): Promise<
  | { ok: true; sites: Site[]; source: 'inline' | 'file'; file: string | null }
  | { ok: false; code: 'invalid_input' | 'not_found'; reason: string }
> {
  if (input.sites !== undefined) {
    const parsed = readPortfolio({ version: 1, sites: input.sites });
    return parsed.ok
      ? { ok: true, sites: parsed.sites, source: 'inline', file: null }
      : { ok: false, code: 'invalid_input', reason: parsed.reason };
  }

  const file = input.file ?? DEFAULT_FILE;
  let text: string;
  try {
    text = await ports.files.readText(file);
  } catch (cause) {
    return {
      ok: false,
      code: 'not_found',
      reason: `${cause instanceof Error ? cause.message : String(cause)}. Pass "sites" inline, or copy sites.example.json to ${DEFAULT_FILE}.`,
    };
  }

  const parsed = readPortfolioText(text);
  return parsed.ok
    ? { ok: true, sites: parsed.sites, source: 'file', file }
    : { ok: false, code: 'invalid_input', reason: `${file}: ${parsed.reason}` };
}

/**
 * Counts checks that were asked for but do not exist yet.
 *
 * @param sites The portfolio.
 * @param override The caller's check override, when there was one.
 * @returns Each unimplemented check and how many sites wanted it.
 * @throws Never.
 */
function countSkippedChecks(
  sites: readonly Site[],
  override: CheckName[] | undefined,
): Map<CheckName, number> {
  const counts = new Map<CheckName, number>();

  for (const site of sites) {
    for (const check of override ?? site.checks) {
      if (IMPLEMENTED_CHECKS.includes(check)) continue;
      counts.set(check, (counts.get(check) ?? 0) + 1);
    }
  }

  return counts;
}

/**
 * Flattens what needs acting on across the portfolio, worst first.
 *
 * The sort is the point. Concatenating each site's findings in site order — the
 * obvious implementation — puts a site's own 20-day warning above the next
 * site's 3-day critical, while both the schema and the tool's description
 * promise "worst first". Sorting is stable, so within one severity the sites
 * keep their urgency ranking and a site's findings keep their own order.
 *
 * @param sites The ranked sites.
 * @returns Every critical and warning finding, worst first.
 * @throws Never.
 */
function needsAttentionOf(sites: readonly SiteResult[]): {
  site: string;
  url: string;
  check: CheckName;
  code: string;
  severity: Severity;
  message: string;
}[] {
  return sites
    .flatMap((site) =>
      site.findings
        .filter((item) => item.severity === 'critical' || item.severity === 'warning')
        .map((item) => ({
          site: site.name,
          url: site.url,
          check: item.check,
          code: item.code,
          severity: item.severity,
          message: item.message,
        })),
    )
    .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
}

/** Ranking used to order sites and severities. */
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  unknown: 2,
  info: 3,
  ok: 4,
};

/**
 * Orders sites by how much attention they need.
 *
 * Severity first, then the soonest expiry, then the name — so that two sites
 * with nothing wrong still come out in a stable order, and a report run twice
 * reads the same way twice.
 *
 * @param left One site.
 * @param right The other.
 * @returns A comparator result.
 * @throws Never.
 */
function compareUrgency(left: SiteResult, right: SiteResult): number {
  const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  if (bySeverity !== 0) return bySeverity;

  const leftDays = left.soonestExpiryDays ?? Number.POSITIVE_INFINITY;
  const rightDays = right.soonestExpiryDays ?? Number.POSITIVE_INFINITY;
  if (leftDays !== rightDays) return leftDays - rightDays;

  return left.name.localeCompare(right.name);
}

/**
 * @param sites The results.
 * @returns How many sites landed at each severity.
 * @throws Never.
 */
function countSeverities(sites: readonly SiteResult[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, warning: 0, unknown: 0, info: 0, ok: 0 };
  for (const site of sites) counts[site.severity] += 1;
  return counts;
}

/** What changed since the previous run. */
interface Changes {
  comparedWithPreviousRun: boolean;
  previousRunAt: string | null;
  sitesCompared: number;
  regressed: { site: string; from: Severity; to: Severity }[];
  improved: { site: string; from: Severity; to: Severity }[];
  newFindings: { site: string; code: string }[];
}

/**
 * Compares this run with the previous one.
 *
 * @param sites This run's results.
 * @param ports The I/O boundary, which holds the history.
 * @returns What moved. Everything is empty, and `comparedWithPreviousRun` is
 *   false, when this process has not run a report before — an empty list of
 *   regressions must not be readable as "nothing regressed".
 * @throws Never.
 */
function compareWithPrevious(sites: readonly SiteResult[], ports: Ports): Changes {
  const previous = ports.history.previous();
  if (previous === null) {
    return {
      comparedWithPreviousRun: false,
      previousRunAt: null,
      sitesCompared: 0,
      regressed: [],
      improved: [],
      newFindings: [],
    };
  }

  const regressed: Changes['regressed'] = [];
  const improved: Changes['improved'] = [];
  const newFindings: Changes['newFindings'] = [];
  let sitesCompared = 0;

  for (const site of sites) {
    const before = previous.sites[keyOf(site)];
    if (before === undefined) continue;

    // Only like with like. Two runs of the same site that measured different
    // things are not comparable, and pretending otherwise turns a quick
    // uptime-only pass into a page of invented regressions — or, run the other
    // way round, into "improved: critical → ok" for a certificate that still
    // expires in three days.
    if (!sameChecks(site, before.checks)) continue;
    sitesCompared += 1;

    const movement = SEVERITY_ORDER[site.severity] - SEVERITY_ORDER[before.severity];
    if (movement < 0) regressed.push({ site: site.name, from: before.severity, to: site.severity });
    if (movement > 0) improved.push({ site: site.name, from: before.severity, to: site.severity });

    const known = new Set(before.codes);
    for (const item of site.findings) {
      if (!known.has(item.code)) newFindings.push({ site: site.name, code: item.code });
    }
  }

  return {
    // A previous run this one shares no site with is a previous run that cannot
    // be compared against, whatever its timestamp says.
    comparedWithPreviousRun: sitesCompared > 0,
    previousRunAt: sitesCompared > 0 ? previous.takenAt : null,
    sitesCompared,
    regressed,
    improved,
    newFindings,
  };
}

/**
 * @param site This run's result for a site.
 * @param before The checks the previous run made on it.
 * @returns Whether both runs measured the same things.
 * @throws Never.
 */
function sameChecks(site: SiteResult, before: readonly CheckName[]): boolean {
  const now = new Set(site.checks.map((check) => check.check));
  return now.size === before.length && before.every((check) => now.has(check));
}

/**
 * @param sites This run's results.
 * @param now When the run happened.
 * @returns The snapshot to compare the next run against.
 * @throws Never.
 */
function snapshotOf(sites: readonly SiteResult[], now: Date): RunSnapshot {
  const record: RunSnapshot['sites'] = {};
  for (const site of sites) {
    record[keyOf(site)] = {
      severity: site.severity,
      codes: site.findings.map((item) => item.code),
      checks: site.checks.map((check) => check.check),
    };
  }
  return { takenAt: now.toISOString(), sites: record };
}

/**
 * Identifies a site across runs.
 *
 * The name is part of the key, not just the URL: a portfolio may legitimately
 * list the same URL twice — a staging entry and a live one, or two clients on
 * one shared address — and keying on the URL alone would let one site's history
 * silently overwrite the other's.
 *
 * @param site The site.
 * @returns A stable key.
 * @throws Never.
 */
function keyOf(site: { name: string; url: string }): string {
  return `${site.name}\u0000${site.url}`;
}

/**
 * Renders the human-readable half of the result.
 *
 * Written as the report a person would actually send: the headline count, then
 * what to do this week, then what moved, then the sites with nothing wrong —
 * named, because "everything else is fine" is only reassuring when you can see
 * which sites it covers.
 *
 * @param report The structured report.
 * @returns Text for someone reading a transcript.
 * @throws Never.
 */
function summarise(report: {
  siteCount: number;
  summary: Record<Severity, number>;
  needsAttention: { site: string; severity: Severity; message: string }[];
  changes: Changes;
  notes: string[];
  sites: SiteResult[];
}): string {
  const lines: string[] = [];
  const { summary } = report;

  lines.push(
    `${String(report.siteCount)} sites checked: ${String(summary.critical)} critical, ` +
      `${String(summary.warning)} warning, ${String(summary.unknown)} unknown, ` +
      `${String(summary.ok + summary.info)} fine.`,
  );

  if (report.needsAttention.length > 0) {
    lines.push('', 'Needs action:');
    for (const item of report.needsAttention) {
      lines.push(`- [${item.severity}] ${item.site}: ${item.message}`);
    }
  }

  const changes = report.changes;
  if (!changes.comparedWithPreviousRun) {
    lines.push(
      '',
      'Nothing comparable in this session yet, so no change is reported. A run is comparable only against one that measured the same sites the same way.',
    );
  } else if (changes.regressed.length > 0 || changes.improved.length > 0) {
    lines.push('', `Changed since ${changes.previousRunAt ?? 'the previous run'}:`);
    for (const item of changes.regressed) {
      lines.push(`- ${item.site} got worse: ${item.from} → ${item.to}.`);
    }
    for (const item of changes.improved) {
      lines.push(`- ${item.site} improved: ${item.from} → ${item.to}.`);
    }
  }

  const clear = report.sites.filter((site) => site.severity === 'ok' || site.severity === 'info');
  if (clear.length > 0) {
    lines.push('', `Nothing to do: ${clear.map((site) => site.name).join(', ')}.`);
  }

  for (const note of report.notes) lines.push('', note);

  return lines.join('\n');
}
