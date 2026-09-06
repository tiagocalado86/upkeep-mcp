import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { SERVER_NAME } from '../lib/constants.js';
import { LIMITS, TIMEOUTS } from '../lib/defaults.js';
import { extractPage, nestsTooDeeply, type PageContent } from '../lib/html.js';
import { createDefaultPorts, type Ports } from '../lib/ports.js';
import { isAllowed, type RobotsFetch } from '../lib/robots.js';
import { findingSchema, severitySchema } from '../lib/schemas.js';
import { finding, sortFindings, worstSeverity } from '../lib/severity.js';
import { buildFailure, fail, failureFrom, guard, succeed } from '../lib/tool-result.js';
import type { Finding } from '../types.js';

/** Pages named in a finding before it starts listing instead of summarising. */
const NAMED_IN_A_FINDING = 5;

const inputSchema = z.object({
  url: z
    .string()
    .describe(
      'The page to start from, e.g. "https://example.com/" — a full URL with scheme. The crawl ' +
        "stays on this URL's origin, so start at the address the site actually serves: " +
        'https://example.com and https://www.example.com are different origins and only one of ' +
        'them will be visited.',
    ),
  maxPages: z
    .int()
    .min(1)
    .max(LIMITS.maxPagesCrawledCeiling)
    .optional()
    .describe(
      `How many pages to fetch. Defaults to ${String(LIMITS.maxPagesCrawled)}, at most ` +
        `${String(LIMITS.maxPagesCrawledCeiling)}. Every page is one request paced at one every ` +
        'half second, so this is the cost: 25 pages is about fifteen seconds, 100 about a ' +
        'minute. Pages found and not visited are counted and reported. Example: 50',
    ),
  maxDepth: z
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe(
      `How many links deep from the starting page to follow. Defaults to ${String(LIMITS.maxCrawlDepth)}. ` +
        '0 fetches only the starting page. Three reaches everything a small business site has; ' +
        'past that the page budget is the real bound anyway. Example: 2',
    ),
});

type Input = z.infer<typeof inputSchema>;

const pageSchema = z.object({
  url: z.string().describe('The page, as it finally answered — after any redirect.'),
  requestedUrl: z
    .string()
    .describe('The URL that was requested, which differs from "url" when it redirected.'),
  status: z.int().describe('HTTP status of the final response.'),
  depth: z.int().describe('How many links from the starting page this was found at. 0 is it.'),
  linkedFrom: z
    .string()
    .nullable()
    .describe('The page it was found on. Null for the starting page.'),
  title: z.string().nullable().describe('The <title>, or null when there is none.'),
  metaDescription: z.string().nullable().describe('The meta description, or null.'),
  h1Count: z.int().describe('How many <h1> elements the page has. One is the healthy answer.'),
  canonical: z.string().nullable().describe('The canonical URL the page declares, resolved.'),
  noindex: z
    .boolean()
    .describe('Whether a robots meta tag asks search engines not to index this page.'),
  isHtml: z.boolean().describe('Whether it was served as HTML and could be read at all.'),
});

const outputSchema = z.object({
  startUrl: z.string().describe('The URL the crawl was asked to start from.'),
  origin: z.string().describe('The origin it stayed on, e.g. "https://example.com".'),
  checkedAt: z.iso.datetime().describe('When the crawl ran, ISO 8601 in UTC.'),
  severity: severitySchema,
  findings: z.array(findingSchema).describe('What needs attention, worst first.'),

  crawl: z
    .object({
      pagesFetched: z.int().describe('How many pages were actually requested and answered.'),
      deepestLevel: z.int().describe('The furthest depth reached from the starting page.'),
      skippedByRobots: z
        .int()
        .describe('URLs found and not requested because robots.txt forbids this crawler.'),
      notVisited: z
        .int()
        .describe(
          'URLs found, allowed, and left unfetched because a budget ran out. Zero means the ' +
            'crawl saw the whole of what it could reach.',
        ),
      stoppedBecause: z
        .enum(['nothing left to visit', 'page budget', 'depth limit', 'deadline'])
        .describe(
          'Why the crawl ended. "nothing left to visit" means it finished; anything else means ' +
            'the site is larger than what was looked at.',
        ),
    })
    .describe('What the crawl covered, and what it did not.'),

  pages: z.array(pageSchema).describe('Every page fetched, in the order they were visited.'),

  broken: z
    .array(
      z.object({
        url: z.string().describe('The URL that did not answer usefully.'),
        status: z.int().describe('The status it answered with, or 0 when nothing did.'),
        reason: z.string().describe('What went wrong, in plain words.'),
        linkedFrom: z.string().nullable().describe('The page linking to it.'),
      }),
    )
    .describe(
      'Internal links that did not answer with a usable status, with the page each was found on ' +
        '— which is the half of a broken link report that makes it fixable.',
    ),

  duplicates: z
    .object({
      titles: z
        .array(z.object({ value: z.string(), urls: z.array(z.string()) }))
        .describe('Titles used by more than one page, with the pages using them.'),
      descriptions: z
        .array(z.object({ value: z.string(), urls: z.array(z.string()) }))
        .describe('Meta descriptions used by more than one page.'),
    })
    .describe(
      'What only a crawl can see. One page cannot tell you that its title is the same as forty ' +
        "others', and that is the commonest reason a site's pages compete with each other in " +
        'search results.',
    ),
});

