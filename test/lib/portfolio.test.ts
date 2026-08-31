import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { filterByTags, readPortfolio, readPortfolioText } from '../../src/lib/portfolio.js';

/** The smallest file that parses, as a base for cases to override. */
function file(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    sites: [{ name: 'Example', url: 'https://www.example.com' }],
    ...overrides,
  };
}

describe('readPortfolio', () => {
  it('applies the project defaults to a minimal entry', () => {
    const result = readPortfolio(file());

    expect(result).toMatchObject({
      ok: true,
      sites: [
        {
          name: 'Example',
          url: 'https://www.example.com/',
          domain: 'example.com',
          checks: ['domain', 'ssl', 'uptime'],
          expiryWarningDays: 30,
          tags: [],
          notes: null,
        },
      ],
    });
  });

  it("lets the file's defaults override the project's, and a site override both", () => {
    const result = readPortfolio(
      file({
        defaults: { checks: ['uptime'], expiryWarningDays: 45 },
        sites: [
          { name: 'Inherits', url: 'https://a.example.com' },
          {
            name: 'Overrides',
            url: 'https://b.example.com',
            checks: ['ssl'],
            expiryWarningDays: 7,
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      sites: [
        { name: 'Inherits', checks: ['uptime'], expiryWarningDays: 45 },
        { name: 'Overrides', checks: ['ssl'], expiryWarningDays: 7 },
      ],
    });
  });

  it('derives the registrable domain from a subdomain, and honours an explicit one', () => {
    const result = readPortfolio(
      file({
        sites: [
          { name: 'Shop', url: 'https://shop.example.co.uk/catalogue' },
          { name: 'Pinned', url: 'https://shop.example.co.uk', domain: 'other.example' },
        ],
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      sites: [{ domain: 'example.co.uk' }, { domain: 'other.example' }],
    });
  });

  it('accepts a bare host and reads it over HTTPS', () => {
    const result = readPortfolio(file({ sites: [{ name: 'Bare', url: 'example.org' }] }));

    expect(result).toMatchObject({ ok: true, sites: [{ url: 'https://example.org/' }] });
  });

  it('rejects the whole file for one unusable site, naming it', () => {
    // A report quietly missing a site is worse than one that does not run: the
    // reader has no way to notice the absence.
    const result = readPortfolio(
      file({
        sites: [
          { name: 'Good', url: 'https://example.com' },
          { name: 'Bad', url: 'not a url at all' },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('Bad');
  });

  it('rejects an IP address, which has no registration to check', () => {
    const result = readPortfolio(file({ sites: [{ name: 'Box', url: 'https://192.0.2.1' }] }));

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('domain');
  });

  it('rejects a file with no sites, a wrong version, or an unknown check', () => {
    expect(readPortfolio(file({ sites: [] })).ok).toBe(false);
    expect(readPortfolio(file({ version: 2 })).ok).toBe(false);
    expect(
      readPortfolio(file({ sites: [{ name: 'X', url: 'https://x.example', checks: ['dns'] }] })).ok,
    ).toBe(false);
  });

  it('names where the problem is', () => {
    const result = readPortfolio(file({ sites: [{ url: 'https://example.com' }] }));

    expect(result.ok ? '' : result.reason).toContain('sites.0.name');
  });

  it('ignores keys it does not know, so a file can carry its own comments', () => {
    const result = readPortfolio(file({ _comment: ['notes to self'] }));

    expect(result.ok).toBe(true);
  });
});

describe('readPortfolioText', () => {
  it('reports a JSON syntax error as one, with the parser message', () => {
    const result = readPortfolioText('{ "version": 1, }');

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('not valid JSON');
  });

  it('parses the example file shipped in the repository', () => {
    // sites.example.json is the documentation for this format. If it stops
    // parsing, the documentation is lying.
    const result = readPortfolioText(readFileSync('sites.example.json', 'utf8'));

    expect(result.ok).toBe(true);
    expect(result.ok ? result.sites.length : 0).toBe(4);
    expect(result.ok ? result.sites[2] : null).toMatchObject({
      name: 'Example Foundation — Shop',
      domain: 'example.org',
    });
  });
});

describe('filterByTags', () => {
  const sites = readPortfolio(
    file({
      sites: [
        { name: 'A', url: 'https://a.example', tags: ['Retainer', 'monthly'] },
        { name: 'B', url: 'https://b.example', tags: ['legacy'] },
        { name: 'C', url: 'https://c.example' },
      ],
    }),
  );
  const list = sites.ok ? sites.sites : [];

  it('keeps everything when no tag is given', () => {
    expect(filterByTags(list, [])).toHaveLength(3);
  });

  it('matches case-insensitively', () => {
    expect(filterByTags(list, ['retainer']).map((site) => site.name)).toEqual(['A']);
  });

  it('keeps a site carrying any of the tags', () => {
    expect(filterByTags(list, ['legacy', 'monthly']).map((site) => site.name)).toEqual(['A', 'B']);
  });

  it('returns nothing when no site carries the tag', () => {
    expect(filterByTags(list, ['nonexistent'])).toEqual([]);
  });
});
