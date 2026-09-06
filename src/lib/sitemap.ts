import { promisify } from 'node:util';
import { constants, gunzip } from 'node:zlib';
import { LIMITS } from './defaults.js';
import { parseTarget } from './domain-name.js';

/**
 * Reading an XML sitemap, and checking it against the rules of the protocol.
 *
 * Not an XML parse and not an XSD validation: a scan, against the rules written
 * out at sitemaps.org — the namespace the root has to declare, what a `<url>`
 * must contain, and which values the protocol constrains. Those rules are a
 * short list and they are the ones that decide whether a consumer keeps or
 * drops an entry, which is what a maintenance report is asking about.
 * Everything this cannot establish is reported as unestablished rather than
 * assumed, and what it deliberately does not check is in
 * `docs/adr/0019-sitemap-rules-without-a-schema-validator.md`.
 *
 * @see https://www.sitemaps.org/protocol.html
 */

/** What kind of sitemap document was served. */
export type SitemapKind =
  /** A list of pages. */
  | 'urlset'
  /** A list of other sitemaps. */
  | 'sitemapindex'
  /** Neither, or nothing recognisable. */
  | 'unknown';

/** A rule of the sitemaps protocol that the document breaks. */
export type SitemapDefectCode =
  /** The root element declares no sitemaps.org 0.9 namespace. */
  | 'namespace'
  /** A `<url>` or `<sitemap>` element with no `<loc>` child. */
  | 'loc_missing'
  /** A `<loc>` that is not an absolute http or https URL. */
  | 'loc_not_absolute'
  /** A `<loc>` carrying a character the protocol requires to be escaped. */
  | 'loc_unescaped'
  /** A `<loc>` past the length the protocol allows. */
  | 'loc_too_long'
  /** A `<loc>` on a different host from the sitemap itself. */
  | 'loc_other_host'
  /** A `<lastmod>` that is not a W3C Datetime. */
  | 'lastmod'
  /** A `<changefreq>` outside the values the protocol defines. */
  | 'changefreq'
  /** A `<priority>` outside 0.0 to 1.0. */
  | 'priority'
  /** More entries than one sitemap may hold. */
  | 'too_many_entries'
  /** An element that belongs to `<url>` used inside a `<sitemap>` of an index. */
  | 'index_element';

/**
 * One rule broken, with every entry that breaks it counted together.
 *
 * Aggregated by code on purpose: a fifty-thousand-URL sitemap with a mistake in
 * its template breaks the same rule fifty thousand times, and a report that
 * says so once with a count is the one someone can act on.
 */
export interface SitemapDefect {
  /** Which rule. */
  code: SitemapDefectCode;
  /**
   * How much it costs.
   *
   * `warning` when a consumer drops the entry or the file; `info` when the
   * value is ignored and the URL is still crawled.
   */
  severity: 'warning' | 'info';
  /** How many entries break it. `1` for a defect of the document itself. */
  count: number;
  /** One offending value, for recognition, or `null` for a document-level rule. */
  example: string | null;
  /** What is wrong and what it costs, in plain words. */
  detail: string;
}

/** What a sitemap turned out to contain. */
export interface SitemapReading {
  /** Which document type the root element declares. */
  kind: SitemapKind;
  /** How many `<loc>` entries were seen. */
  entryCount: number;
  /** The first few entries, for a human reading the report. */
  sampleEntries: string[];
  /** Why the document is unusable, in plain words, or `null` when it is fine. */
  problem: string | null;
  /**
   * Rules of the protocol the document breaks, one entry per rule.
   *
   * Empty when the document is clean, and also when there was nothing to check
   * — a document with no recognisable root is reported through `problem`, not
   * as a list of the rules an unreadable file cannot be said to break.
   */
  defects: SitemapDefect[];
}

/** Entries kept for display. Enough to recognise the shape, not enough to flood a report. */
const SAMPLE_SIZE = 3;

/** The two bytes every gzip member begins with, RFC 1952 section 2.3.1. */
const GZIP_MAGIC = [0x1f, 0x8b];

const unzip = promisify(gunzip);

/** A sitemap document, once it has been turned into text. */
export interface SitemapBody {
  /** The document as text. Empty when it could not be decoded at all. */
  body: string;
  /** Whether it arrived gzipped, i.e. as a `sitemap.xml.gz`. */
  compressed: boolean;
  /** Why it could not be unpacked, or `null` when it was fine. */
  problem: string | null;
}