/** One page, as reported. */
interface CrawledPage {
  url: string;
  requestedUrl: string;
  status: number;
  depth: number;
  linkedFrom: string | null;
  title: string | null;
  metaDescription: string | null;
  h1Count: number;
  canonical: string | null;
  noindex: boolean;
  isHtml: boolean;
}

/** A link that did not answer usefully. */
interface BrokenLink {
  url: string;
  status: number;
  reason: string;
  linkedFrom: string | null;
}

/** A URL waiting to be visited. */
interface Queued {
  url: string;
  depth: number;
  linkedFrom: string | null;
}

/** Why a crawl ended. */
type StopReason = 'nothing left to visit' | 'page budget' | 'depth limit' | 'deadline';

/**
 * Crawls one origin and reports what only a crawl can see.
 *
 * Breadth-first from the starting page, one origin, `robots.txt` obeyed for
 * every URL before it is requested, and three budgets that cannot be exceeded:
 * pages, depth, and a deadline. Reaching any of them stops the crawl and is
 * reported — a report that does not say it looked at a quarter of the site is
 * worse than no report.
 *
 * Separate from `seo_audit` on purpose, and `docs/adr/0010` said so before this
 * existed: a crawl is a different cost, and folding it into a one-page audit
 * would have made that audit quietly expensive for everything that calls it,
 * `portfolio_report` most of all.
 *
 * @param input The validated tool input.
 * @param ports The I/O boundary.
 * @returns The report, or why none could be produced.
 * @throws Never.
 */
async function buildReport(input: Input, ports: Ports) {
  let start: URL;
  try {
    start = new URL(input.url);
  } catch {
    return buildFailure('invalid_input', `"${input.url}" is not a usable URL`);
  }

  if (start.protocol !== 'http:' && start.protocol !== 'https:') {
    return buildFailure('invalid_input', 'the URL must be http or https');
  }

  const origin = start.origin;

  // robots.txt before anything else is requested, exactly as `seo_audit` does,
  // and for the same reason: it is a project principle rather than a courtesy.
  // It is also the first outbound call, so on a public instance it is where the
  // target guard refuses, and that refusal has to keep its category.
  let robots: RobotsFetch;
  try {
    robots = await ports.robots.forOrigin(origin);
  } catch (cause) {
    return failureFrom(cause);
  }

  if (robots.availability === 'unreachable') {
    return buildFailure(
      'invalid_input',
      `${origin}/robots.txt could not be read, and RFC 9309 says an unreadable robots.txt ` +
        'forbids everything, so nothing was crawled',
    );
  }

  const outcome = await crawl(input, start, robots, ports);
  const findings = sortFindings(collectFindings(outcome, origin));

  return {
    ok: true as const,
    report: {
      startUrl: start.toString(),
      origin,
      checkedAt: ports.now().toISOString(),
      severity: worstSeverity(findings),
      findings,
      crawl: {
        pagesFetched: outcome.pages.length,
        deepestLevel: outcome.pages.reduce((deepest, page) => Math.max(deepest, page.depth), 0),
        skippedByRobots: outcome.skippedByRobots,
        notVisited: outcome.notVisited,
        stoppedBecause: outcome.stoppedBecause,
      },
      pages: outcome.pages,
      broken: outcome.broken,
      duplicates: {
        titles: duplicatesOf(outcome.pages, (page) => page.title),
        descriptions: duplicatesOf(outcome.pages, (page) => page.metaDescription),
      },
    },
  };
}

