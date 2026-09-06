import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/lib/defaults.js';
import { decodeSitemapBody, readSitemap, type SitemapReading } from '../../src/lib/sitemap.js';

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc><lastmod>2026-08-01</lastmod></url>
  <url><loc>https://example.com/about</loc></url>
  <url><loc>https://example.com/blog?page=1&amp;sort=new</loc></url>
</urlset>`;

describe('readSitemap', () => {
  it('reads a urlset and its entries', () => {
    const reading = readSitemap(URLSET, false);

    expect(reading.kind).toBe('urlset');
    expect(reading.entryCount).toBe(3);
    expect(reading.problem).toBeNull();
  });

  it('decodes the entities a sitemap is required to escape', () => {
    // A URL reported with &amp; still in it is a URL that does not exist.
    expect(readSitemap(URLSET, false).sampleEntries[2]).toBe(
      'https://example.com/blog?page=1&sort=new',
    );
  });

  it('recognises a sitemap index', () => {
    const reading = readSitemap(
      `<sitemapindex><sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap></sitemapindex>`,
      false,
    );

    expect(reading.kind).toBe('sitemapindex');
    expect(reading.entryCount).toBe(1);
  });

  it('handles a namespace prefix on the elements', () => {
    const reading = readSitemap(
      `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
         <sm:url><sm:loc>https://example.com/</sm:loc></sm:url>
       </sm:urlset>`,
      false,
    );

    expect(reading.kind).toBe('urlset');
    expect(reading.entryCount).toBe(1);
  });

  it('names the commonest failure: a 404 page served with a 200 status', () => {
    const reading = readSitemap('<!doctype html><html><body>Not found</body></html>', false);

    expect(reading.kind).toBe('unknown');
    expect(reading.problem).toContain('HTML page');
  });

  it('reports a document that is neither HTML nor a sitemap', () => {
    const reading = readSitemap('{"urls": []}', false);

    expect(reading.kind).toBe('unknown');
    expect(reading.problem).toContain('no <urlset> or <sitemapindex>');
  });

  it('reports an empty urlset as a problem', () => {
    const reading = readSitemap('<urlset></urlset>', false);

    expect(reading.problem).toContain('no <loc> entries');
  });

  it('does not call a truncated sitemap empty, since the entries may be past the cut', () => {
    expect(readSitemap('<urlset>', true).problem).toBeNull();
  });

  it('treats an empty document as unusable rather than as an empty sitemap', () => {
    expect(readSitemap('', false).kind).toBe('unknown');
  });
});

describe('decodeSitemapBody', () => {
  it('reads a plain document unchanged', async () => {
    const decoded = await decodeSitemapBody(new TextEncoder().encode(URLSET), false);

    expect(decoded).toMatchObject({ compressed: false, problem: null });
    expect(readSitemap(decoded.body, false).entryCount).toBe(3);
  });

  it('unpacks a gzipped sitemap, which is a file format and not a transfer encoding', async () => {
    // `sitemap.xml.gz` arrives with `Content-Type: application/gzip` and no
    // `Content-Encoding`, so nothing in the HTTP stack unpacks it. Before this,
    // those bytes decoded to replacement characters and a perfectly good
    // sitemap was reported as having no <urlset> root.
    const decoded = await decodeSitemapBody(gzipSync(Buffer.from(URLSET)), false);

    expect(decoded).toMatchObject({ compressed: true, problem: null });
    expect(readSitemap(decoded.body, false)).toMatchObject({ kind: 'urlset', entryCount: 3 });
  });

  it('decides on the magic bytes, not on the content type', async () => {
    // Hosts label `.gz` files `application/octet-stream`, `text/xml` and
    // `application/x-gzip` about as often as they label them correctly. The
    // first two bytes of a gzip member are not a matter of opinion.
    const gzipped = gzipSync(Buffer.from(URLSET));

    expect(gzipped[0]).toBe(0x1f);
    expect(gzipped[1]).toBe(0x8b);
    expect((await decodeSitemapBody(gzipped, false)).compressed).toBe(true);
    expect((await decodeSitemapBody(new TextEncoder().encode(URLSET), false)).compressed).toBe(
      false,
    );
  });

  it('keeps what it can from a gzip stream the read limit cut short', async () => {
    // A truncated fetch leaves a gzip stream that simply stops. Refusing it
    // outright would turn "this sitemap is bigger than the read limit" into
    // "this sitemap is broken", so a floor count is produced instead — the same
    // contract the uncompressed path already has.
    const many = Array.from(
      { length: 400 },
      (_unused, index) => `<url><loc>https://example.com/page-${String(index)}</loc></url>`,
    ).join('');
    const gzipped = gzipSync(Buffer.from(`<urlset>${many}</urlset>`));
    const cut = gzipped.subarray(0, Math.floor(gzipped.length / 2));

    const decoded = await decodeSitemapBody(cut, true);

    expect(decoded.problem).toBeNull();
    const reading = readSitemap(decoded.body, true);
    expect(reading.kind).toBe('urlset');
    expect(reading.entryCount).toBeGreaterThan(0);
    expect(reading.entryCount).toBeLessThan(400);
  });

  it('refuses a decompression bomb instead of unpacking it', async () => {
    // A few kilobytes of gzip becoming hundreds of mebibytes of zeroes is the
    // classic way to be handed one. The compressed read is already capped; this
    // is the other half of the same bound.
    const bomb = gzipSync(Buffer.alloc(LIMITS.maxSitemapUnpackedBytes + 1024));

    expect(bomb.length).toBeLessThan(200 * 1024);

    const decoded = await decodeSitemapBody(bomb, false);
    expect(decoded).toMatchObject({ compressed: true, body: '' });
    expect(decoded.problem).toMatch(/unpacks to more than 16 MiB/);
  });

  it('reports gzip that is not gzip as unreadable rather than as absent', async () => {
    // The magic bytes are right and the rest is not: something is served, and it
    // is broken. That is a defect, not a missing sitemap.
    const decoded = await decodeSitemapBody(Uint8Array.from([0x1f, 0x8b, 0x08, 0, 1, 2, 3]), false);

    expect(decoded.compressed).toBe(true);
    // Not "the document has no <urlset> root element", which of a gzipped file
    // is true only in the least useful sense.
    expect(decoded.problem).toMatch(/nothing could be unpacked from it/);
  });

  it('is not fooled by a one-byte body', async () => {
    expect((await decodeSitemapBody(Uint8Array.from([0x1f]), false)).compressed).toBe(false);
    expect((await decodeSitemapBody(new Uint8Array(0), false)).compressed).toBe(false);
  });
});