/**
 * Turns a sitemap response into text, unpacking gzip when that is what arrived.
 *
 * `sitemap.xml.gz` is a gzip **file**, not a gzip-encoded response: the server
 * sends it with `Content-Type: application/gzip` and no `Content-Encoding`, so
 * nothing in the HTTP stack unpacks it. Decoding those bytes as UTF-8 produces a
 * page of replacement characters, and the reader below then reports a perfectly
 * good sitemap as having no `<urlset>` root — which is how this check used to
 * fail on a form the sitemaps protocol has always allowed.
 *
 * The magic bytes decide, not the content type. Hosts label `.gz` files as
 * `application/octet-stream`, `text/xml` and `application/x-gzip` about as often
 * as they label them correctly, and the first two bytes of a gzip member are not
 * a matter of opinion.
 *
 * @param bytes The document as served.
 * @param truncated Whether the fetch was cut off at its byte limit.
 * @returns The text, whether it was compressed, and why it could not be unpacked
 *   when it could not.
 * @throws Never. A document that will not unpack is a finding, not a failure.
 */
export async function decodeSitemapBody(
  bytes: Uint8Array,
  truncated: boolean,
): Promise<SitemapBody> {
  if (!isGzip(bytes)) {
    // `fatal: false`, as everywhere else: a body cut mid-character degrades to a
    // replacement character rather than failing the check.
    return {
      body: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
      compressed: false,
      problem: null,
    };
  }

  try {
    const unpacked = await unzip(bytes, {
      // The compressed read is already capped; this is the other half of the
      // same bound, and without it half a mebibyte of gzip can become hundreds.
      maxOutputLength: LIMITS.maxSitemapUnpackedBytes,
      // A truncated fetch leaves a gzip stream that simply stops, which the
      // default finish flush treats as corruption and refuses outright. This
      // keeps whatever decompressed cleanly, so a sitemap too large to read
      // whole still yields a floor count — the same contract the uncompressed
      // path already has.
      finishFlush: constants.Z_SYNC_FLUSH,
    });

    // `Z_SYNC_FLUSH` is what lets a cut-short stream yield the part that did
    // decompress, and the price is that a thoroughly corrupt one yields nothing
    // instead of throwing. Nothing unpacked has to be said out loud: passed on
    // as an empty document it would be reported as "no <urlset> root element",
    // which of a gzipped file is true only in the least useful sense.
    if (unpacked.length === 0) {
      return {
        body: '',
        compressed: true,
        problem: 'the sitemap is gzipped, but nothing could be unpacked from it',
      };
    }

    return {
      body: new TextDecoder('utf-8', { fatal: false }).decode(unpacked),
      compressed: true,
      problem: null,
    };
  } catch (cause) {
    const tooLarge = (cause as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE';
    return {
      body: '',
      compressed: true,
      problem: tooLarge
        ? `the sitemap is gzipped and unpacks to more than ${String(
            Math.floor(LIMITS.maxSitemapUnpackedBytes / (1024 * 1024)),
          )} MiB, which is past anything this tool will read`
        : `the sitemap is gzipped but could not be unpacked${truncated ? ' from the part of it that was read' : ''}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
    };
  }
}

/**
 * @param bytes The document as served.
 * @returns Whether it begins with a gzip member header.
 * @throws Never.
 */
function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

/**
 * Reads an XML sitemap and checks it against the rules of the protocol.
 *
 * @param body The document as served, already decoded. An empty string is
 *   treated as an unusable document rather than as an empty sitemap.
 * @param truncated Whether the body was cut off at a byte limit, in which case
 *   the entry count is a floor rather than a total, and the rules are checked
 *   only against the part that arrived.
 * @param sitemapUrl Where the document was served from, which decides whether
 *   an entry on another host is cross-submitted. `null` when it is not known,
 *   and that one rule is then skipped rather than guessed at.
 * @returns What the document declares and contains, and which rules it breaks.
 * @throws Never.
 */
export function readSitemap(
  body: string,
  truncated: boolean,
  sitemapUrl: string | null = null,
): SitemapReading {
  const kind = detectKind(body);

  if (kind === 'unknown') {
    return {
      kind,
      entryCount: 0,
      sampleEntries: [],
      problem: looksLikeHtml(body)
        ? 'the URL returns an HTML page, not a sitemap — many hosts answer a missing file with their 404 page and a 200 status'
        : 'the document has no <urlset> or <sitemapindex> root element',
      defects: [],
    };
  }

  const entries = readLocations(body);

  return {
    kind,
    entryCount: entries.length,
    sampleEntries: entries.slice(0, SAMPLE_SIZE),
    problem:
      entries.length === 0 && !truncated
        ? `the <${kind}> element is present but contains no <loc> entries`
        : null,
    defects: findDefects(body, kind, entries.length, sitemapUrl),
  };
}

/**
 * @param body The document as served.
 * @returns Which root element it declares.
 * @throws Never.
 */
function detectKind(body: string): SitemapKind {
  // Namespace prefixes are legal on these elements, and the attribute list can
  // run to several lines, so the tag name is matched rather than a whole tag.
  if (/<(?:[a-z0-9_-]+:)?urlset[\s>]/i.test(body)) return 'urlset';
  if (/<(?:[a-z0-9_-]+:)?sitemapindex[\s>]/i.test(body)) return 'sitemapindex';
  return 'unknown';
}

/**
 * @param body The document as served.
 * @returns Every `<loc>` value, trimmed, in document order.
 * @throws Never.
 */
function readLocations(body: string): string[] {
  const found: string[] = [];
  // `[^<]*` cannot backtrack, which matters for a document fetched from a host
  // that may not be friendly.
  const pattern = /<(?:[a-z0-9_-]+:)?loc>([^<]*)<\/(?:[a-z0-9_-]+:)?loc>/gi;

  for (const match of body.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value !== undefined && value !== '') found.push(decodeEntities(value));
  }

  return found;
}

/**
 * @param body The document as served.
 * @returns Whether it looks like an HTML page, which is what a host answering a
 *   missing sitemap with its own 404 page tends to send.
 * @throws Never.
 */
function looksLikeHtml(body: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(body);
}

/**
 * Decodes the five XML predefined entities.
 *
 * Sitemap URLs are required to be entity-escaped, so `&amp;` in a query string
 * is the normal case rather than an oddity, and reporting the escaped form
 * would show a URL that does not exist.
 *
 * @param value One `<loc>` value.
 * @returns The value with predefined entities decoded.
 * @throws Never.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The namespace a sitemap has to declare, from the protocol's own schema.
 *
 * Consumers key on it: a document with the right elements and no namespace is
 * not a sitemap as far as the specification is concerned, which is why this is
 * graded as a defect of the whole file rather than of an entry.
 */
const SITEMAP_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';

/** Google's pre-standard namespace, which old generators still emit. */
const LEGACY_NAMESPACE = 'http://www.google.com/schemas/sitemap/0.84';

/**
 * The same string with an `https` scheme, which is a different namespace.
 *
 * A namespace is an opaque identifier that happens to look like a URL; nothing
 * fetches it, and `https://` does not match `http://`. Generators write it
 * anyway — cloudflare.com serves a sitemap declaring it — and the large
 * consumers are lenient about this one, so it is reported and graded as costing
 * nothing today rather than as a file nobody reads.
 */
const HTTPS_NAMESPACE = 'https://www.sitemaps.org/schemas/sitemap/0.9';

/** Entries one sitemap document may hold, urlset and index alike. */
const MAX_ENTRIES = 50_000;

/** Characters a `<loc>` value may hold, per the protocol. */
const MAX_LOC_LENGTH = 2048;

/** The only values `<changefreq>` is allowed to take. */
const CHANGE_FREQUENCIES = new Set([
  'always',
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'never',
]);

/**
 * W3C Datetime, which is what `<lastmod>` is defined as.
 *
 * The complete date is the shortest form anyone should write, but a year alone
 * and a year-month are both legal and are accepted here rather than reported —
 * this checks the protocol's rule, not a preference on top of it. Seconds and a
 * fractional part are optional; a time requires a zone, `Z` or an offset.
 */
const W3C_DATETIME =
  /^\d{4}(?:-\d{2}(?:-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?)?)?$/;

/** The five characters the protocol requires a `<loc>` to escape. */
const MUST_BE_ESCAPED = /[<>"']|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i;

/**
 * Checks a sitemap against the rules of the protocol.
 *
 * Every rule here is one a consumer acts on: it either drops the entry, drops
 * the file, or ignores a value. Rules deliberately left unchecked are recorded
 * in `docs/adr/0019-sitemap-rules-without-a-schema-validator.md`.
 *
 * @param body The document as served, already decoded.
 * @param kind Which root element it declares. Never `unknown` here.
 * @param entryCount How many `<loc>` entries were found.
 * @param sitemapUrl Where it was served from, or `null` when not known.
 * @returns One defect per rule broken, in the order the rules are checked, with
 *   every offending entry counted into its own rule.
 * @throws Never.
 */
function findDefects(
  body: string,
  kind: Exclude<SitemapKind, 'unknown'>,
  entryCount: number,
  sitemapUrl: string | null,
): SitemapDefect[] {
  const collector = new DefectCollector();

  checkNamespace(body, kind, collector);

  if (entryCount > MAX_ENTRIES) {
    collector.add(
      'too_many_entries',
      'warning',
      null,
      `The sitemap holds ${String(entryCount)} entries, past the ${String(MAX_ENTRIES)} one sitemap may hold. Split it and list the parts from a <sitemapindex>.`,
    );
  }

  const sitemapHost = sitemapUrl === null ? null : hostOf(sitemapUrl);

  for (const block of readEntryBlocks(body, kind)) {
    checkEntry(block, kind, sitemapHost, collector);
  }

  return collector.defects();
}

/**
 * @param body The document as served.
 * @param kind Which root element it declares.
 * @param collector Collector, appended to in place.
 * @throws Never.
 */
function checkNamespace(
  body: string,
  kind: Exclude<SitemapKind, 'unknown'>,
  collector: DefectCollector,
): void {
  const root = readRootTag(body, kind);
  if (root === null || root.includes(SITEMAP_NAMESPACE)) return;

  if (root.includes(HTTPS_NAMESPACE)) {
    collector.add(
      'namespace',
      'info',
      HTTPS_NAMESPACE,
      `The <${kind}> element declares the namespace with an https scheme. A namespace is an opaque identifier and not an address that gets fetched, so ${HTTPS_NAMESPACE} is a different namespace from the ${SITEMAP_NAMESPACE} the protocol defines. The large search engines accept it, so nothing is lost today; a strict reader would see no sitemap.`,
    );
    return;
  }

  collector.add(
    'namespace',
    'warning',
    null,
    root.includes(LEGACY_NAMESPACE)
      ? `The <${kind}> element declares the ${LEGACY_NAMESPACE} namespace, which predates the protocol and which current consumers do not accept. It should be ${SITEMAP_NAMESPACE}.`
      : `The <${kind}> element declares no ${SITEMAP_NAMESPACE} namespace, so a consumer reading it strictly does not see a sitemap at all.`,
  );
}

/**
 * Checks one `<url>` or `<sitemap>` entry.
 *
 * @param block The text between the entry's start and end tags.
 * @param kind Which root element the document declares.
 * @param sitemapHost Host the sitemap itself was served from, or `null`.
 * @param collector Collector, appended to in place.
 * @throws Never.
 */
function checkEntry(
  block: string,
  kind: Exclude<SitemapKind, 'unknown'>,
  sitemapHost: string | null,
  collector: DefectCollector,
): void {
  const loc = childValue(block, 'loc');

  if (loc === null) {
    collector.add(
      'loc_missing',
      'warning',
      null,
      `A <${kind === 'urlset' ? 'url' : 'sitemap'}> element carries no <loc>, which is the one child the protocol requires. The entry is dropped.`,
    );
    return;
  }

  checkLocation(loc, sitemapHost, collector);

  const lastmod = childValue(block, 'lastmod');
  if (lastmod !== null && !isW3cDatetime(lastmod)) {
    collector.add(
      'lastmod',
      'info',
      lastmod,
      `A <lastmod> is not a W3C Datetime, so it is ignored and the page is treated as never having been modified. Write 2026-09-07, or a full timestamp with its zone.`,
    );
  }

  if (kind === 'sitemapindex') {
    checkIndexOnlyChildren(block, collector);
    return;
  }

  const changefreq = childValue(block, 'changefreq');
  if (changefreq !== null && !CHANGE_FREQUENCIES.has(changefreq.toLowerCase())) {
    collector.add(
      'changefreq',
      'info',
      changefreq,
      `A <changefreq> is not one of ${[...CHANGE_FREQUENCIES].join(', ')}, so it is ignored.`,
    );
  }

  const priority = childValue(block, 'priority');
  if (priority !== null && !isValidPriority(priority)) {
    collector.add(
      'priority',
      'info',
      priority,
      'A <priority> is not a number between 0.0 and 1.0, so it is ignored.',
    );
  }
}

/**
 * Checks the one rule a `<loc>` value has to satisfy, and the three it should.
 *
 * @param loc The raw value, entities still escaped.
 * @param sitemapHost Host the sitemap itself was served from, or `null`.
 * @param collector Collector, appended to in place.
 * @throws Never.
 */
function checkLocation(loc: string, sitemapHost: string | null, collector: DefectCollector): void {
  // Checked before decoding, because this rule is about the bytes in the file:
  // a bare `&` in a query string makes the document ill-formed XML, and a parser
  // that stops there loses every entry after it.
  if (MUST_BE_ESCAPED.test(loc)) {
    collector.add(
      'loc_unescaped',
      'warning',
      loc,
      'A <loc> carries an unescaped &, <, >, " or \', which the protocol requires to be written as an entity. A strict XML parser stops at it and loses the rest of the file.',
    );
  }

  const decoded = decodeEntities(loc);

  if (decoded.length > MAX_LOC_LENGTH) {
    collector.add(
      'loc_too_long',
      'warning',
      `${decoded.slice(0, 80)}…`,
      `A <loc> is ${String(decoded.length)} characters, past the ${String(MAX_LOC_LENGTH)} the protocol allows. The entry is dropped.`,
    );
    return;
  }

  const host = hostOf(decoded);

  if (host === null) {
    collector.add(
      'loc_not_absolute',
      'warning',
      decoded,
      'A <loc> is not an absolute http or https URL. The protocol has no relative form — every entry begins with a scheme and a host — and a consumer has nothing to resolve it against, so the entry is dropped.',
    );
    return;
  }

  if (sitemapHost !== null && host !== sitemapHost) {
    const sibling = sameRegistrableDomain(host, sitemapHost);
    collector.add(
      'loc_other_host',
      sibling ? 'info' : 'warning',
      decoded,
      sibling
        ? `A <loc> is on ${host} while the sitemap is served from ${sitemapHost}. Search engines treat those as different sites, so the entry counts as cross-submitted and is only honoured because both names are the same domain — list the host the sitemap is served from.`
        : `A <loc> is on ${host}, which is not the ${sitemapHost} the sitemap is served from. A consumer ignores entries for a host it did not find the sitemap under, so the entry is dropped.`,
    );
  }
}

/**
 * @param block One `<sitemap>` entry of an index.
 * @param collector Collector, appended to in place.
 * @throws Never.
 */
function checkIndexOnlyChildren(block: string, collector: DefectCollector): void {
  for (const name of ['changefreq', 'priority']) {
    if (childValue(block, name) === null) continue;
    collector.add(
      'index_element',
      'info',
      name,
      `A <sitemap> entry of the index carries a <${name}>, which the protocol defines only for a <url>. It is ignored.`,
    );
  }
}

/** Gathers defects, one entry per rule, counting every offender into it. */
class DefectCollector {
  readonly #found = new Map<SitemapDefectCode, SitemapDefect>();

  /**
   * Records one entry breaking one rule.
   *
   * The first offender is kept as the example and the rest only counted: the
   * detail of a rule does not change from entry to entry, and a report that
   * repeats it is unreadable exactly when the mistake is widest.
   *
   * @param code Which rule.
   * @param severity What it costs.
   * @param example The offending value, or `null` for a document-level rule.
   * @param detail What is wrong and what it costs.
   * @throws Never.
   */
  add(
    code: SitemapDefectCode,
    severity: 'warning' | 'info',
    example: string | null,
    detail: string,
  ): void {
    const seen = this.#found.get(code);

    if (seen === undefined) {
      this.#found.set(code, { code, severity, count: 1, example, detail });
      return;
    }

    seen.count += 1;
    // A rule broken two ways keeps the harsher grade: `loc_other_host` is `info`
    // for a www sibling and a `warning` for a stranger's host, and a file with
    // both must not be reported as if it only had the first.
    if (severity === 'warning') seen.severity = 'warning';
  }

  /**
   * @returns Every rule broken, each with its count.
   * @throws Never.
   */
  defects(): SitemapDefect[] {
    return [...this.#found.values()];
  }
}

/**
 * @param body The document as served.
 * @param kind Which root element it declares.
 * @returns The root start tag, attributes included, or `null` when it cannot be
 *   isolated — an unclosed root tag is not something to guess at.
 * @throws Never.
 */
function readRootTag(body: string, kind: Exclude<SitemapKind, 'unknown'>): string | null {
  const match = new RegExp(`<(?:[a-z0-9_-]+:)?${kind}(\\s[^>]*)?>`, 'i').exec(body);
  return match?.[0] ?? null;
}

/**
 * @param body The document as served.
 * @param kind Which root element it declares, which decides the entry element.
 * @returns The text inside each entry, in document order.
 * @throws Never.
 */
function readEntryBlocks(body: string, kind: Exclude<SitemapKind, 'unknown'>): string[] {
  const element = kind === 'urlset' ? 'url' : 'sitemap';
  // `[\s\S]*?` is lazy and ends on a literal, so it cannot backtrack across the
  // document the way a greedy alternative would on a file with an unclosed tag.
  const pattern = new RegExp(
    `<(?:[a-z0-9_-]+:)?${element}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-z0-9_-]+:)?${element}>`,
    'gi',
  );

  return [...body.matchAll(pattern)].map((match) => match[1] ?? '');
}

/**
 * @param block The text inside one entry.
 * @param name Child element name, without a namespace prefix.
 * @returns The first such child's text, trimmed, entities still escaped, or
 *   `null` when the entry has no such child. An empty element reads as absent,
 *   because `<lastmod></lastmod>` says nothing and is not worth two findings.
 * @throws Never.
 */
function childValue(block: string, name: string): string | null {
  const match = new RegExp(
    `<(?:[a-z0-9_-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[a-z0-9_-]+:)?${name}>`,
    'i',
  ).exec(block);
  const value = match?.[1]?.trim();
  return value === undefined || value === '' ? null : value;
}

/**
 * @param value A `<lastmod>` value.
 * @returns Whether it is a W3C Datetime that names a date that exists.
 * @throws Never.
 */
function isW3cDatetime(value: string): boolean {
  if (!W3C_DATETIME.test(value)) return false;

  // The shape is right; the day may still not exist. `2026-02-31` parses to
  // 2026-03-03 in every implementation that accepts it, so a round trip is what
  // separates a real date from an arithmetic one.
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (day === null) return true;

  const parsed = new Date(`${day[1] ?? ''}-${day[2] ?? ''}-${day[3] ?? ''}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value.slice(0, 10)
  );
}

/**
 * @param value A `<priority>` value.
 * @returns Whether it is a number the protocol allows.
 * @throws Never.
 */
function isValidPriority(value: string): boolean {
  // `Number('')` is 0 and `Number(' 1 ')` is 1, so the shape is checked first.
  if (!/^\d+(?:\.\d+)?$/.test(value)) return false;
  const parsed = Number(value);
  return parsed >= 0 && parsed <= 1;
}

/**
 * @param url An absolute URL, or something that is not one.
 * @returns Its host, lowercased, or `null` when it is not an absolute http or
 *   https URL. A `<loc>` with any other scheme is as unusable as a relative one.
 * @throws Never.
 */
function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : null;
  } catch {
    return null;
  }
}

/**
 * @param host One host.
 * @param other Another.
 * @returns Whether both are names under the same registrable domain, which is
 *   what separates the `www` mistake from a sitemap listing somebody else's site.
 * @throws Never.
 */
function sameRegistrableDomain(host: string, other: string): boolean {
  const parsed = parseTarget(host);
  const otherParsed = parseTarget(other);

  return (
    parsed.ok &&
    otherParsed.ok &&
    parsed.registrable !== null &&
    parsed.registrable === otherParsed.registrable
  );
}