/** Everything one crawl found. */
interface CrawlOutcome {
  pages: CrawledPage[];
  broken: BrokenLink[];
  skippedByRobots: number;
  notVisited: number;
  stoppedBecause: StopReason;
}

/**
 * Walks the site, breadth-first, until a budget stops it.
 *
 * Sequential rather than parallel, and that costs nothing: the per-host limiter
 * already serialises requests to one origin with a half-second gap between
 * them, so concurrency here would buy queueing rather than speed. Sequential
 * also makes the budget exact — a parallel crawl overshoots `maxPages` by
 * however many requests were in flight when the last one landed.
 *
 * @param input The validated tool input.
 * @param start Where to begin.
 * @param robots The origin's rules, already fetched.
 * @param ports The I/O boundary.
 * @returns What was visited, what broke, and what was left.
 * @throws Never.
 */
async function crawl(
  input: Input,
  start: URL,
  robots: RobotsFetch,
  ports: Ports,
): Promise<CrawlOutcome> {
  const maxPages = input.maxPages ?? LIMITS.maxPagesCrawled;
  const maxDepth = input.maxDepth ?? LIMITS.maxCrawlDepth;
  const deadline = Date.now() + TIMEOUTS.crawlMs;

  const pages: CrawledPage[] = [];
  const broken: BrokenLink[] = [];
  const seen = new Set<string>([canonicalise(start)]);
  const queue: Queued[] = [{ url: start.toString(), depth: 0, linkedFrom: null }];

  let skippedByRobots = 0;
  let stoppedBecause: StopReason = 'nothing left to visit';
  // Whether anything was left unqueued because of the depth limit, which is a
  // different sentence from "the page budget ran out" and reads as one.
  let depthLimited = false;

  while (queue.length > 0) {
    if (pages.length >= maxPages) {
      stoppedBecause = 'page budget';
      break;
    }
    if (Date.now() > deadline) {
      stoppedBecause = 'deadline';
      break;
    }

    // Breadth-first: shallow pages first, so a budget that runs out has spent
    // itself on the pages nearest the entry rather than deep in one branch.
    const next = queue.shift();
    if (next === undefined) break;

    const path = pathOf(new URL(next.url));
    if (!isAllowed(robots.robots, SERVER_NAME, path)) {
      skippedByRobots += 1;
      continue;
    }

    const visited = await visit(next, ports);

    if (visited.broken !== null) {
      broken.push(visited.broken);
      continue;
    }
    if (visited.page === null) continue;

    pages.push(visited.page);
    seen.add(canonicalise(new URL(visited.page.url)));

    if (visited.page.depth >= maxDepth) {
      if (visited.links.length > 0) depthLimited = true;
      continue;
    }

    for (const href of visited.links) {
      const key = canonicalise(new URL(href));
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ url: href, depth: visited.page.depth + 1, linkedFrom: visited.page.url });
    }
  }

  return {
    pages,
    broken,
    skippedByRobots,
    notVisited: queue.length,
    stoppedBecause:
      stoppedBecause === 'nothing left to visit' && depthLimited ? 'depth limit' : stoppedBecause,
  };
}

/**
 * Fetches one page and reads what a crawl needs from it.
 *
 * @param queued The URL and where it was found.
 * @param ports The I/O boundary.
 * @returns The page, or the broken link it turned out to be, and the internal
 *   links to follow from it.
 * @throws Never. A page that will not load is a finding, not a failure.
 */