describe('readSitemap, against the rules of the protocol', () => {
  it('finds nothing wrong with a sitemap that follows them', () => {
    expect(readSitemap(URLSET, false, 'https://example.com/sitemap.xml').defects).toEqual([]);
  });

  it('reports a root element with no sitemaps.org namespace', () => {
    // The elements alone are not a sitemap: consumers key on the namespace, so
    // a file without it is dropped whole rather than read and ignored.
    const [defect] = readSitemap(
      '<urlset><url><loc>https://a.test/</loc></url></urlset>',
      false,
    ).defects;

    expect(defect).toMatchObject({ code: 'namespace', severity: 'warning', count: 1 });
    expect(defect?.detail).toContain('http://www.sitemaps.org/schemas/sitemap/0.9');
  });

  it('names the pre-standard namespace when that is what is declared', () => {
    const reading = readSitemap(
      '<urlset xmlns="http://www.google.com/schemas/sitemap/0.84"><url><loc>https://a.test/</loc></url></urlset>',
      false,
    );

    expect(reading.defects[0]?.detail).toContain('predates the protocol');
  });

  it('grades the https namespace as costing nothing today, and says why', () => {
    // A namespace is an opaque identifier, not an address that gets fetched, so
    // the https spelling is a different namespace from the one the protocol
    // defines. Real sites serve it — cloudflare.com does — and the large
    // consumers accept it, so reporting it as a file nobody reads would be
    // false. Found by running this against real sitemaps rather than fixtures.
    const reading = readSitemap(
      '<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.test/</loc></url></urlset>',
      false,
    );

    expect(reading.defects[0]).toMatchObject({ code: 'namespace', severity: 'info' });
    expect(reading.defects[0]?.detail).toContain('https scheme');
  });

  it('accepts the namespace on a prefix, which is where a prefixed root carries it', () => {
    const reading = readSitemap(
      `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
         <sm:url><sm:loc>https://example.com/</sm:loc></sm:url>
       </sm:urlset>`,
      false,
    );

    expect(reading.defects).toEqual([]);
  });

  it('reports an entry with no <loc>', () => {
    const reading = readSitemap(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
         <url><lastmod>2026-09-01</lastmod></url>
       </urlset>`,
      false,
    );

    expect(reading.defects[0]).toMatchObject({ code: 'loc_missing', severity: 'warning' });
  });

  it('reports a <loc> that is not an absolute http or https URL', () => {
    const reading = readSitemap(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
         <url><loc>/about</loc></url>
         <url><loc>ftp://example.com/file</loc></url>
       </urlset>`,
      false,
    );

    expect(reading.defects[0]).toMatchObject({
      code: 'loc_not_absolute',
      severity: 'warning',
      count: 2,
      example: '/about',
    });
  });

  it('reports an unescaped ampersand, which costs every entry after it', () => {
    // The document is ill-formed XML from that character on, so a strict parser
    // stops there — the entries below it are lost, not just this one.
    const reading = readSitemap(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
         <url><loc>https://example.com/?a=1&b=2</loc></url>
       </urlset>`,
      false,
    );

    expect(reading.defects[0]).toMatchObject({ code: 'loc_unescaped', severity: 'warning' });
  });

  it('grades a raw apostrophe below a bare ampersand, because parsers accept it', () => {
    // Found in review. Only & and < make XML ill-formed; > " and ' are legal in
    // character data. Warning about an apostrophe in a slug — ordinary — with
    // "a parser stops at it" was a claim that was simply not true.
    const withApostrophe = readSitemap(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
         <url><loc>https://example.com/l'histoire</loc></url>
       </urlset>`,
      false,
    );

    expect(withApostrophe.defects[0]).toMatchObject({ code: 'loc_escaping', severity: 'info' });
    expect(withApostrophe.defects[0]?.detail).toContain('nothing will fail to read the file');
  });

  it('does not mistake a properly escaped ampersand for an unescaped one', () => {
    // `&amp;` in a query string is the normal case, not an oddity.
    expect(readSitemap(URLSET, false).defects).toEqual([]);
  });

  it('reports a <loc> past the length the protocol allows', () => {
    const long = `https://example.com/${'a'.repeat(2100)}`;
    const reading = readSitemap(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${long}</loc></url></urlset>`,
      false,
    );

    expect(reading.defects[0]).toMatchObject({ code: 'loc_too_long', severity: 'warning' });
  });

  it('reports entries on somebody else’s host as dropped', () => {
    const reading = readSitemap(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
         <url><loc>https://other.test/page</loc></url>
       </urlset>`,
      false,
      'https://example.com/sitemap.xml',
    );

    expect(reading.defects[0]).toMatchObject({ code: 'loc_other_host', severity: 'warning' });
  });

  it('grades the www sibling below a stranger, because it is the same domain', () => {
    // Search engines still treat them as different sites, so it is worth saying
    // — but it is not the same mistake as listing another company's URLs.
    const reading = readSitemap(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
         <url><loc>https://www.example.com/page</loc></url>
       </urlset>`,
      false,
      'https://example.com/sitemap.xml',
    );

    expect(reading.defects[0]).toMatchObject({ code: 'loc_other_host', severity: 'info' });
  });

  it('keeps the harsher grade when one rule is broken both ways', () => {
    const reading = readSitemap(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
         <url><loc>https://www.example.com/page</loc></url>
         <url><loc>https://other.test/page</loc></url>
       </urlset>`,
      false,
      'https://example.com/sitemap.xml',
    );

    expect(reading.defects[0]).toMatchObject({
      code: 'loc_other_host',
      severity: 'warning',
      count: 2,
    });
  });

  it('skips the other-host rule when it does not know where the sitemap came from', () => {
    const reading = readSitemap(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
         <url><loc>https://other.test/page</loc></url>
       </urlset>`,
      false,
    );

    expect(reading.defects).toEqual([]);
  });

  it('accepts every W3C Datetime <lastmod> and refuses the rest', () => {
    const good = [
      '2026',
      '2026-09',
      '2026-09-07',
      '2026-09-07T10:30:00Z',
      '2026-09-07T10:30+01:00',
    ];
    const bad = ['07/09/2026', '2026-09-07 10:30', '2026-02-31', 'yesterday'];

    for (const value of good) {
      expect(defectCodes(withLastmod(value))).not.toContain('lastmod');
    }
    for (const value of bad) {
      expect(defectCodes(withLastmod(value))).toContain('lastmod');
    }
  });

  it('grades an ignored value below a dropped entry', () => {
    // A bad <lastmod> costs a freshness hint. A bad <loc> costs the page.
    expect(withLastmod('yesterday').defects[0]).toMatchObject({
      code: 'lastmod',
      severity: 'info',
    });
  });

  it('reports a <changefreq> outside the protocol’s list, whatever its case', () => {
    expect(defectCodes(withChild('changefreq', 'often'))).toContain('changefreq');
    expect(defectCodes(withChild('changefreq', 'Daily'))).not.toContain('changefreq');
  });

  it('reports a <priority> outside 0.0 to 1.0', () => {
    expect(defectCodes(withChild('priority', '2.0'))).toContain('priority');
    expect(defectCodes(withChild('priority', 'high'))).toContain('priority');
    expect(defectCodes(withChild('priority', '0.8'))).not.toContain('priority');
    expect(defectCodes(withChild('priority', '1'))).not.toContain('priority');
  });

  it('counts one template mistake once, with the size of it', () => {
    // Forty entries with the same wrong date is one thing to fix, and a report
    // that says it forty times is unreadable exactly when it matters most.
    const urls = Array.from(
      { length: 40 },
      (_unused, index) =>
        `<url><loc>https://example.com/p${String(index)}</loc><lastmod>07/09/2026</lastmod></url>`,
    ).join('');
    const reading = readSitemap(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
      false,
    );

    expect(reading.defects).toHaveLength(1);
    expect(reading.defects[0]).toMatchObject({ code: 'lastmod', count: 40, example: '07/09/2026' });
  });

  it('reports an index entry carrying an element only a <url> may have', () => {
    const reading = readSitemap(
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
         <sitemap><loc>https://example.com/sitemap-1.xml</loc><priority>0.5</priority></sitemap>
       </sitemapindex>`,
      false,
    );

    expect(reading.defects[0]).toMatchObject({ code: 'index_element', severity: 'info' });
  });

  it('reports more entries than one sitemap may hold', () => {
    const urls = '<url><loc>https://example.com/p</loc></url>'.repeat(50_001);
    const reading = readSitemap(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
      false,
    );

    expect(defectCodes(reading)).toContain('too_many_entries');
  });

  it('checks nothing against a document it could not read', () => {
    // A file that is not a sitemap cannot be said to break the rules of one.
    expect(readSitemap('<!doctype html><html></html>', false).defects).toEqual([]);
  });

  it('judges a truncated document only on the part that arrived', () => {
    // The entry the read cut in half has no closing tag, so it is not seen at
    // all — reporting it as an entry with no <loc> would be an artefact of the
    // read limit rather than a defect of the sitemap.
    const reading = readSitemap(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
         <url><loc>https://example.com/</loc></url>
         <url><loc>https://exam`,
      true,
    );

    expect(reading.defects).toEqual([]);
  });
});

/**
 * @param value A `<lastmod>` value.
 * @returns A one-entry sitemap carrying it.
 */
function withLastmod(value: string): SitemapReading {
  return withChild('lastmod', value);
}

/**
 * @param name A child element of `<url>`.
 * @param value Its value.
 * @returns The reading of a one-entry sitemap carrying it.
 */
function withChild(name: string, value: string): SitemapReading {
  return readSitemap(
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
       <url><loc>https://example.com/</loc><${name}>${value}</${name}></url>
     </urlset>`,
    false,
  );
}

/**
 * @param reading A sitemap reading.
 * @returns The codes of every rule it broke.
 */
function defectCodes(reading: SitemapReading): string[] {
  return reading.defects.map((defect) => defect.code);
}
