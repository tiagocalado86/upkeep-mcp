import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/lib/defaults.js';
import { decodeSitemapBody, readSitemap } from '../../src/lib/sitemap.js';

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