async function visit(
  queued: Queued,
  ports: Ports,
): Promise<{ page: CrawledPage | null; broken: BrokenLink | null; links: string[] }> {
  const document = await ports.http
    .text(queued.url, TIMEOUTS.pageMs, LIMITS.maxHtmlBytes)
    .catch((cause: unknown) => cause as Error);

  if (document instanceof Error) {
    return {
      page: null,
      links: [],
      broken: {
        url: queued.url,
        status: 0,
        reason: document.message,
        linkedFrom: queued.linkedFrom,
      },
    };
  }

  if (document.status >= 400) {
    return {
      page: null,
      links: [],
      broken: {
        url: queued.url,
        status: document.status,
        reason: `it answered ${String(document.status)}`,
        linkedFrom: queued.linkedFrom,
      },
    };
  }

  const isHtml = document.contentType === null || document.contentType.includes('html');
  // Measured before parsing, as everywhere else: tree construction costs the
  // square of the nesting depth and a synchronous parse cannot be interrupted.
  const readable = isHtml && !nestsTooDeeply(document.body);
  const content = readable ? extractPage(document.body, document.url) : null;

  return {
    broken: null,
    page: {
      url: document.url,
      requestedUrl: queued.url,
      status: document.status,
      depth: queued.depth,
      linkedFrom: queued.linkedFrom,
      title: content?.title ?? null,
      metaDescription: content?.metaDescription ?? null,
      h1Count: content?.headings.filter((heading) => heading.level === 1).length ?? 0,
      canonical: content?.canonical ?? null,
      noindex: content !== null && (content.metaRobots ?? '').includes('noindex'),
      isHtml,
    },
    links: content === null ? [] : internalLinks(content, document.url),
  };
}

/**
 * @param content The page's extracted content.
 * @param pageUrl The page it came from, which relative links resolve against.
 * @returns Every link on the same origin, deduplicated, fragments dropped.
 * @throws Never.
 */
function internalLinks(content: PageContent, pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin;
  const found = new Set<string>();

  for (const link of content.links) {
    let url: URL;
    try {
      url = new URL(link.href);
    } catch {
      continue;
    }
    // One origin, deliberately. `example.com` and `www.example.com` are
    // different origins and a crawl that wandered between them would report one
    // site's pages as duplicates of the other's, which is true and useless.
    if (url.origin !== origin) continue;
    url.hash = '';
    found.add(url.toString());
  }

  return [...found];
}

/**
 * The form a URL is remembered in, for deciding whether it has been seen.
 *
 * The fragment is dropped because it never reaches the server, so `/a#top` and
 * `/a` are one request. The query is kept because it routinely is a different
 * page.
 *
 * @param url Any URL.
 * @returns Its key.
 * @throws Never.
 */
function canonicalise(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = '';
  return copy.toString();
}

/**
 * @param url A URL.
 * @returns The path and query, which is what a robots rule matches against.
 * @throws Never.
 */
function pathOf(url: URL): string {
  return `${url.pathname}${url.search}`;
}

/**
 * Groups pages by a value they share.
 *
 * @param pages Every page fetched.
 * @param of Which value to group by.
 * @returns One entry per value used by more than one page, largest group first.
 * @throws Never.
 */
function duplicatesOf(
  pages: readonly CrawledPage[],
  of: (page: CrawledPage) => string | null,
): { value: string; urls: string[] }[] {
  const byValue = new Map<string, string[]>();

  for (const page of pages) {
    const value = of(page);
    // An absent value is not a duplicate of another absent value: forty pages
    // with no title are forty pages with no title, which is its own finding.
    if (value === null || value === '') continue;
    byValue.set(value, [...(byValue.get(value) ?? []), page.url]);
  }

  return [...byValue]
    .filter(([, urls]) => urls.length > 1)
    .map(([value, urls]) => ({ value, urls }))
    .sort((left, right) => right.urls.length - left.urls.length);
}

/**
 * Grades what the crawl found.
 *
 * The findings a crawl can make and a one-page audit cannot are the ones worth
 * having here: pages sharing a title, a link that is broken from a page nobody
 * checked, a `noindex` left on after a rebuild. Everything a single page can be
 * asked about on its own is left to `seo_audit`, so that running both does not
 * produce two copies of the same list.
 *
 * @param outcome What the crawl found.
 * @param origin The origin crawled.
 * @returns Findings, unsorted.
 * @throws Never.
 */
