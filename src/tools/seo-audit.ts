import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { LIMITS, TIMEOUTS } from '../lib/defaults.js';
import { extractPage, nestsTooDeeply, type PageContent } from '../lib/html.js';
import { createDefaultPorts, type Ports } from '../lib/ports.js';
import {
  isAllowed,
  selectGroup,
  type RobotsAvailability,
  type RobotsFetch,
} from '../lib/robots.js';
import { findingSchema, severitySchema } from '../lib/schemas.js';
import { finding, sortFindings, worstSeverity } from '../lib/severity.js';
import { readSitemap, type SitemapReading } from '../lib/sitemap.js';
import { buildFailure, fail, guard, headlineOf, succeed } from '../lib/tool-result.js';
import { normaliseUrl } from '../lib/url.js';
import { SERVER_NAME } from '../lib/constants.js';
import type { CheckOutcome, Finding, Severity } from '../types.js';

/**
 * Where a title stops being reliably shown in a result listing.
 *
 * Search engines measure pixels, not characters, so no character count is
 * exact. Sixty is the width most title tags start being cut at, and the finding
 * says "may be shortened" rather than claiming it will be.
 */
const TITLE_LENGTH_LIMIT = 60;

/** The same, for a meta description. */
const DESCRIPTION_LENGTH_LIMIT = 160;

const inputSchema = z.object({
  url: z
    .string()
    .describe(
      'The page to audit, e.g. "https://example.com/pricing". A bare domain such as ' +
        '"example.com" is accepted and read over HTTPS. One page is audited, not a whole site, ' +
        'so pass the page you care about; the homepage is the usual choice.',
    ),
  checkLinks: z
    .boolean()
    .optional()
    .describe(
      'Whether to request each internal link to find broken ones. Defaults to true. Set it to ' +
        'false for a fast metadata-only audit: link checking is one request per link and is what ' +
        'makes this tool take seconds rather than milliseconds.',
    ),
  maxLinks: z
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe(
      'How many internal links to check at most. Defaults to 25. Links beyond the limit are ' +
        'counted and reported as unchecked, never silently ignored.',
    ),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  url: z.string().describe('The URL that was requested.'),
  finalUrl: z.string().nullable().describe('Where it ended up after redirects.'),
  checkedAt: z.iso.datetime().describe('When the audit ran, ISO 8601 in UTC.'),
  severity: severitySchema,
  findings: z.array(findingSchema).describe('What needs attention, worst first.'),

  fetched: z
    .boolean()
    .describe('Whether the page was read at all. False when robots.txt forbids it.'),
  status: z.int().nullable().describe('HTTP status of the page.'),
  contentType: z
    .string()
    .nullable()
    .describe('Content type, without parameters, e.g. "text/html".'),
  truncated: z
    .boolean()
    .describe('Whether the document was longer than the read limit and was cut off.'),

  robots: z
    .object({
      url: z.string().describe('The robots.txt that was consulted.'),
      availability: z
        .enum(['fetched', 'absent', 'unreachable'])
        .describe(
          '"absent" means the host publishes no rules, so everything may be crawled. ' +
            '"unreachable" means the file could not be read, which RFC 9309 says to treat as ' +
            'disallowing everything — so nothing is requested.',
        ),
      allowsThisPage: z.boolean().describe('Whether the rules permit requesting this URL.'),
      crawlDelaySeconds: z
        .number()
        .nullable()
        .describe('Any Crawl-delay the host asked for, in seconds.'),
      sitemaps: z.array(z.string()).describe('Sitemap URLs declared in robots.txt.'),
    })
    .describe('What the host publishes about crawling, and what it means for this audit.'),

  page: z
    .object({
      title: z.string().nullable().describe('The <title>, whitespace collapsed.'),
      titleLength: z.int().nullable().describe('Its length in characters.'),
      metaDescription: z.string().nullable().describe('The meta description.'),
      metaDescriptionLength: z.int().nullable().describe('Its length in characters.'),
      metaRobots: z
        .string()
        .nullable()
        .describe('The meta robots directive, lowercased, e.g. "noindex, nofollow".'),
      canonical: z.string().nullable().describe('The canonical URL, resolved to absolute.'),
      lang: z.string().nullable().describe('The lang attribute of <html>, e.g. "pt-PT".'),
      hasViewport: z.boolean().describe('Whether a viewport meta tag is present.'),
      openGraph: z
        .record(z.string(), z.string())
        .describe('Open Graph properties, keyed without the "og:" prefix.'),
      headings: z
        .array(z.object({ level: z.int(), text: z.string() }))
        .describe('Every heading, in document order.'),
      h1Count: z.int().describe('How many <h1> elements the page has.'),
      imagesTotal: z.int().describe('How many images the page has.'),
      imagesMissingAlt: z
        .array(z.string())
        .describe(
          'Images with no alt attribute at all. An image written alt="" is deliberately ' +
            'decorative and is not listed here.',
        ),
      alternates: z
        .array(z.object({ hreflang: z.string(), href: z.string() }))
        .describe('hreflang alternates declared by the page.'),
    })
    .describe('What the document itself says.'),

  links: z
    .object({
      internalTotal: z.int().describe('Distinct internal links found on the page.'),
      externalTotal: z.int().describe('Distinct external links found on the page.'),
      checked: z.int().describe('How many internal links were actually requested.'),
      skippedByRobots: z
        .int()
        .describe('Internal links this crawler is not allowed to request, so it did not.'),
      unchecked: z.int().describe('Internal links left unrequested because of the limit.'),
      broken: z
        .array(z.object({ url: z.string(), status: z.int().nullable(), reason: z.string() }))
        .describe('Links that did not answer with a usable status.'),
    })
    .describe(
      'Internal link health. Only internal links are requested; external ones are counted.',
    ),

  sitemap: z
    .object({
      url: z.string().nullable().describe('The sitemap that was checked.'),
      found: z.boolean().describe('Whether it answered with a usable document.'),
      missing: z
        .boolean()
        .describe(
          'True when nothing was served at all. A site with no sitemap has a gap; a site serving ' +
            'a broken one has a defect, and the findings grade them differently.',
        ),
      kind: z
        .enum(['urlset', 'sitemapindex', 'unknown'])
        .describe('Whether it lists pages or other sitemaps.'),
      entryCount: z
        .int()
        .describe(
          'How many <loc> entries it contains — or at least this many, when truncated is true.',
        ),
      truncated: z
        .boolean()
        .describe(
          'Whether the sitemap was longer than the read limit and was cut off, in which case ' +
            'entryCount is a floor rather than a total.',
        ),
      sampleEntries: z.array(z.string()).describe('The first few entries, for recognition.'),
      problem: z.string().nullable().describe('Why it is unusable, in plain words.'),
    })
    .describe('The sitemap declared in robots.txt, or /sitemap.xml when none is declared.'),
});

