/**
 * Structural reading of an XML sitemap.
 *
 * Deliberately not a schema validation and not a full XML parse. What a
 * maintenance report needs to know is whether the file exists, whether it is
 * the kind of document it claims to be, and roughly how much is in it — three
 * questions answerable with a scan, and none of them worth another dependency.
 * Everything this cannot establish is reported as unestablished rather than
 * assumed.
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
}

/** Entries kept for display. Enough to recognise the shape, not enough to flood a report. */
const SAMPLE_SIZE = 3;

/**
 * Reads an XML sitemap.
 *
 * @param body The document as served, already decoded. An empty string is
 *   treated as an unusable document rather than as an empty sitemap.
 * @param truncated Whether the body was cut off at a byte limit, in which case
 *   the entry count is a floor rather than a total.
 * @returns What the document declares and contains.
 * @throws Never.
 */
export function readSitemap(body: string, truncated: boolean): SitemapReading {
  const kind = detectKind(body);

  if (kind === 'unknown') {
    return {
      kind,
      entryCount: 0,
      sampleEntries: [],
      problem: looksLikeHtml(body)
        ? 'the URL returns an HTML page, not a sitemap — many hosts answer a missing file with their 404 page and a 200 status'
        : 'the document has no <urlset> or <sitemapindex> root element',
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