function collectFindings(outcome: CrawlOutcome, origin: string): Finding[] {
  const findings: Finding[] = [];
  const { pages, broken } = outcome;

  if (pages.length === 0) {
    findings.push(
      finding(
        'crawl_found_nothing',
        'warning',
        `Nothing could be crawled at ${origin}: ${
          broken[0]?.reason ?? 'the starting page did not answer with a readable document'
        }.`,
      ),
    );
    return findings;
  }

  if (broken.length > 0) {
    findings.push(
      finding(
        'broken_internal_links',
        'warning',
        `${String(broken.length)} internal ${broken.length === 1 ? 'link is' : 'links are'} ` +
          `broken: ${broken
            .slice(0, NAMED_IN_A_FINDING)
            .map(
              (link) =>
                `${link.url} (${link.reason})${link.linkedFrom === null ? '' : ` linked from ${link.linkedFrom}`}`,
            )
            .join(', ')}${broken.length > NAMED_IN_A_FINDING ? ', and more' : ''}.`,
      ),
    );
  }

  const duplicateTitles = duplicatesOf(pages, (page) => page.title);
  if (duplicateTitles.length > 0) {
    const worst = duplicateTitles[0];
    findings.push(
      finding(
        'duplicate_titles',
        'warning',
        `${String(duplicateTitles.length)} ${duplicateTitles.length === 1 ? 'title is' : 'titles are'} ` +
          'used by more than one page, so those pages compete with each other in search results' +
          `${worst === undefined ? '' : `; the widest is "${worst.value}" on ${String(worst.urls.length)} pages`}.`,
      ),
    );
  }

  const duplicateDescriptions = duplicatesOf(pages, (page) => page.metaDescription);
  if (duplicateDescriptions.length > 0) {
    findings.push(
      finding(
        'duplicate_meta_descriptions',
        'info',
        `${String(duplicateDescriptions.length)} meta ${duplicateDescriptions.length === 1 ? 'description is' : 'descriptions are'} ` +
          'used by more than one page, so search engines will write their own summary for all ' +
          'but one of them.',
      ),
    );
  }

  const untitled = pages.filter((page) => page.isHtml && page.title === null);
  if (untitled.length > 0) {
    findings.push(
      finding(
        'pages_without_a_title',
        'warning',
        `${of(untitled.length, pages.length)} no title: ${listUrls(untitled)}.`,
      ),
    );
  }

  const undescribed = pages.filter((page) => page.isHtml && page.metaDescription === null);
  if (undescribed.length > 0) {
    findings.push(
      finding(
        'pages_without_a_meta_description',
        'info',
        `${of(undescribed.length, pages.length)} no meta description, ` +
          'so search engines will write their own summary of them.',
      ),
    );
  }

  const noindexed = pages.filter((page) => page.noindex);
  if (noindexed.length > 0) {
    findings.push(
      finding(
        'pages_asking_not_to_be_indexed',
        'info',
        `${of(noindexed.length, pages.length, 'asks', 'ask')} search engines not to ` +
          `index them: ${listUrls(noindexed)}. That is deliberate on a thank-you page and a ` +
          'disaster left over from a staging site.',
      ),
    );
  }

  const missingH1 = pages.filter((page) => page.isHtml && page.h1Count === 0);
  if (missingH1.length > 0) {
    findings.push(
      finding(
        'pages_without_an_h1',
        'info',
        `${of(missingH1.length, pages.length)} no h1 heading: ${listUrls(missingH1)}.`,
      ),
    );
  }

  if (outcome.skippedByRobots > 0) {
    findings.push(
      finding(
        'pages_disallowed_by_robots',
        'info',
        `${String(outcome.skippedByRobots)} URLs were found and not requested, because ` +
          'robots.txt forbids this crawler from reading them.',
      ),
    );
  }

  if (outcome.stoppedBecause !== 'nothing left to visit') {
    findings.push(
      finding(
        'crawl_incomplete',
        'info',
        `The crawl stopped at the ${outcome.stoppedBecause} with ${String(outcome.notVisited)} ` +
          'URLs found and not visited, so everything here describes the part of the site that ' +
          'was looked at.',
      ),
    );
  }

  return findings;
}

/**
 * @param pages Some pages.
 * @returns Their URLs, cut off before the list becomes a wall.
 * @throws Never.
 */
function listUrls(pages: readonly CrawledPage[]): string {
  const named = pages.slice(0, NAMED_IN_A_FINDING).map((page) => page.url);
  return pages.length > NAMED_IN_A_FINDING
    ? `${named.join(', ')}, and ${String(pages.length - NAMED_IN_A_FINDING)} more`
    : named.join(', ');
}

/**
 * Runs a crawl.
 *
 * @param input The validated tool input.
 * @param ports The I/O boundary.
 * @returns An MCP result, using `isError` only when nothing could be learned.
 * @throws Never.
 */