/** What robots.txt said, as reported. */
interface RobotsSummary {
  url: string;
  availability: RobotsAvailability;
  allowsThisPage: boolean;
  crawlDelaySeconds: number | null;
  sitemaps: string[];
}

/** The whole audit, as reported. */
interface SeoReport {
  url: string;
  finalUrl: string | null;
  checkedAt: string;
  severity: Severity;
  findings: Finding[];
  fetched: boolean;
  status: number | null;
  contentType: string | null;
  truncated: boolean;
  robots: RobotsSummary;
  page: PageReport;
  links: LinkReport;
  sitemap: SitemapReport;
}

/**
 * Gathers everything a technical SEO audit reports.
 *
 * `robots.txt` is read before anything else is requested, and its verdict is
 * obeyed — including for every internal link the audit would otherwise check.
 * That is a project principle, not a courtesy, so a page this crawler may not
 * read produces a report saying exactly that rather than a report built from a
 * request that should never have been made.
 *
 * Separate from {@link runSeoAudit} so that `portfolio_report` can have the
 * report itself rather than reading it back out of an MCP result. It carries
 * its own text, because the report for a page that was never fetched does not
 * read like the report for one that was.
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
  const origin = target.origin;
  const robotsFetch = await ports.robots.forOrigin(origin);
  const group = selectGroup(robotsFetch.robots, SERVER_NAME);
  const mayCrawl =
    robotsFetch.availability !== 'unreachable' &&
    isAllowed(robotsFetch.robots, SERVER_NAME, pathOf(target));

  const robots = {
    url: robotsFetch.url,
    availability: robotsFetch.availability,
    allowsThisPage: mayCrawl,
    crawlDelaySeconds: group?.crawlDelaySeconds ?? null,
    sitemaps: robotsFetch.robots.sitemaps,
  };

  if (!mayCrawl) {
    const [text, report] = blocked(
      target.toString(),
      now,
      robots,
      robotsFetch.availability === 'unreachable',
    );
    return { ok: true as const, report, text };
  }

  const document = await ports.http
    .text(target.toString(), TIMEOUTS.pageMs, LIMITS.maxHtmlBytes)
    .catch((cause: unknown) => cause as Error);

  if (document instanceof Error) {
    return buildFailure('network', document.message);
  }

  const isHtml = document.contentType === null || document.contentType.includes('html');
  // Measured before it is parsed: tree construction costs the square of the
  // nesting depth, and a synchronous parse cannot be interrupted once started.
  const tooDeep = isHtml && nestsTooDeeply(document.body);
  const page = isHtml && !tooDeep ? extractPage(document.body, document.url) : emptyPage();
  const links = await checkLinks(page, document.url, robotsFetch, input, ports);
  const sitemap = await checkSitemap(origin, robotsFetch, ports);

  const findings = sortFindings(
    collectFindings({ document, isHtml, tooDeep, page, links, sitemap, robots }),
  );

  const report: SeoReport = {
    url: target.toString(),
    finalUrl: document.url,
    checkedAt: now.toISOString(),
    severity: worstSeverity(findings),
    findings,
    fetched: true,
    status: document.status,
    contentType: document.contentType,
    truncated: document.truncated,
    robots,
    page: describePage(page),
    links,
    sitemap,
  };

  return { ok: true as const, report, text: summarise(report) };
}

/**
 * Runs a technical SEO audit of one page.
 *
 * @param input The validated tool input.
 * @param ports The I/O boundary.
 * @returns An MCP result. Only an unusable URL or an unreachable page is an
 *   error; everything else is a report with findings.
 * @throws Never.
 */
