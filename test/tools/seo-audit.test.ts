import { describe, expect, it } from 'vitest';
import { runSeoAudit } from '../../src/tools/seo-audit.js';
import { fakePorts, findingCodes, structured, text } from '../helpers/fake-ports.js';

const PAGE_URL = 'https://example.com/';
const SITEMAP_URL = 'https://example.com/sitemap.xml';

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/about</loc></url>
</urlset>`;

/** A page with everything a technical audit looks for. */
function healthyHtml(body = '<h1>Welcome</h1>'): string {
  return `<!doctype html>
    <html lang="pt-PT">
      <head>
        <title>Example, a short title</title>
        <meta name="description" content="A description of a sensible length that says what the page is.">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="canonical" href="https://example.com/">
        <meta property="og:title" content="Example">
        <meta property="og:image" content="https://example.com/card.png">
      </head>
      <body>${body}</body>
    </html>`;
}

describe('runSeoAudit', () => {
  it('reports a healthy page with nothing to act on', async () => {
    const result = await runSeoAudit(
      { url: PAGE_URL },
      fakePorts({
        documents: {
          [PAGE_URL]: { status: 200, body: healthyHtml() },
          [SITEMAP_URL]: { status: 200, body: SITEMAP, contentType: 'application/xml' },
        },
        robots: 'User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml',
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(findingCodes(result)).toEqual([]);
    expect(structured(result)).toMatchObject({
      fetched: true,
      status: 200,
      severity: 'ok',
      sitemap: { found: true, kind: 'urlset', entryCount: 2 },
    });
  });

  it('names every piece of missing metadata', async () => {
    const result = await runSeoAudit(
      { url: PAGE_URL },
      fakePorts({
        documents: {
          [PAGE_URL]: { status: 200, body: '<html><body><p>Just text</p></body></html>' },
          [SITEMAP_URL]: { status: 404, body: '' },
        },
      }),
    );

    expect(findingCodes(result)).toEqual(
      expect.arrayContaining([
        'sitemap_missing',
        'title_missing',
        'meta_description_missing',
        'h1_missing',
        'viewport_missing',
        'canonical_missing',
        'lang_missing',
        'open_graph_incomplete',
      ]),
    );
    expect(structured(result)['severity']).toBe('warning');
  });

  it('treats a noindex directive as critical, because it hides a live page', async () => {
    const result = await runSeoAudit(
      { url: PAGE_URL },
      fakePorts({
        documents: {
          [PAGE_URL]: {
            status: 200,
            body: healthyHtml().replace('<head>', '<head><meta name="robots" content="noindex">'),
          },
          [SITEMAP_URL]: { status: 200, body: SITEMAP },
        },
      }),
    );

    expect(findingCodes(result)[0]).toBe('meta_noindex');
    expect(structured(result)['severity']).toBe('critical');
  });

  it('counts images with no alt and leaves alt="" alone', async () => {
    const result = await runSeoAudit(
      { url: PAGE_URL },
      fakePorts({
        documents: {
          [PAGE_URL]: {
            status: 200,
            body: healthyHtml(
              '<h1>Hi</h1><img src="/a.png" alt="A cat"><img src="/b.png" alt=""><img src="/c.png">',
            ),
          },
          [SITEMAP_URL]: { status: 200, body: SITEMAP },
        },
      }),
    );

    expect(findingCodes(result)).toContain('images_missing_alt');
    expect(structured(result)['page']).toMatchObject({
      imagesTotal: 3,
      imagesMissingAlt: ['https://example.com/c.png'],
    });
  });

  it('requests internal links once each and reports the broken ones', async () => {
    const result = await runSeoAudit(
      { url: PAGE_URL },
      fakePorts({
        documents: {
          [PAGE_URL]: {
            status: 200,
            body: healthyHtml(
              `<h1>Hi</h1>
               <a href="/about">About</a>
               <a href="/about">About again</a>
               <a href="/gone">Gone</a>
               <a href="https://other.example/x">Away</a>`,
            ),
          },
          [SITEMAP_URL]: { status: 200, body: SITEMAP },
        },
        hops: {
          'https://example.com/about': { status: 200 },
          'https://example.com/gone': { status: 404 },
        },
      }),
    );

    expect(structured(result)['links']).toMatchObject({
      internalTotal: 2,
      externalTotal: 1,
      checked: 2,
      broken: [{ url: 'https://example.com/gone', status: 404 }],
    });
    expect(findingCodes(result)).toContain('broken_internal_links');
  });

  it('does not request a link robots.txt forbids', async () => {
    const result = await runSeoAudit(
      { url: PAGE_URL },
      fakePorts({
        documents: {
          [PAGE_URL]: {
            status: 200,
            body: healthyHtml('<h1>Hi</h1><a href="/admin/secret">Admin</a>'),
          },
          [SITEMAP_URL]: { status: 200, body: SITEMAP },
        },
        robots: 'User-agent: *\nDisallow: /admin',
        // No hop fixture for /admin/secret: requesting it would fail the test.
      }),
    );

    expect(structured(result)['links']).toMatchObject({
      internalTotal: 1,
      checked: 0,
      skippedByRobots: 1,
    });
  });

  it('stops at the link limit and says how many it left', async () => {
    const links = Array.from(
      { length: 5 },
      (_, index) => `<a href="/p${String(index)}">L</a>`,
    ).join('');
    const hops = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `https://example.com/p${String(index)}`,
        { status: 200 },
      ]),
    );

    const result = await runSeoAudit(
      { url: PAGE_URL, maxLinks: 2 },
      fakePorts({
        documents: {
          [PAGE_URL]: { status: 200, body: healthyHtml(`<h1>Hi</h1>${links}`) },
          [SITEMAP_URL]: { status: 200, body: SITEMAP },
        },
        hops,
      }),
    );

    expect(structured(result)['links']).toMatchObject({ checked: 2, unchecked: 3 });
    expect(findingCodes(result)).toContain('links_unchecked');
  });

  it('skips link checking entirely when asked to', async () => {
    const result = await runSeoAudit(
      { url: PAGE_URL, checkLinks: false },
      fakePorts({
        documents: {
          [PAGE_URL]: { status: 200, body: healthyHtml('<h1>Hi</h1><a href="/about">About</a>') },
          [SITEMAP_URL]: { status: 200, body: SITEMAP },
        },
        // No hop fixtures at all: any request would reject.
      }),
    );

    expect(structured(result)['links']).toMatchObject({ checked: 0, internalTotal: 1 });
  });

  it('does not read a page robots.txt forbids, and says the rule is the problem', async () => {
    const result = await runSeoAudit(
      { url: 'https://example.com/pricing' },
      fakePorts({ robots: 'User-agent: *\nDisallow: /pricing' }),
    );

    expect(result.isError).toBeFalsy();
    expect(structured(result)['fetched']).toBe(false);
    expect(findingCodes(result)).toEqual(['page_disallowed_by_robots']);
    expect(text(result)).toContain('was not read');
  });

  it('requests nothing at all when robots.txt cannot be read', async () => {
    // RFC 9309 §2.3.1.3. No document fixture is provided, so a request would
    // reject and fail this test.
    const result = await runSeoAudit({ url: PAGE_URL }, fakePorts({ robots: 'unreachable' }));

    expect(findingCodes(result)).toEqual(['robots_txt_unreachable']);
    expect(structured(result)['fetched']).toBe(false);
  });

  it('reports a page that answers 404 as critical, and audits nothing else', async () => {
    const result = await runSeoAudit(
      { url: PAGE_URL },
      fakePorts({ documents: { [PAGE_URL]: { status: 404, body: '<h1>Not found</h1>' } } }),
    );

    expect(findingCodes(result)).toEqual(['page_unavailable']);
    expect(structured(result)['severity']).toBe('critical');
  });

  it('says so when the URL is not an HTML page', async () => {
    const result = await runSeoAudit(
      { url: 'https://example.com/report.pdf' },
      fakePorts({
        documents: {
          'https://example.com/report.pdf': {
            status: 200,
            body: '%PDF-1.7',
            contentType: 'application/pdf',
          },
        },
      }),
    );

    expect(findingCodes(result)).toEqual(['not_html']);
  });

  it('prefers the sitemap robots.txt declares over the conventional location', async () => {
    const declared = 'https://example.com/sitemap-index.xml';
    const result = await runSeoAudit(
      { url: PAGE_URL },
      fakePorts({
        documents: {
          [PAGE_URL]: { status: 200, body: healthyHtml() },
          [declared]: { status: 200, body: SITEMAP },
          // A stale copy at the conventional location, which must not be read.
          [SITEMAP_URL]: { status: 200, body: '<urlset></urlset>' },
        },
        robots: `User-agent: *\nSitemap: ${declared}`,
      }),
    );

    expect(structured(result)['sitemap']).toMatchObject({ url: declared, entryCount: 2 });
  });

  it('recognises a 404 page served with a 200 status in place of a sitemap', async () => {
    const result = await runSeoAudit(
      { url: PAGE_URL },
      fakePorts({
        documents: {
          [PAGE_URL]: { status: 200, body: healthyHtml() },
          [SITEMAP_URL]: {
            status: 200,
            body: '<!doctype html><html><body><h1>Page not found</h1></body></html>',
            contentType: 'text/html',
          },
        },
      }),
    );

    expect(findingCodes(result)).toContain('sitemap_unusable');
    expect(structured(result)['sitemap']).toMatchObject({
      found: false,
      missing: false,
      kind: 'unknown',
    });
  });

  it('rejects a URL it cannot make sense of', async () => {
    const result = await runSeoAudit({ url: '   ' }, fakePorts());

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('invalid_input');
  });

  it('grades a missing sitemap below a broken one', async () => {
    const missing = await runSeoAudit(
      { url: PAGE_URL },
      fakePorts({
        documents: {
          [PAGE_URL]: { status: 200, body: healthyHtml() },
          [SITEMAP_URL]: { status: 404, body: 'Not found' },
        },
      }),
    );

    // Publishing no sitemap is a gap; publishing something that is not a
    // sitemap is a defect, and a portfolio report has to tell them apart.
    expect(findingCodes(missing)).toContain('sitemap_missing');
    expect(findingCodes(missing)).not.toContain('sitemap_unusable');
    expect(structured(missing)['severity']).toBe('info');
  });
});