export async function runSiteCrawl(input: Input, ports: Ports): Promise<CallToolResult> {
  const outcome = await buildReport(input, ports);
  return outcome.ok
    ? succeed(summarise(outcome.report), outcome.report)
    : fail(outcome.error.code, outcome.error.message);
}

/**
 * Renders the human-readable half of the result.
 *
 * @param report The structured report.
 * @returns Text for someone reading a transcript.
 * @throws Never.
 */
function summarise(report: {
  origin: string;
  crawl: { pagesFetched: number; deepestLevel: number; notVisited: number; stoppedBecause: string };
  broken: BrokenLink[];
  duplicates: { titles: { urls: string[] }[] };
  findings: Finding[];
}): string {
  const lines = [
    `Crawled ${count(report.crawl.pagesFetched, 'page')} of ${report.origin}, ` +
      `${count(report.crawl.deepestLevel, 'level')} deep.`,
    `${count(report.broken.length, 'broken internal link')}, ` +
      `${count(report.duplicates.titles.length, 'title')} used more than once.`,
  ];

  if (report.crawl.stoppedBecause !== 'nothing left to visit') {
    lines.push(
      `Stopped at the ${report.crawl.stoppedBecause}; ${String(report.crawl.notVisited)} URLs were not visited.`,
    );
  }

  if (report.findings.length > 0) {
    lines.push('', 'Needs attention:');
    for (const item of report.findings) lines.push(`- [${item.severity}] ${item.message}`);
  }

  return lines.join('\n');
}

/**
 * Opens a finding with how many pages out of how many, and the right verb.
 *
 * @param some How many pages the finding is about.
 * @param total How many were crawled.
 * @param singular The verb for one page. Defaults to `has`.
 * @param plural The verb for more than one. Defaults to `have`.
 * @returns e.g. `6 pages of 25 have`.
 * @throws Never.
 */
function of(some: number, total: number, singular = 'has', plural = 'have'): string {
  return `${count(some, 'page')} of ${String(total)} ${some === 1 ? singular : plural}`;
}

/**
 * @param quantity How many.
 * @param noun The singular noun.
 * @returns The two together, pluralised — "1 page", "5 pages".
 * @throws Never.
 */
function count(quantity: number, noun: string): string {
  return `${String(quantity)} ${noun}${quantity === 1 ? '' : 's'}`;
}

/**
 * Registers the tool.
 *
 * @param server The server to register on.
 * @param ports The I/O boundary. Defaults to real network access, constructed
 *   lazily so that importing this module opens nothing.
 * @throws Never.
 */
export function registerSiteCrawlTool(
  server: McpServer,
  ports: Ports = createDefaultPorts(),
): void {
  server.registerTool(
    'site_crawl',
    {
      title: 'Technical SEO across a site',
      description: [
        'Walks a site from a starting page and reports what only a crawl can see: pages sharing a',
        'title or a meta description, internal links that are broken and which page links to',
        'them, pages asking not to be indexed, and how much of the site was reachable at all.',
        '',
        'Use it after a site rebuild or a migration, and before a quarterly report — the findings',
        'here are the ones a client never notices and a search engine always does. Use it to',
        'answer "why are these pages competing with each other?", "are there broken links",',
        'anywhere on the site?" or "is anything still marked noindex from staging?".',
        '',
        'Do not use it to audit one page in depth — that is seo_audit, which reports canonical,',
        'Open Graph, hreflang, images without alt text and the sitemap for a single URL. Do not',
        'use it to check whether a site is up (uptime_check) or to inspect a certificate',
        '(ssl_check). It judges only what is in the HTML, never how a page ranks.',
        '',
        'It stays on one origin: https://example.com and https://www.example.com are different',
        'origins and only the one you start from is visited.',
        '',
        'robots.txt is read first and obeyed for every URL before it is requested. An unreadable',
        'robots.txt is treated as forbidding everything, per RFC 9309, and the crawl reports that',
        'rather than proceeding.',
        '',
        'It costs one request per page, paced at one every half second per host, so 25 pages is',
        'about fifteen seconds. Three budgets bound it — pages, depth, and a two-minute deadline —',
        'and whichever one stopped the crawl is reported along with how many URLs were left',
        'unvisited, because a report that does not say it saw a quarter of the site is worse than',
        'no report.',
      ].join('\n'),
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    guard((args: Input) => runSiteCrawl(args, ports)),
  );
}
