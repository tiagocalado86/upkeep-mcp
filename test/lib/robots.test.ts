import { describe, expect, it } from 'vitest';
import { isAllowed, parseRobots, selectGroup } from '../../src/lib/robots.js';

const TOKEN = 'upkeep-mcp';

/** Convenience: parse and ask in one call, since every case does both. */
function allows(document: string, path: string, token = TOKEN): boolean {
  return isAllowed(parseRobots(document), token, path);
}

describe('parseRobots', () => {
  it('collects sitemaps, which are file-wide rather than per group', () => {
    const robots = parseRobots(
      ['User-agent: *', 'Disallow: /admin', 'Sitemap: https://example.com/sitemap.xml'].join('\n'),
    );

    expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });

  it('ignores comments, blank lines, CRLF and unknown fields', () => {
    const robots = parseRobots(
      [
        '# a comment',
        '',
        'User-agent: *  # trailing',
        'Host: example.com',
        'Disallow: /admin',
      ].join('\r\n'),
    );

    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]?.rules).toHaveLength(1);
    expect(allows(['User-agent: *', 'Disallow: /admin'].join('\r\n'), '/admin')).toBe(false);
  });

  it('reads field names case-insensitively', () => {
    expect(allows(['USER-AGENT: *', 'DISALLOW: /admin'].join('\n'), '/admin')).toBe(false);
  });

  it('reports whether anything was understood, so an HTML error page is not read as rules', () => {
    expect(parseRobots('<!doctype html><h1>Not found</h1>').hasDirectives).toBe(false);
    expect(parseRobots('User-agent: *\nDisallow:').hasDirectives).toBe(true);
  });
});

describe('isAllowed', () => {
  it('allows everything when there are no rules', () => {
    expect(allows('', '/anything')).toBe(true);
    expect(allows('Sitemap: https://example.com/sitemap.xml', '/anything')).toBe(true);
  });

  it('blocks everything under a bare disallow slash', () => {
    expect(allows(['User-agent: *', 'Disallow: /'].join('\n'), '/')).toBe(false);
    expect(allows(['User-agent: *', 'Disallow: /'].join('\n'), '/deep/page')).toBe(false);
  });

  it('treats an empty disallow as "nothing is disallowed", not as a match on everything', () => {
    expect(allows(['User-agent: *', 'Disallow:'].join('\n'), '/anything')).toBe(true);
  });

  it('matches on prefix, so a rule covers everything below it', () => {
    const document = ['User-agent: *', 'Disallow: /private'].join('\n');
    expect(allows(document, '/private')).toBe(false);
    expect(allows(document, '/private/deep/page')).toBe(false);
    expect(allows(document, '/public')).toBe(true);
  });

  it('lets the longest match win, whichever way round it is written', () => {
    const document = ['User-agent: *', 'Disallow: /a', 'Allow: /a/b'].join('\n');
    expect(allows(document, '/a/b/c')).toBe(true);
    expect(allows(document, '/a/c')).toBe(false);

    const reversed = ['User-agent: *', 'Allow: /a/b', 'Disallow: /a'].join('\n');
    expect(allows(reversed, '/a/b/c')).toBe(true);
  });

  it('gives a tie to allow, per RFC 9309 §2.2.2', () => {
    expect(allows(['User-agent: *', 'Disallow: /x', 'Allow: /x'].join('\n'), '/x')).toBe(true);
  });

  it('expands * to any run of characters', () => {
    const document = ['User-agent: *', 'Disallow: /*/draft'].join('\n');
    expect(allows(document, '/blog/draft')).toBe(false);
    expect(allows(document, '/news/2026/draft')).toBe(false);
    expect(allows(document, '/blog/published')).toBe(true);
  });

  it('anchors the end with $', () => {
    const document = ['User-agent: *', 'Disallow: /page$'].join('\n');
    expect(allows(document, '/page')).toBe(false);
    expect(allows(document, '/page/child')).toBe(true);
    expect(allows(document, '/page?x=1')).toBe(true);
  });

  it('combines * and $, the shape every real file uses for file extensions', () => {
    const document = ['User-agent: *', 'Disallow: /*.pdf$'].join('\n');
    expect(allows(document, '/files/report.pdf')).toBe(false);
    expect(allows(document, '/files/report.pdf?download=1')).toBe(true);
    expect(allows(document, '/files/report.html')).toBe(true);
  });

  it('compares a Unicode rule and a percent-encoded path as the same resource', () => {
    const document = ['User-agent: *', 'Disallow: /café/'].join('\n');
    expect(allows(document, '/caf%C3%A9/menu')).toBe(false);
    expect(allows(document, '/cafe/menu')).toBe(true);
  });

  it('obeys a group naming this crawler in preference to the catch-all', () => {
    const document = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: upkeep-mcp',
      'Disallow: /admin',
    ].join('\n');

    expect(allows(document, '/pricing')).toBe(true);
    expect(allows(document, '/admin')).toBe(false);
  });

  it('obeys only the most specific token when two groups both match', () => {
    const document = [
      'User-agent: upkeep',
      'Disallow: /',
      '',
      'User-agent: upkeep-mcp',
      'Disallow: /admin',
    ].join('\n');

    // The second block was written for us specifically; merging both would
    // apply rules meant for a different crawler.
    expect(allows(document, '/pricing')).toBe(true);
    expect(allows(document, '/admin')).toBe(false);
  });

  it('merges two groups that name the same token, rather than taking the first', () => {
    const document = [
      'User-agent: upkeep-mcp',
      'Disallow: /admin',
      '',
      'User-agent: upkeep-mcp',
      'Disallow: /internal',
    ].join('\n');

    expect(allows(document, '/admin')).toBe(false);
    expect(allows(document, '/internal')).toBe(false);
    expect(allows(document, '/public')).toBe(true);
  });

  it('applies one group to every user-agent in a consecutive run', () => {
    const document = ['User-agent: googlebot', 'User-agent: upkeep-mcp', 'Disallow: /admin'].join(
      '\n',
    );

    expect(allows(document, '/admin')).toBe(false);
    expect(allows(document, '/admin', 'somebot')).toBe(true);
  });

  it('attributes rules written before any user-agent line to everyone', () => {
    // A common authoring mistake. Ignoring it would let us crawl what the
    // author plainly meant to close off.
    expect(allows('Disallow: /admin', '/admin')).toBe(false);
  });

  it('is unaffected by a group addressed at another crawler', () => {
    const document = ['User-agent: googlebot', 'Disallow: /'].join('\n');
    expect(allows(document, '/anything')).toBe(true);
  });

  it('does not hang on a pattern built to make a regular expression backtrack', () => {
    const document = ['User-agent: *', `Disallow: /${'*a'.repeat(24)}b`].join('\n');
    const path = `/${'a'.repeat(2000)}`;

    const startedAt = performance.now();
    expect(allows(document, path)).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });
});

describe('selectGroup', () => {
  it('returns null when the file has no group that could apply', () => {
    expect(selectGroup(parseRobots('User-agent: googlebot\nDisallow: /'), TOKEN)).toBeNull();
  });

  it('reads crawl-delay and keeps the slower value when groups merge', () => {
    const document = [
      'User-agent: upkeep-mcp',
      'Crawl-delay: 2',
      '',
      'User-agent: upkeep-mcp',
      'Crawl-delay: 10',
    ].join('\n');

    expect(selectGroup(parseRobots(document), TOKEN)?.crawlDelaySeconds).toBe(10);
  });
});
