import { promisify } from 'node:util';
import { constants, gunzip } from 'node:zlib';
import { LIMITS } from './defaults.js';

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
