import { describe, expect, it } from 'vitest';
import { extractPage, nestsTooDeeply } from '../src/lib/html.js';
import { readPortfolioText } from '../src/lib/portfolio.js';
import { isAllowed, parseRobots } from '../src/lib/robots.js';
import { readSitemap } from '../src/lib/sitemap.js';
import { normaliseUrl } from '../src/lib/url.js';
import { runDomainCheck } from '../src/tools/domain-check.js';
import { runPortfolioReport } from '../src/tools/portfolio-report.js';
import { runSeoAudit } from '../src/tools/seo-audit.js';
import { runSslCheck } from '../src/tools/ssl-check.js';
import { runUptimeCheck } from '../src/tools/uptime-check.js';
import { fakePorts } from './helpers/fake-ports.js';

/**
 * Hostile and merely strange input, everywhere it can get in.
 *
 * The project's rule is that no exception crosses the MCP boundary and that
 * nothing runs without a deadline. Both are claims about inputs nobody thought
 * of, so they are asserted against inputs nobody would type.
 */
const NASTY: string[] = [
  '',
  '   ',
  '\n\t',
  '.',
  '..',
  '../../etc/passwd',
  '-',
  'a'.repeat(5000),
  `${'sub.'.repeat(200)}example.com`,
  'exa mple.com',
  'https://',
  'http://',
  'https:///path',
  'http://[::1]/',
  'https://user:hunter2@example.com/',
  'https://example.com:99999/',
  'javascript:alert(1)',
  'file:///etc/passwd',
  'data:text/html,<h1>x</h1>',
  'ftp://example.com/',
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  'exemplo.teste',
  'https://xn--e1afmkfd.xn--p1ai/path',
  'xn--e1afmkfd.xn--p1ai',
  'café.pt',
  ' example.com',
  'example.com .evil.test',
  'https://example.com/%2e%2e/%2e%2e/',
  'https://example.com/?q=<script>alert(1)</script>',
  'HTTPS://EXAMPLE.COM/',
  'example.com.',
  '.example.com',
  'example..com',
];

/** Every tool, reduced to "give it a string, get a result". */
const TOOLS: [string, (value: string) => Promise<unknown>][] = [
  ['domain_check', (value) => runDomainCheck({ domain: value }, fakePorts())],
  ['ssl_check', (value) => runSslCheck({ domain: value }, fakePorts())],
  ['uptime_check', (value) => runUptimeCheck({ url: value }, fakePorts())],
  ['seo_audit', (value) => runSeoAudit({ url: value }, fakePorts())],
  [
    'portfolio_report',
    (value) => runPortfolioReport({ sites: [{ name: 'X', url: value }] }, fakePorts()),
  ],
];

describe('no input makes a handler throw', () => {
  it.each(TOOLS)(
    '%s survives every hostile input',
    async (_name, run) => {
      for (const value of NASTY) {
        const result = (await run(value).catch((cause: unknown) => {
          throw new Error(`threw on ${JSON.stringify(value)}: ${String(cause)}`);
        })) as { content?: unknown[] };

        // Whatever it decides, it must decide it as a result.
        expect(Array.isArray(result.content), `no content for ${JSON.stringify(value)}`).toBe(true);
      }
    },
    30_000,
  );
});

describe('parsers survive documents written to break them', () => {
  it('does not hang on a robots.txt built from wildcards', () => {
    const document = ['User-agent: *', `Disallow: /${'*a'.repeat(60)}b`].join('\n');
    const robots = parseRobots(document);

    const startedAt = performance.now();
    expect(isAllowed(robots, 'upkeep-mcp', `/${'a'.repeat(5000)}`)).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(2000);
  });

  it('reads a very long robots.txt without complaint', () => {
    const document = [
      'User-agent: *',
      ...Array.from({ length: 20_000 }, (_, index) => `Disallow: /p${String(index)}`),
    ].join('\n');

    const robots = parseRobots(document);
    expect(isAllowed(robots, 'upkeep-mcp', '/p19999')).toBe(false);
    expect(isAllowed(robots, 'upkeep-mcp', '/elsewhere')).toBe(true);
  });

  it('treats binary noise as a file with no directives', () => {
    const noise = Array.from({ length: 500 }, (_, index) =>
      String.fromCharCode((index * 977) % 60_000),
    ).join('');

    expect(parseRobots(noise).hasDirectives).toBe(false);
    expect(isAllowed(parseRobots(noise), 'upkeep-mcp', '/')).toBe(true);
  });

  it('reads deeply nested HTML without blowing the stack', () => {
    // The traversal is iterative on purpose; a recursive one would not survive
    // this, and real pages do nest a few dozen levels.
    const html = `${'<div>'.repeat(1500)}<h1>Deep</h1>${'</div>'.repeat(1500)}`;

    const page = extractPage(html, 'https://example.com/');
    expect(page.headings).toEqual([{ level: 1, text: 'Deep' }]);
  });

  it('refuses a document nested deeply enough to hang the parser', () => {
    // Tree construction costs the square of the depth, and two mebibytes of
    // `<div>` is four hundred thousand levels. Measuring is cheap; parsing is
    // not, and a synchronous parse cannot be interrupted once it starts.
    const absurd = '<div>'.repeat(50_000);

    const startedAt = performance.now();
    expect(nestsTooDeeply(absurd)).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(200);

    expect(nestsTooDeeply(`${'<div>'.repeat(50)}<p>ordinary</p>`)).toBe(false);
    // Comments and doctypes open nothing, so they must not count as depth.
    expect(nestsTooDeeply(`<!doctype html>${'<!-- c -->'.repeat(5000)}`)).toBe(false);
  });

  it('reads a document that closes nothing and nests wrongly', () => {
    const html = '<html><body><p><h1>Title<div><span><img src=/a.png><table><tr><td>x';

    expect(() => extractPage(html, 'https://example.com/')).not.toThrow();
  });

  it('survives a page with thousands of links and images', () => {
    const html = Array.from(
      { length: 5000 },
      (_, index) => `<a href="/p${String(index)}">l</a><img src="/i${String(index)}.png">`,
    ).join('');

    const page = extractPage(html, 'https://example.com/');
    expect(page.links).toHaveLength(5000);
    expect(page.images).toHaveLength(5000);
  });

  it('handles a sitemap that is enormous, empty, or not a sitemap', () => {
    const huge = `<urlset>${'<url><loc>https://example.com/a</loc></url>'.repeat(20_000)}</urlset>`;

    expect(readSitemap(huge, false).entryCount).toBe(20_000);
    expect(readSitemap('', false).kind).toBe('unknown');
    expect(readSitemap(' <urlset>', false).kind).toBe('urlset');
    expect(() => readSitemap('<loc>'.repeat(10_000), false)).not.toThrow();
  });

  it('refuses a portfolio of the wrong shape without throwing', () => {
    for (const text of [
      '',
      'null',
      '[]',
      '"a string"',
      '{"version":1}',
      '{"version":1,"sites":"not an array"}',
      '{"version":1,"sites":[{"name":123,"url":"https://example.com"}]}',
      `{"version":1,"sites":[{"name":"x","url":"${'a'.repeat(5000)}"}]}`,
    ]) {
      expect(readPortfolioText(text).ok, `accepted ${text.slice(0, 40)}`).toBe(false);
    }
  });

  it('never returns a URL it cannot make sense of', () => {
    for (const value of NASTY) {
      const url = normaliseUrl(value);
      if (url === null) continue;
      // Anything it does return must survive a round trip and name a host.
      expect(() => new URL(url.toString())).not.toThrow();
      expect(url.hostname).not.toBe('');
    }
  });
});