export async function runSeoAudit(input: Input, ports: Ports): Promise<CallToolResult> {
  const outcome = await buildReport(input, ports);
  return outcome.ok
    ? succeed(outcome.text, outcome.report)
    : fail(outcome.error.code, outcome.error.message);
}

/**
 * Runs an SEO audit for `portfolio_report`.
 *
 * Link checking is left on: broken links are one of the two things a client
 * notices without being told, and a portfolio report that skipped them to save
 * time would be quietly less useful than the tool it aggregates.
 *
 * @param url The page to audit.
 * @param ports The I/O boundary.
 * @returns The outcome, reduced to what a portfolio aggregates. Nothing here
 *   expires, so the day count is always null.
 * @throws Never.
 */
export async function checkSeoForPortfolio(url: string, ports: Ports): Promise<CheckOutcome> {
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
 * Registers the `seo_audit` tool.
 *
 * @param server The server to register on.
 * @param ports The I/O boundary. Defaults to real network access.
 * @throws Never.
 */
export function registerSeoAuditTool(server: McpServer, ports: Ports = createDefaultPorts()): void {
  server.registerTool(
    'seo_audit',
    {
      title: 'Technical SEO of one page',
      description: [
        'Reads one page and reports the technical SEO facts a maintenance retainer is judged on:',
        'title and meta description, heading structure, canonical, Open Graph, hreflang, language,',
        'viewport, images with no alt text, the state of robots.txt and the sitemap, and which',
        'internal links are broken.',
        '',
        'Use it to answer "why is this page not being indexed?", "does this page have the metadata',
        'it needs?" or "are there broken links on the homepage?". It is the check to run before a',
        'quarterly report, and after a site rebuild.',
        '',
        'Do not use it to check whether a site is up, which is uptime_check, or to inspect a',
        'certificate, which is ssl_check. It audits one page: it does not crawl a site, and it',
        'judges only what is in the HTML, never how a page ranks.',
        '',
        'robots.txt is read first and obeyed. A page this crawler is not allowed to read is',
        'reported as such and is not requested — and neither are internal links it forbids. An',
        'unreadable robots.txt is treated as forbidding everything, per RFC 9309.',
        '',
        'Link checking is one HTTP request per link, paced politely, so an audit with links takes',
        'seconds rather than milliseconds; pass checkLinks: false when speed matters more.',
        'Returns findings ordered by urgency, worst first.',
      ].join('\n'),
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    guard((args: Input) => runSeoAudit(args, ports)),
  );
}

/** Internal link health, as reported. */
interface LinkReport {
  internalTotal: number;
  externalTotal: number;
  checked: number;
  skippedByRobots: number;
  unchecked: number;
  broken: { url: string; status: number | null; reason: string }[];
}

/**
 * Requests the page's internal links to find the broken ones.
 *
 * Links are deduplicated first, because a navigation repeated in the header and
 * the footer is one link to verify, not two requests to make. Anything
 * `robots.txt` forbids is counted and left alone.
 *
 * @param page The extracted page.
 * @param baseUrl The URL the page was fetched from, which defines "internal".
 * @param robotsFetch The rules in force for this host.
 * @param input The tool input, for the caller's limits.
 * @param ports The I/O boundary.
 * @returns Counts and the broken links.
 * @throws Never.
 */
async function checkLinks(
  page: PageContent,
  baseUrl: string,
  robotsFetch: RobotsFetch,
  input: Input,
  ports: Ports,
): Promise<LinkReport> {
  const host = new URL(baseUrl).host;
  const unique = [...new Set(page.links.map((link) => link.href))];
  const internal = unique.filter((href) => new URL(href).host === host);
  const externalTotal = unique.length - internal.length;

  const empty: LinkReport = {
    internalTotal: internal.length,
    externalTotal,
    checked: 0,
    skippedByRobots: 0,
    unchecked: internal.length,
    broken: [],
  };

  if (input.checkLinks === false) return empty;

  const allowed = internal.filter((href) =>
    isAllowed(robotsFetch.robots, SERVER_NAME, pathOf(new URL(href))),
  );
  const limit = input.maxLinks ?? LIMITS.maxLinksChecked;
  const toCheck = allowed.slice(0, limit);

  const results = await Promise.all(
    toCheck.map(async (href) => {
      try {
        const hop = await ports.http.hop(href, TIMEOUTS.httpHopMs);
        // A redirect is not a broken link. Where it leads is uptime_check's
        // question, and following it here would multiply the requests.
        return hop.status >= 400
          ? { url: href, status: hop.status, reason: `answered ${String(hop.status)}` }
          : null;
      } catch (cause) {
        return {
          url: href,
          status: null,
          reason: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }),
  );

  return {
    internalTotal: internal.length,
    externalTotal,
    checked: toCheck.length,
    skippedByRobots: internal.length - allowed.length,
    unchecked: allowed.length - toCheck.length,
    broken: results.filter((item) => item !== null),
  };
}

/** A sitemap check, as reported. */
interface SitemapReport extends SitemapReading {
  url: string | null;
  found: boolean;
  /** Whether the document was cut off at the read limit, making entryCount a floor. */
  truncated: boolean;
  /**
   * Whether nothing was served at all, as opposed to something unusable being
   * served. A site with no sitemap has a gap; a site serving a broken one has a
   * defect, and they are not worth the same amount of attention.
   */
  missing: boolean;
}

/**
 * Checks the site's sitemap.
 *
 * The one declared in `robots.txt` wins over the conventional location: a host
 * that names its sitemap has told us where it is, and `/sitemap.xml` may well
 * be a stale copy. Only the first declared sitemap is fetched — an audit of one
 * page should not walk an index of fifty.
 *
 * @param origin The site's origin.
 * @param robotsFetch The rules, which may declare sitemaps.
 * @param ports The I/O boundary.
 * @returns What was found there.
 * @throws Never.
 */
async function checkSitemap(
  origin: string,
  robotsFetch: RobotsFetch,
  ports: Ports,
): Promise<SitemapReport> {
  // A `Sitemap:` line is supposed to carry an absolute URL, and plenty of real
  // files write `/sitemap.xml` instead. Resolving it against the origin turns
  // a common authoring slip into a working check rather than into
  // "no sitemap at /sitemap.xml: Invalid URL", which is both false and useless.
  const url = absoluteOr(robotsFetch.robots.sitemaps[0], new URL('/sitemap.xml', origin), origin);

  const elsewhere = new URL(url).origin !== origin;
  if (elsewhere) {
    // A sitemap on another host is another host's resource, and principle 4
    // does not stop at the site being audited.
    const theirRobots = await ports.robots.forOrigin(new URL(url).origin);
    if (
      theirRobots.availability === 'unreachable' ||
      !isAllowed(theirRobots.robots, SERVER_NAME, pathOf(new URL(url)))
    ) {
      return {
        url,
        found: false,
        missing: false,
        truncated: false,
        kind: 'unknown',
        entryCount: 0,
        sampleEntries: [],
        problem: `the sitemap is on ${new URL(url).host}, whose robots.txt does not allow this crawler to read it`,
      };
    }
  }

  try {
    const response = await ports.http.text(url, TIMEOUTS.supportFileMs, LIMITS.maxSupportFileBytes);

    if (response.status >= 400) {
      return {
        url,
        found: false,
        missing: true,
        truncated: false,
        kind: 'unknown',
        entryCount: 0,
        sampleEntries: [],
        problem: `the sitemap URL answered ${String(response.status)}`,
      };
    }

    const reading = readSitemap(response.body, response.truncated);
    return {
      url,
      found: reading.problem === null,
      missing: false,
      truncated: response.truncated,
      ...reading,
    };
  } catch (cause) {
    return {
      url,
      found: false,
      missing: true,
      truncated: false,
      kind: 'unknown',
      entryCount: 0,
      sampleEntries: [],
      problem: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * @param declared A `Sitemap:` value from robots.txt, absolute or not.
 * @param fallback Where to look when nothing usable was declared.
 * @param base The origin to resolve a relative declaration against.
 * @returns An absolute sitemap URL.
 * @throws Never.
 */
function absoluteOr(declared: string | undefined, fallback: URL, base: string): string {
  if (declared === undefined) return fallback.toString();
  try {
    return new URL(declared, base).toString();
  } catch {
    return fallback.toString();
  }
}

/**
 * Judges what the audit found.
 *
 * @param inputs Everything gathered.
 * @returns Findings in the order they were detected. The caller orders them.
 * @throws Never.
 */
function collectFindings(inputs: {
  document: { status: number; truncated: boolean; contentType: string | null };
  isHtml: boolean;
  tooDeep: boolean;
  page: PageContent;
  links: LinkReport;
  sitemap: SitemapReport;
  robots: RobotsSummary;
}): Finding[] {
  const findings: Finding[] = [];
  const { document, isHtml, tooDeep, page, links, sitemap } = inputs;

  if (document.status >= 400) {
    findings.push(
      finding(
        'page_unavailable',
        'critical',
        `The page answered ${String(document.status)}, so there is nothing for a search engine to index.`,
      ),
    );
    return findings;
  }

  if (!isHtml) {
    findings.push(
      finding(
        'not_html',
        'warning',
        `The URL returned ${document.contentType ?? 'an unknown content type'}, not an HTML page, so there is no markup to audit.`,
      ),
    );
    return findings;
  }

  if (tooDeep) {
    findings.push(
      finding(
        'document_too_deeply_nested',
        'warning',
        'The page nests elements thousands of levels deep, which no browser renders usefully and which this audit refuses to parse. Its markup was not examined.',
      ),
    );
    return findings;
  }

  if (document.truncated) {
    findings.push(
      finding(
        'document_truncated',
        'info',
        'The page is larger than the read limit and was cut off, so anything late in the document may be missing from this audit.',
      ),
    );
  }

  if (page.metaRobots !== null && page.metaRobots.includes('noindex')) {
    findings.push(
      finding(
        'meta_noindex',
        'critical',
        'The page asks search engines not to index it (meta robots noindex). On a live page this is almost always left over from staging.',
      ),
    );
  }

  collectMetadataFindings(page, findings);
  collectHeadingFindings(page, findings);

  const missingAlt = page.images.filter((image) => image.alt === null).length;
  if (missingAlt > 0) {
    findings.push(
      finding(
        'images_missing_alt',
        'warning',
        `${String(missingAlt)} of ${String(page.images.length)} images have no alt attribute. An image that is purely decorative should carry alt="" rather than nothing at all.`,
      ),
    );
  }

  if (links.broken.length > 0) {
    findings.push(
      finding(
        'broken_internal_links',
        'warning',
        `${String(links.broken.length)} internal links do not work: ${links.broken
          .slice(0, 3)
          .map((item) => `${item.url} (${item.reason})`)
          .join(', ')}${links.broken.length > 3 ? ', and others' : ''}.`,
      ),
    );
  }
  if (links.unchecked > 0) {
    findings.push(
      links.checked === 0
        ? finding(
            'links_not_checked',
            'info',
            `Link checking was switched off, so the ${String(links.unchecked)} internal links on this page were not requested.`,
          )
        : finding(
            'links_unchecked',
            'info',
            `${String(links.unchecked)} further internal links were not checked, because this audit stopped at ${String(links.checked)}.`,
          ),
    );
  }

  if (sitemap.missing) {
    findings.push(
      finding(
        'sitemap_missing',
        'info',
        `There is no sitemap at ${sitemap.url ?? 'the expected location'}: ${sitemap.problem ?? 'it was not found'}.`,
      ),
    );
  } else if (!sitemap.found) {
    // Something was served and it is not a sitemap, which is worse than nothing:
    // it will be fetched and discarded by every crawler that trusts the address.
    findings.push(
      finding(
        'sitemap_unusable',
        'warning',
        `The sitemap at ${sitemap.url ?? 'the expected location'} cannot be used: ${sitemap.problem ?? 'unknown reason'}.`,
      ),
    );
  }

  if (sitemap.truncated) {
    findings.push(
      finding(
        'sitemap_truncated',
        'info',
        `The sitemap is larger than the read limit, so it was only read as far as ${String(sitemap.entryCount)} entries.`,
      ),
    );
  }

  if (inputs.robots.availability === 'absent') {
    findings.push(
      finding(
        'robots_txt_absent',
        'info',
        'The site publishes no robots.txt. Nothing is blocked, but the sitemap cannot be declared there either.',
      ),
    );
  }

  return findings;
}

/**
 * Appends findings about the page's metadata.
 *
 * @param page The extracted page.
 * @param findings Collector, appended to in place.
 * @throws Never.
 */
function collectMetadataFindings(page: PageContent, findings: Finding[]): void {
  if (page.title === null) {
    findings.push(
      finding(
        'title_missing',
        'warning',
        'The page has no title, which is what a search result shows first.',
      ),
    );
  } else if (page.title.length > TITLE_LENGTH_LIMIT) {
    findings.push(
      finding(
        'title_long',
        'info',
        `The title is ${String(page.title.length)} characters and may be shortened in a search result.`,
      ),
    );
  }

  if (page.metaDescription === null) {
    findings.push(
      finding(
        'meta_description_missing',
        'warning',
        'The page has no meta description, so search engines will write their own summary of it.',
      ),
    );
  } else if (page.metaDescription.length > DESCRIPTION_LENGTH_LIMIT) {
    findings.push(
      finding(
        'meta_description_long',
        'info',
        `The meta description is ${String(page.metaDescription.length)} characters and will likely be cut short.`,
      ),
    );
  }

  if (page.canonical === null) {
    findings.push(
      finding(
        'canonical_missing',
        'info',
        'The page declares no canonical URL, which is how duplicate addresses for the same page get separated.',
      ),
    );
  }

  if (page.lang === null) {
    findings.push(
      finding('lang_missing', 'info', 'The <html> element declares no lang attribute.'),
    );
  }

  if (!page.hasViewport) {
    findings.push(
      finding(
        'viewport_missing',
        'warning',
        'The page declares no viewport, so it will render at desktop width on a phone.',
      ),
    );
  }

  if (page.openGraph['title'] === undefined || page.openGraph['image'] === undefined) {
    findings.push(
      finding(
        'open_graph_incomplete',
        'info',
        'The page has no og:title or no og:image, so it will share poorly on social networks and in messaging apps.',
      ),
    );
  }
}

/**
 * Appends findings about the heading structure.
 *
 * @param page The extracted page.
 * @param findings Collector, appended to in place.
 * @throws Never.
 */
function collectHeadingFindings(page: PageContent, findings: Finding[]): void {
  const h1Count = page.headings.filter((heading) => heading.level === 1).length;

  if (h1Count === 0) {
    findings.push(finding('h1_missing', 'warning', 'The page has no <h1>.'));
  } else if (h1Count > 1) {
    findings.push(
      finding(
        'h1_multiple',
        'info',
        `The page has ${String(h1Count)} <h1> elements, which makes its main subject ambiguous.`,
      ),
    );
  }

  const skipped = page.headings.find(
    (heading, index) => index > 0 && heading.level - (page.headings[index - 1]?.level ?? 0) > 1,
  );
  if (skipped !== undefined) {
    findings.push(
      finding(
        'heading_level_skipped',
        'info',
        `The heading structure jumps a level at "${skipped.text}", which makes the page harder to navigate with a screen reader.`,
      ),
    );
  }
}

/**
 * Builds the result for a page this crawler is not allowed to read.
 *
 * @param url The page that was asked about.
 * @param now The moment of the check.
 * @param robots What robots.txt said.
 * @param unreachable Whether the rules could not be read at all.
 * @returns Text and structured content for a report with nothing fetched.
 * @throws Never.
 */
function blocked(
  url: string,
  now: Date,
  robots: RobotsSummary,
  unreachable: boolean,
): [string, SeoReport] {
  const reason = unreachable
    ? finding(
        'robots_txt_unreachable',
        'warning',
        `${robots.url} could not be read. RFC 9309 says to treat that as a refusal, so nothing on this host was requested.`,
      )
    : finding(
        'page_disallowed_by_robots',
        'warning',
        `${robots.url} forbids this crawler from requesting this page. On a page meant to be found, that rule is itself the problem.`,
      );

  const report: SeoReport = {
    url,
    finalUrl: null,
    checkedAt: now.toISOString(),
    severity: reason.severity,
    findings: [reason],
    fetched: false,
    status: null,
    contentType: null,
    truncated: false,
    robots,
    page: describePage(emptyPage()),
    links: {
      internalTotal: 0,
      externalTotal: 0,
      checked: 0,
      skippedByRobots: 0,
      unchecked: 0,
      broken: [],
    },
    sitemap: {
      url: null,
      found: false,
      missing: false,
      truncated: false,
      kind: 'unknown' as const,
      entryCount: 0,
      sampleEntries: [],
      problem: 'not checked, because this host was not crawled',
    },
  };

  return [`${url} was not read: ${reason.message}`, report];
}

/**
 * @returns A page with nothing in it, for the cases where none was parsed.
 * @throws Never.
 */
function emptyPage(): PageContent {
  return {
    title: null,
    metaDescription: null,
    metaRobots: null,
    canonical: null,
    lang: null,
    hasViewport: false,
    openGraph: {},
    headings: [],
    images: [],
    links: [],
    alternates: [],
  };
}

/** The extracted page, shaped for the output schema. */
interface PageReport {
  title: string | null;
  titleLength: number | null;
  metaDescription: string | null;
  metaDescriptionLength: number | null;
  metaRobots: string | null;
  canonical: string | null;
  lang: string | null;
  hasViewport: boolean;
  openGraph: Record<string, string>;
  headings: { level: number; text: string }[];
  h1Count: number;
  imagesTotal: number;
  imagesMissingAlt: string[];
  alternates: { hreflang: string; href: string }[];
}

/**
 * Shapes the extracted page for the output schema.
 *
 * @param page The extracted page.
 * @returns The reportable view of it.
 * @throws Never.
 */
function describePage(page: PageContent): PageReport {
  return {
    title: page.title,
    titleLength: page.title?.length ?? null,
    metaDescription: page.metaDescription,
    metaDescriptionLength: page.metaDescription?.length ?? null,
    metaRobots: page.metaRobots,
    canonical: page.canonical,
    lang: page.lang,
    hasViewport: page.hasViewport,
    openGraph: page.openGraph,
    headings: page.headings,
    h1Count: page.headings.filter((heading) => heading.level === 1).length,
    imagesTotal: page.images.length,
    imagesMissingAlt: page.images
      .filter((image) => image.alt === null)
      .map((image) => image.src ?? '(no src)'),
    alternates: page.alternates,
  };
}

/**
 * @param url A URL.
 * @returns Its path and query, which is what `robots.txt` rules match against.
 * @throws Never.
 */
function pathOf(url: URL): string {
  return `${url.pathname}${url.search}`;
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
  status: number | null;
  page: { title: string | null; h1Count: number; imagesMissingAlt: string[] };
  links: LinkReport;
  sitemap: SitemapReport;
  findings: Finding[];
}): string {
  const lines: string[] = [];
  const page = report.page;

  lines.push(
    `${report.finalUrl ?? 'the page'} answered ${String(report.status ?? 0)}. ` +
      `Title: ${page.title === null ? 'none' : `"${page.title}"`}.`,
  );
  lines.push(
    `${String(page.h1Count)} h1, ${String(page.imagesMissingAlt.length)} images without alt, ` +
      `${String(report.links.internalTotal)} internal links (${String(report.links.checked)} checked, ` +
      `${String(report.links.broken.length)} broken).`,
  );
  lines.push(
    report.sitemap.found
      ? `Sitemap: ${String(report.sitemap.entryCount)} entries.`
      : `Sitemap: ${report.sitemap.problem ?? 'not found'}.`,
  );

  if (report.findings.length > 0) {
    lines.push('', 'Needs attention:');
    for (const item of report.findings) lines.push(`- [${item.severity}] ${item.message}`);
  }

  return lines.join('\n');
}
