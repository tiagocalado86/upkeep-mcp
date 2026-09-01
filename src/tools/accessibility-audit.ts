import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AxeRun, AxeViolation } from '../lib/axe.js';
import { SERVER_NAME } from '../lib/constants.js';
import { CheckError } from '../lib/errors.js';
import { createDefaultPorts, type Ports } from '../lib/ports.js';
import { isAllowed } from '../lib/robots.js';
import { findingSchema, severitySchema } from '../lib/schemas.js';
import { finding, sortFindings, worstSeverity } from '../lib/severity.js';
import { buildFailure, fail, guard, headlineOf, succeed } from '../lib/tool-result.js';
import { normaliseUrl } from '../lib/url.js';
import type { CheckOutcome, Finding, Severity } from '../types.js';

/**
 * Which axe tags each standard selects.
 *
 * Cumulative on purpose: asking for AA and being told only about the AA-only
 * rules, while the A failures went unmentioned, is not what anyone means.
 */
const STANDARDS = {
  wcag2a: ['wcag2a'],
  wcag2aa: ['wcag2a', 'wcag2aa'],
  wcag21aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  wcag22aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
  'best-practice': ['best-practice'],
} as const satisfies Record<string, readonly string[]>;

/** How axe's own impact ratings map onto this project's severities. */
const IMPACT_SEVERITY: Record<string, Severity> = {
  critical: 'critical',
  serious: 'warning',
  moderate: 'warning',
  minor: 'info',
};

/** Violations reported individually before the rest are summarised. */
const DETAILED_VIOLATIONS = 10;

/** `1 rule` / `3 rules`. Every line here counts something, and a person reads it. */
const count = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

