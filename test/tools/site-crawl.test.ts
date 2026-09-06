import { describe, expect, it } from 'vitest';
import { CheckError } from '../../src/lib/errors.js';
import { runSiteCrawl } from '../../src/tools/site-crawl.js';
import { fakePorts, findingCodes, structured, text } from '../helpers/fake-ports.js';

const HOME = 'https://example.com/';

/**
 * @param options What the page should contain.
 * @returns A page with a title, a description and the links given.
 */
function page(
  options: {
    title?: string | null;
    description?: string | null;
    links?: string[];
    head?: string;
  } = {},
): string {
  const title = options.title === null ? '' : `<title>${options.title ?? 'A page'}</title>`;
  const description =
    options.description === null
      ? ''
      : `<meta name="description" content="${options.description ?? 'What this page is about.'}">`;
  const links = (options.links ?? []).map((href) => `<a href="${href}">link</a>`).join('');

  return `<!doctype html><html lang="en"><head>${title}${description}${options.head ?? ''}</head>
    <body><h1>Heading</h1>${links}</body></html>`;
}

/**
 * @param result A tool result.
 * @returns The crawl's own counters.
 */
function crawl(result: Awaited<ReturnType<typeof runSiteCrawl>>): Record<string, unknown> {
  return structured(result)['crawl'] as Record<string, unknown>;
}

/**
 * @param result A tool result.
 * @returns Every page fetched, in visit order.
 */
function pages(result: Awaited<ReturnType<typeof runSiteCrawl>>): { url: string; depth: number }[] {
  return structured(result)['pages'] as { url: string; depth: number }[];
}

