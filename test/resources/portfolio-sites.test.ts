import { describe, expect, it } from 'vitest';
import { describePortfolio } from '../../src/resources/portfolio-sites.js';
import { fakePorts } from '../helpers/fake-ports.js';

/** The resource always answers with JSON; this reads it back. */
function read(text: string): { sites: unknown[]; note?: string; count?: number } {
  return JSON.parse(text) as { sites: unknown[]; note?: string; count?: number };
}

describe('describePortfolio', () => {
  it('lists the portfolio with its defaults applied', async () => {
    const file = JSON.stringify({
      version: 1,
      defaults: { checks: ['uptime'] },
      sites: [{ name: 'Example', url: 'https://www.example.com', tags: ['retainer'] }],
    });

    const document = read(await describePortfolio(fakePorts({ files: { 'sites.json': file } })));

    expect(document.count).toBe(1);
    expect(document.sites[0]).toMatchObject({
      name: 'Example',
      url: 'https://www.example.com/',
      domain: 'example.com',
      checks: ['uptime'],
      tags: ['retainer'],
    });
  });

  it('explains an absent portfolio instead of failing', async () => {
    // A client reading a resource gets a document it can show a person, not a
    // protocol error it has to interpret.
    const document = read(await describePortfolio(fakePorts()));

    expect(document.sites).toEqual([]);
    expect(document.note).toContain('sites.example.json');
  });

  it('explains an unusable portfolio, naming the problem', async () => {
    const document = read(
      await describePortfolio(fakePorts({ files: { 'sites.json': '{ "version": 9 }' } })),
    );

    expect(document.sites).toEqual([]);
    expect(document.note).toContain('unusable');
  });
});