const inputSchema = z.object({
  url: z
    .string()
    .describe(
      'The page to audit, e.g. "https://example.com/contact". A bare domain is accepted and read ' +
        'over HTTPS. One page is audited, not a site.',
    ),
  standard: z
    .enum(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .optional()
    .describe(
      'Which rules to run. Defaults to "wcag2aa", the level most accessibility policies and ' +
        'procurement rules are written against. Each level includes the ones below it. ' +
        '"best-practice" runs axe\'s non-WCAG advice instead, which is useful but is not a legal ' +
        'standard anywhere.',
    ),
});

type Input = z.infer<typeof inputSchema>;

const violationSchema = z.object({
  id: z.string().describe('The axe rule identifier, e.g. "color-contrast".'),
  impact: z
    .enum(['critical', 'serious', 'moderate', 'minor'])
    .nullable()
    .describe("axe's own rating of how much this matters."),
  help: z.string().describe('One line describing what is wrong.'),
  helpUrl: z.string().describe('Where to read about the rule and how to fix it.'),
  tags: z.array(z.string()).describe('Standards the rule belongs to, e.g. "wcag2aa".'),
  nodeCount: z.int().describe('How many elements on the page failed this rule.'),
  selectors: z.array(z.string()).describe('CSS selectors for the first few failing elements.'),
});

const outputSchema = z.object({
  url: z.string().describe('The URL that was requested.'),
  finalUrl: z.string().nullable().describe('Where the browser ended up.'),
  checkedAt: z.iso.datetime().describe('When the audit ran, ISO 8601 in UTC.'),
  severity: severitySchema,
  findings: z.array(findingSchema).describe('What needs attention, worst first.'),

  audited: z
    .boolean()
    .describe('Whether the page was audited at all. False when robots.txt forbids it.'),
  standard: z.string().describe('Which standard was asked for.'),
  pageTitle: z
    .string()
    .nullable()
    .describe('The title as rendered, which markup alone may not show.'),
  violations: z.array(violationSchema).describe('Every rule that failed, worst impact first.'),
  violationCount: z.int().describe('How many rules failed.'),
  affectedElements: z.int().describe('How many elements failed a rule, counting repeats.'),
  passCount: z.int().describe('How many rules passed.'),
  incompleteCount: z
    .int()
    .describe(
      'Rules axe could not decide on its own. These are not passes: they are the ones needing a ' +
        'person, and a page with none is unusual rather than perfect.',
    ),
  axeVersion: z
    .string()
    .nullable()
    .describe('Which axe-core did the judging, so a result can be reproduced.'),
});

/**
 * Gathers everything an accessibility audit reports.
 *
 * @param input The validated tool input.
 * @param ports The I/O boundary.
 * @returns The report and its summary text, or why none could be produced.
 * @throws Never.
 */
async function buildReport(input: Input, ports: Ports) {
  const target = normaliseUrl(input.url);
  if (target === null) return buildFailure('invalid_input', `"${input.url}" is not a usable URL`);

  const now = ports.now();
  const standard = input.standard ?? 'wcag2aa';

  // The same rule as every other page the project reads: robots.txt first, and
  // a browser is still a crawler.
  const robots = await ports.robots.forOrigin(target.origin);
  const mayCrawl =
    robots.availability !== 'unreachable' &&
    isAllowed(robots.robots, SERVER_NAME, `${target.pathname}${target.search}`);

  if (!mayCrawl) {
    const reason = finding(
      robots.availability === 'unreachable'
        ? 'robots_txt_unreachable'
        : 'page_disallowed_by_robots',
      'warning',
      robots.availability === 'unreachable'
        ? `${robots.url} could not be read, and RFC 9309 says to treat that as a refusal, so the page was not opened.`
        : `${robots.url} forbids this crawler from requesting this page, so it was not opened.`,
    );

    return {
      ok: true as const,
      report: emptyReport(target.toString(), now, standard, [reason]),
      text: `${target.toString()} was not audited: ${reason.message}`,
    };
  }

  let run: AxeRun;
  try {
    run = await ports.browser.audit(target.toString(), STANDARDS[standard]);
  } catch (cause) {
    // The category comes from the error, never from reading its message: a
    // timeout, a refused target and a missing browser are three different
    // answers, and re-deriving them from prose means rewording a sentence
    // silently changes what callers are told.
    return cause instanceof CheckError
      ? buildFailure(cause.code, cause.message)
      : buildFailure('network', cause instanceof Error ? cause.message : String(cause));
  }

  const findings = sortFindings(collectFindings(run, standard));
  const report = {
    url: target.toString(),
    finalUrl: run.url,
    checkedAt: now.toISOString(),
    severity: worstSeverity(findings),
    findings,
    audited: true,
    standard,
    pageTitle: run.title,
    violations: [...run.violations].sort(byImpact),
    violationCount: run.violations.length,
    affectedElements: run.violations.reduce((total, violation) => total + violation.nodeCount, 0),
    passCount: run.passCount,
    incompleteCount: run.incompleteCount,
    axeVersion: run.axeVersion,
  };

  return { ok: true as const, report, text: summarise(report) };
}

/**
 * Runs an accessibility audit.
 *
 * @param input The validated tool input.
 * @param ports The I/O boundary.
 * @returns An MCP result.
 * @throws Never.
 */
export async function runAccessibilityAudit(input: Input, ports: Ports): Promise<CallToolResult> {
  const outcome = await buildReport(input, ports);
  return outcome.ok
    ? succeed(outcome.text, outcome.report)
    : fail(outcome.error.code, outcome.error.message);
}

/**
 * Runs an accessibility audit for `portfolio_report`.
 *
 * @param url The page to audit.
 * @param ports The I/O boundary.
 * @returns The outcome. A missing browser surfaces as a check that could not
 *   run, which the portfolio reports as `unknown` for that site rather than as
 *   a clean bill of health.
 * @throws Never.
 */
export async function checkAccessibilityForPortfolio(
  url: string,
  ports: Ports,
): Promise<CheckOutcome> {
  const outcome = await buildReport({ url }, ports);
  if (!outcome.ok) return outcome;

  return {
    ok: true,
    summary: {
      severity: outcome.report.severity,
      findings: outcome.report.findings,
      daysUntilExpiry: null,
      headline: headlineOf(outcome.text),
    },
  };
}

/**
 * Registers the `accessibility_audit` tool.
 *
 * @param server The server to register on.
 * @param ports The I/O boundary. Defaults to real network access.
 * @throws Never.
 */
export function registerAccessibilityAuditTool(
  server: McpServer,
  ports: Ports = createDefaultPorts(),
): void {
  server.registerTool(
    'accessibility_audit',
    {
      title: 'WCAG violations on one page',
      description: [
        'Opens one page in a real browser and runs axe-core over it, reporting the WCAG rules it',
        'fails, how many elements fail each one, and where they are.',
        '',
        'Use it to answer "does this page meet WCAG 2.2 AA?", "what would an accessibility audit',
        'flag?" or "which of these fixes matters most?". It is the check to run before a site goes',
        'live, and when a client asks about accessibility obligations.',
        '',
        'Do not use it for metadata, headings or broken links, which seo_audit reports without a',
        'browser and far faster. It audits one page, not a site, and it renders that page: it is',
        'much slower than every other tool here.',
        '',
        'It needs a browser. Nothing else in this server does, so if none is installed this tool',
        'says so and names the one command that fixes it, while every other check keeps working.',
        '',
        'Automated rules find roughly a third of accessibility problems. A page with no violations',
        'is a page that passed the machine-checkable part, which is not the same as being usable,',
        'and the count of undecided rules is reported for exactly that reason. robots.txt is',
        'obeyed. Returns findings ordered by urgency, worst first.',
      ].join('\n'),
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    guard((args: Input) => runAccessibilityAudit(args, ports)),
  );
}

/**
 * Judges what axe found.
 *
 * @param run The audit.
 * @param standard Which standard was asked for.
 * @returns Findings in the order they were detected. The caller orders them.
 * @throws Never.
 */
function collectFindings(run: AxeRun, standard: string): Finding[] {
  const findings: Finding[] = [];
  const ordered = [...run.violations].sort(byImpact);

  for (const violation of ordered.slice(0, DETAILED_VIOLATIONS)) {
    findings.push(
      finding(
        `a11y_${violation.id.replace(/-/g, '_')}`,
        IMPACT_SEVERITY[violation.impact ?? ''] ?? 'info',
        `${violation.help} (${count(violation.nodeCount, 'element')}, ${violation.id}).`,
      ),
    );
  }

  const remaining = ordered.length - DETAILED_VIOLATIONS;
  if (remaining > 0) {
    findings.push(
      finding(
        'a11y_further_violations',
        'info',
        `${count(remaining, 'further rule')} failed; ${remaining === 1 ? 'it is' : 'they are'} listed in full under "violations".`,
      ),
    );
  }

  if (run.incompleteCount > 0) {
    // `info`, not `unknown`. These are rules axe declines to judge, and saying
    // so matters — but `unknown` in this project means "the check did not
    // establish anything", and `portfolio_report` ranks it above `info` and
    // counts it in its own bucket. Contrast against a background image is
    // incomplete on most real pages, so grading it `unknown` would put every
    // audited site in the column reserved for checks that could not run.
    findings.push(
      finding(
        'a11y_needs_review',
        'info',
        `${count(run.incompleteCount, 'rule')} could not be decided automatically and ${run.incompleteCount === 1 ? 'needs' : 'need'} a person to look.`,
      ),
    );
  }

  if (ordered.length === 0) {
    findings.push(
      finding(
        'a11y_automated_checks_passed',
        'info',
        `No ${standard} rule failed automatically. Automated rules find roughly a third of accessibility problems, so this is a floor rather than a verdict.`,
      ),
    );
  }

  return findings;
}

/**
 * @param left One violation.
 * @param right The other.
 * @returns A comparator putting the worst impact first, then the widest spread.
 * @throws Never.
 */
function byImpact(left: AxeViolation, right: AxeViolation): number {
  const rank = (impact: string | null): number =>
    ['critical', 'serious', 'moderate', 'minor'].indexOf(impact ?? 'minor');
  const byRank = rank(left.impact) - rank(right.impact);
  return byRank === 0 ? right.nodeCount - left.nodeCount : byRank;
}

/**
 * @param url The page that was asked about.
 * @param now When the check ran.
 * @param standard Which standard was asked for.
 * @param findings Why nothing was audited.
 * @returns A report for a page that was never opened.
 * @throws Never.
 */
function emptyReport(
  url: string,
  now: Date,
  standard: string,
  findings: Finding[],
): {
  url: string;
  finalUrl: string | null;
  checkedAt: string;
  severity: Severity;
  findings: Finding[];
  audited: boolean;
  standard: string;
  pageTitle: string | null;
  violations: AxeViolation[];
  violationCount: number;
  affectedElements: number;
  passCount: number;
  incompleteCount: number;
  axeVersion: string | null;
} {
  return {
    url,
    finalUrl: null,
    checkedAt: now.toISOString(),
    severity: worstSeverity(findings),
    findings,
    audited: false,
    standard,
    pageTitle: null,
    violations: [],
    violationCount: 0,
    affectedElements: 0,
    passCount: 0,
    incompleteCount: 0,
    axeVersion: null,
  };
}

/**
 * Renders the human-readable half of the result.
 *
 * @param report The structured report.
 * @returns Text for someone reading a transcript.
 * @throws Never.
 */
function summarise(report: {
  finalUrl: string | null;
  standard: string;
  violationCount: number;
  affectedElements: number;
  passCount: number;
  incompleteCount: number;
  findings: Finding[];
}): string {
  const lines: string[] = [];

  lines.push(
    `${report.finalUrl ?? 'the page'}: ${count(report.violationCount, `${report.standard} rule`)} failed across ` +
      `${count(report.affectedElements, 'element')}, ${String(report.passCount)} passed, ` +
      `${String(report.incompleteCount)} ${report.incompleteCount === 1 ? 'needs' : 'need'} a person.`,
  );

  if (report.findings.length > 0) {
    lines.push('', 'Needs attention:');
    for (const item of report.findings) lines.push(`- [${item.severity}] ${item.message}`);
  }

  return lines.join('\n');
}