describe('runSiteCrawl', () => {
  it('follows internal links from the starting page', async () => {
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({
        robots: 'User-agent: *\nAllow: /',
        documents: {
          [HOME]: { status: 200, body: page({ links: ['/about', '/contact'] }) },
          'https://example.com/about': { status: 200, body: page({ title: 'About' }) },
          'https://example.com/contact': { status: 200, body: page({ title: 'Contact' }) },
        },
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(pages(result).map((visited) => visited.url)).toEqual([
      HOME,
      'https://example.com/about',
      'https://example.com/contact',
    ]);
    expect(crawl(result)).toMatchObject({
      pagesFetched: 3,
      deepestLevel: 1,
      notVisited: 0,
      stoppedBecause: 'nothing left to visit',
    });
  });

  it('stays on the origin it started from', async () => {
    // example.com and www.example.com are different origins, and a crawl that
    // wandered between them would report one site's pages as duplicates of the
    // other's — true, and useless.
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({
        robots: 'User-agent: *',
        documents: {
          [HOME]: {
            status: 200,
            body: page({ links: ['https://elsewhere.test/page', 'https://www.example.com/page'] }),
          },
        },
      }),
    );

    expect(pages(result)).toHaveLength(1);
    expect(crawl(result)).toMatchObject({ notVisited: 0 });
  });

  it('visits a URL once however many pages link to it', async () => {
    // A navigation repeated in a header and a footer is one page to fetch, and
    // a fragment never reaches the server at all.
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({
        robots: 'User-agent: *',
        documents: {
          [HOME]: { status: 200, body: page({ links: ['/about', '/about#team', '/about'] }) },
          'https://example.com/about': {
            status: 200,
            body: page({ title: 'About', links: ['/'] }),
          },
        },
      }),
    );

    expect(pages(result)).toHaveLength(2);
  });

  it('obeys robots.txt for every URL before requesting it', async () => {
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({
        robots: 'User-agent: *\nDisallow: /private',
        documents: {
          [HOME]: { status: 200, body: page({ links: ['/about', '/private/secret'] }) },
          'https://example.com/about': { status: 200, body: page({ title: 'About' }) },
          // No fixture for /private/secret: requesting it would reject, so this
          // asserts it was never requested rather than merely not reported.
        },
      }),
    );

    expect(pages(result)).toHaveLength(2);
    expect(crawl(result)).toMatchObject({ skippedByRobots: 1 });
    expect(findingCodes(result)).toContain('pages_disallowed_by_robots');
  });

  it('refuses to crawl at all when robots.txt could not be read', async () => {
    // RFC 9309: an unreachable robots.txt forbids everything.
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({ robots: 'unreachable', documents: { [HOME]: { status: 200, body: page() } } }),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^invalid_input: /);
    expect(text(result)).toContain('RFC 9309');
  });

  it('keeps a guard refusal as invalid_input, not as a server fault', async () => {
    const refused = new CheckError(
      'invalid_input',
      'this server only contacts the public internet, and 10.0.0.5 is not on it (private range)',
    );

    const result = await runSiteCrawl({ url: 'http://10.0.0.5/' }, fakePorts({ robots: refused }));

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^invalid_input: /);
  });

  it('stops at the page budget and says how much it did not see', async () => {
    const links = Array.from({ length: 10 }, (_unused, index) => `/p${String(index)}`);
    const documents: Record<string, { status: number; body: string }> = {
      [HOME]: { status: 200, body: page({ links }) },
    };
    for (const link of links) {
      documents[`https://example.com${link}`] = { status: 200, body: page({ title: link }) };
    }

    const result = await runSiteCrawl(
      { url: HOME, maxPages: 4 },
      fakePorts({ robots: '', documents }),
    );

    expect(pages(result)).toHaveLength(4);
    expect(crawl(result)).toMatchObject({ stoppedBecause: 'page budget', notVisited: 7 });
    expect(findingCodes(result)).toContain('crawl_incomplete');
  });

  it('stops following links at the depth limit', async () => {
    const result = await runSiteCrawl(
      { url: HOME, maxDepth: 1 },
      fakePorts({
        robots: '',
        documents: {
          [HOME]: { status: 200, body: page({ links: ['/one'] }) },
          'https://example.com/one': {
            status: 200,
            body: page({ title: 'One', links: ['/two'] }),
          },
          // /two is one level too deep and must never be requested.
        },
      }),
    );

    expect(pages(result).map((visited) => visited.depth)).toEqual([0, 1]);
    expect(crawl(result)).toMatchObject({ stoppedBecause: 'depth limit' });
  });

  it('fetches only the starting page at depth zero', async () => {
    const result = await runSiteCrawl(
      { url: HOME, maxDepth: 0 },
      fakePorts({
        robots: '',
        documents: { [HOME]: { status: 200, body: page({ links: ['/about'] }) } },
      }),
    );

    expect(pages(result)).toHaveLength(1);
  });

  it('records a broken link with the page it was found on', async () => {
    // The page it was found on is the half of a broken-link report that makes
    // it fixable.
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({
        robots: '',
        documents: {
          [HOME]: { status: 200, body: page({ links: ['/gone'] }) },
          'https://example.com/gone': { status: 404, body: 'Not found' },
        },
      }),
    );

    expect(structured(result)['broken']).toEqual([
      {
        url: 'https://example.com/gone',
        status: 404,
        reason: 'it answered 404',
        linkedFrom: HOME,
      },
    ]);
    expect(findingCodes(result)).toContain('broken_internal_links');
  });

  it('records a link that would not connect at all', async () => {
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({
        robots: '',
        documents: {
          [HOME]: { status: 200, body: page({ links: ['/dead'] }) },
          'https://example.com/dead': new CheckError('timeout', 'timed out after 15s'),
        },
      }),
    );

    expect(structured(result)['broken']).toMatchObject([{ status: 0, linkedFrom: HOME }]);
  });

  it('finds pages sharing a title, which one page can never tell you', async () => {
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({
        robots: '',
        documents: {
          [HOME]: { status: 200, body: page({ title: 'Home', links: ['/a', '/b'] }) },
          'https://example.com/a': { status: 200, body: page({ title: 'Our services' }) },
          'https://example.com/b': { status: 200, body: page({ title: 'Our services' }) },
        },
      }),
    );

    expect(structured(result)['duplicates']).toMatchObject({
      titles: [{ value: 'Our services', urls: ['https://example.com/a', 'https://example.com/b'] }],
    });
    expect(findingCodes(result)).toContain('duplicate_titles');
    expect(text(result)).toContain('the widest is "Our services" on 2 pages');
  });

  it('does not count two pages with no title as sharing one', async () => {
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({
        robots: '',
        documents: {
          [HOME]: { status: 200, body: page({ title: null, links: ['/a'] }) },
          'https://example.com/a': { status: 200, body: page({ title: null }) },
        },
      }),
    );

    expect(structured(result)['duplicates']).toMatchObject({ titles: [] });
    expect(findingCodes(result)).toContain('pages_without_a_title');
    expect(findingCodes(result)).not.toContain('duplicate_titles');
  });

  it('reports duplicate meta descriptions below duplicate titles', async () => {
    // A shared description costs a written summary. A shared title makes two
    // pages compete for the same search result.
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({
        robots: '',
        documents: {
          [HOME]: {
            status: 200,
            body: page({ title: 'Home', description: 'Same', links: ['/a'] }),
          },
          'https://example.com/a': { status: 200, body: page({ title: 'A', description: 'Same' }) },
        },
      }),
    );

    const findings = structured(result)['findings'] as { code: string; severity: string }[];
    expect(findings).toContainEqual(
      expect.objectContaining({ code: 'duplicate_meta_descriptions', severity: 'info' }),
    );
  });

  it('surfaces a page left asking not to be indexed', async () => {
    // Deliberate on a thank-you page, and a disaster left over from staging.
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({
        robots: '',
        documents: {
          [HOME]: { status: 200, body: page({ links: ['/staging'] }) },
          'https://example.com/staging': {
            status: 200,
            body: page({
              title: 'Staging',
              head: '<meta name="robots" content="noindex,nofollow">',
            }),
          },
        },
      }),
    );

    expect(findingCodes(result)).toContain('pages_asking_not_to_be_indexed');
    expect(text(result)).toContain('https://example.com/staging');
  });

  it('reports a site whose starting page will not load, rather than an empty report', async () => {
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({ robots: '', documents: { [HOME]: { status: 500, body: 'oops' } } }),
    );

    expect(findingCodes(result)).toContain('crawl_found_nothing');
    expect(structured(result)['severity']).toBe('warning');
  });

  it("does not follow a redirect onto another host, under this host's robots.txt", async () => {
    // Found in review. The crawl took its origin from the page in hand rather
    // than from where it was told to start, so one redirect handed it a whole
    // new host to walk — under the robots.txt of the origin it started from,
    // which is to say under nobody's rules. That is principle 4, broken.
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({
        robots: 'User-agent: *\nDisallow: /secret',
        documents: {
          [HOME]: {
            status: 200,
            body: page({ links: ['/hop'] }),
          },
          'https://example.com/hop': {
            status: 200,
            body: page({ title: 'Elsewhere', links: ['/other', '/secret'] }),
            url: 'https://elsewhere.test/',
          },
          // No fixture for anything on elsewhere.test: a request there rejects,
          // so this asserts none was made rather than merely not reported.
        },
      }),
    );

    expect(pages(result).map((visited) => visited.url)).toEqual([HOME]);
    expect(crawl(result)).toMatchObject({ leftTheOrigin: 1 });
    expect(findingCodes(result)).toContain('links_redirect_off_the_site');
  });

  it('counts two addresses that redirect to one page as one page', async () => {
    // Found in review. /a and /a/ both land on /a/, and reporting them as two
    // pages made the tool's headline finding — pages competing for one title —
    // out of a trailing slash.
    const landing = { status: 200, body: page({ title: 'A' }), url: 'https://example.com/a/' };
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({
        robots: '',
        documents: {
          [HOME]: { status: 200, body: page({ title: 'Home', links: ['/a', '/a/'] }) },
          'https://example.com/a': landing,
          'https://example.com/a/': landing,
        },
      }),
    );

    expect(pages(result)).toHaveLength(2);
    expect(structured(result)['duplicates']).toMatchObject({ titles: [] });
    expect(findingCodes(result)).not.toContain('duplicate_titles');
  });

  it('does not claim a depth limit when the whole site was crawled', async () => {
    // Found in review. Every leaf linking back to the homepage set the depth
    // flag, and the report then said it had stopped at the depth limit with
    // zero URLs not visited — a sentence that contradicts itself.
    const result = await runSiteCrawl(
      { url: HOME, maxDepth: 1 },
      fakePorts({
        robots: '',
        documents: {
          [HOME]: { status: 200, body: page({ title: 'Home', links: ['/a'] }) },
          'https://example.com/a': { status: 200, body: page({ title: 'A', links: ['/'] }) },
        },
      }),
    );

    expect(crawl(result)).toMatchObject({
      stoppedBecause: 'nothing left to visit',
      notVisited: 0,
    });
    expect(findingCodes(result)).not.toContain('crawl_incomplete');
  });

  it('counts the links it dropped at the depth limit', async () => {
    const result = await runSiteCrawl(
      { url: HOME, maxDepth: 1 },
      fakePorts({
        robots: '',
        documents: {
          [HOME]: { status: 200, body: page({ title: 'Home', links: ['/a'] }) },
          'https://example.com/a': {
            status: 200,
            body: page({ title: 'A', links: ['/deep', '/deeper'] }),
          },
        },
      }),
    );

    expect(crawl(result)).toMatchObject({ stoppedBecause: 'depth limit', notVisited: 2 });
  });

  it('refuses a URL that is not one', async () => {
    const result = await runSiteCrawl({ url: 'not a url' }, fakePorts({}));

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^invalid_input: /);
  });

  it('refuses a scheme it cannot fetch', async () => {
    const result = await runSiteCrawl({ url: 'ftp://example.com/' }, fakePorts({}));

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('http or https');
  });

  it('follows a redirect and remembers both addresses', async () => {
    const result = await runSiteCrawl(
      { url: HOME },
      fakePorts({
        robots: '',
        documents: {
          [HOME]: { status: 200, body: page({ links: ['/old'] }) },
          'https://example.com/old': {
            status: 200,
            body: page({ title: 'New' }),
            url: 'https://example.com/new',
          },
        },
      }),
    );

    expect(pages(result)[1]).toMatchObject({
      url: 'https://example.com/new',
      requestedUrl: 'https://example.com/old',
    });
  });
});
