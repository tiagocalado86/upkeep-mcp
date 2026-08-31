import { describe, expect, it } from 'vitest';
import { readSitemap } from '../../src/lib/sitemap.js';

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
