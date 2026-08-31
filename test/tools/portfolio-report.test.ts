import { describe, expect, it } from 'vitest';
import { createMemoryHistory, type RunHistory } from '../../src/lib/history.js';
import type { CheckName } from '../../src/lib/portfolio.js';
import type { Ports } from '../../src/lib/ports.js';
import { EMPTY_ROBOTS } from '../../src/lib/robots.js';
import { runPortfolioReport } from '../../src/tools/portfolio-report.js';
import {
  NOW,
  findingCodes,
  healthyDns,
  inspection,
  registration,
  structured,
  text,
} from '../helpers/fake-ports.js';

/** How one site behaves, for a portfolio-sized fake. */
interface SiteFixture {
  /** Days until the certificate expires. `'unreachable'` fails the handshake. */
  cert?: number | 'unreachable';
  /** Days until the registration expires. */
  domainDays?: number;
  /** Status the site answers with. */
  status?: number;
}

/** A date `days` from the fixed test clock. */
function inDays(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString();
}

/**
 * Ports that answer differently per host, which is what a portfolio needs and
 * the single-site fakes deliberately do not do.
 */
function portfolioPorts(
  fixtures: Record<string, SiteFixture>,
  options: { history?: RunHistory; files?: Record<string, string> } = {},
): Ports {
  const forHost = (host: string): SiteFixture => fixtures[host.replace(/^www\./, '')] ?? {};

  return {
    dns: {
      resolveRecords: () => Promise.resolve(healthyDns()),
      hasDsRecord: () => Promise.resolve(true),
    },
    rdap: {
      lookupDomain: (domain) => {
        const days = forHost(domain).domainDays ?? 300;
        return Promise.resolve({
          registration: registration({ expiresAt: inDays(days), daysUntilExpiry: days }),
          delegationSigned: true,
        });
      },
    },
    tls: {
      inspect: (host) => {
        const fixture = forHost(host);
        if (fixture.cert === 'unreachable') {
          return Promise.reject(new Error('handshake refused'));
        }
        const days = fixture.cert ?? 90;
        return Promise.resolve(
          inspection({
            leaf: { validTo: inDays(days) },
            hostMatches: {
              [host]: host,
              [host.replace(/^www\./, '')]: host,
              [`www.${host.replace(/^www\./, '')}`]: host,
            },
          }),
        );
      },
    },
    http: {
      hop: (url) => {
        const target = new URL(url);
        const status = forHost(target.hostname).status ?? 200;
        // A site with nothing wrong: uptime_check reports on missing security
        // headers, so a fixture without them would never come out clean.
        const headers = new Headers({
          'strict-transport-security': 'max-age=31536000',
          'content-security-policy': "default-src 'self'",
          'x-content-type-options': 'nosniff',
        });
        // Plain HTTP always upgrades, so the only uptime finding a fixture can
        // produce is the one it asked for.
        if (target.protocol === 'http:') {
          const https = `https://${target.host}${target.pathname}`;
          headers.set('location', https);
          return Promise.resolve({ url, status: 301, headers, location: https, elapsedMs: 5 });
        }
        return Promise.resolve({ url, status, headers, location: null, elapsedMs: 5 });
      },
      text: () => Promise.reject(new Error('no document fixture')),
    },
    robots: {
      forOrigin: (origin) =>
        Promise.resolve({
          url: new URL('/robots.txt', origin).toString(),
          availability: 'absent' as const,
          status: 404,
          robots: EMPTY_ROBOTS,
        }),
    },
    files: {
      readText: (path) => {
        const contents = options.files?.[path];
        return contents === undefined
          ? Promise.reject(new Error(`there is no file at ${path}`))
          : Promise.resolve(contents);
      },
    },
    history: options.history ?? createMemoryHistory(),
    now: () => NOW,
  };
}

const ALL_THREE: CheckName[] = ['domain', 'ssl', 'uptime'];

const TWO_SITES = [
  { name: 'Healthy Ltd', url: 'https://healthy.example', checks: ALL_THREE },
  { name: 'Urgent Ltd', url: 'https://urgent.example', checks: ALL_THREE },
];

describe('runPortfolioReport', () => {
  it('reports a portfolio with nothing wrong', async () => {
    const result = await runPortfolioReport(
      { sites: [...TWO_SITES] },
      portfolioPorts({ 'healthy.example': {}, 'urgent.example': {} }),
    );

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      source: 'inline',
      file: null,
      siteCount: 2,
      severity: 'ok',
      summary: { critical: 0, warning: 0, ok: 2 },
      needsAttention: [],
    });
    expect(text(result)).toContain('Nothing to do: Healthy Ltd, Urgent Ltd.');
  });

  it('puts the most urgent site first, whatever order the file lists them in', async () => {
    const result = await runPortfolioReport(
      { sites: [...TWO_SITES] },
      portfolioPorts({
        'healthy.example': {},
        'urgent.example': { status: 500, cert: 3 },
      }),
    );

    const sites = structured(result)['sites'] as { name: string; severity: string }[];
    expect(sites[0]).toMatchObject({ name: 'Urgent Ltd', severity: 'critical' });
    expect(sites[1]).toMatchObject({ name: 'Healthy Ltd', severity: 'ok' });
    expect(structured(result)['severity']).toBe('critical');
  });

  it('orders two equally bad sites by whichever expires first', async () => {
    const result = await runPortfolioReport(
      {
        sites: [
          { name: 'Later', url: 'https://later.example', checks: ['ssl'] as CheckName[] },
          { name: 'Sooner', url: 'https://sooner.example', checks: ['ssl'] as CheckName[] },
        ],
      },
      portfolioPorts({ 'later.example': { cert: 12 }, 'sooner.example': { cert: 9 } }),
    );

    const sites = structured(result)['sites'] as { name: string; soonestExpiryDays: number }[];
    expect(sites.map((site) => site.name)).toEqual(['Sooner', 'Later']);
    expect(sites[0]?.soonestExpiryDays).toBe(9);
  });

  it('lists only what needs acting on, tagged with the check that found it', async () => {
    const result = await runPortfolioReport(
      {
        sites: [
          {
            name: 'Urgent Ltd',
            url: 'https://urgent.example',
            checks: ['ssl', 'uptime'] as CheckName[],
          },
        ],
      },
      portfolioPorts({ 'urgent.example': { cert: 3 } }),
    );

    expect(structured(result)['needsAttention']).toEqual([
      {
        site: 'Urgent Ltd',
        url: 'https://urgent.example/',
        check: 'ssl',
        code: 'cert_expires_soon',
        severity: 'critical',
        message: 'The certificate expires in 3 days.',
      },
    ]);
  });

  it('turns a check that could not run into a finding, keeping the other checks', async () => {
    const result = await runPortfolioReport(
      {
        sites: [
          {
            name: 'Partial',
            url: 'https://partial.example',
            checks: ['ssl', 'uptime'] as CheckName[],
          },
        ],
      },
      portfolioPorts({ 'partial.example': { cert: 'unreachable' } }),
    );

    expect(result.isError).toBeFalsy();
    const site = (
      structured(result)['sites'] as { checks: { check: string; ran: boolean }[] }[]
    )[0];
    expect(site?.checks).toEqual([
      expect.objectContaining({ check: 'ssl', ran: false, severity: 'unknown' }),
      expect.objectContaining({ check: 'uptime', ran: true }),
    ]);
    expect(findingCodes(result)).toEqual([]);
  });

  it('runs only the checks the caller asked for', async () => {
    const result = await runPortfolioReport(
      { sites: [...TWO_SITES], checks: ['uptime'] as CheckName[] },
      portfolioPorts({ 'healthy.example': {}, 'urgent.example': {} }),
    );

    const sites = structured(result)['sites'] as { checks: { check: string }[] }[];
    expect(sites.every((site) => site.checks.every((check) => check.check === 'uptime'))).toBe(
      true,
    );
  });

  it('reports on part of the portfolio when given tags', async () => {
    const result = await runPortfolioReport(
      {
        sites: [
          {
            name: 'Kept',
            url: 'https://kept.example',
            tags: ['Retainer'],
            checks: ['uptime'] as CheckName[],
          },
          {
            name: 'Dropped',
            url: 'https://dropped.example',
            tags: ['legacy'],
            checks: ['uptime'] as CheckName[],
          },
        ],
        tags: ['retainer'],
      },
      portfolioPorts({}),
    );

    expect(structured(result)['siteCount']).toBe(1);
    expect((structured(result)['sites'] as { name: string }[])[0]?.name).toBe('Kept');
  });

  it('says so when a tag matches nothing, rather than reporting an empty portfolio', async () => {
    const result = await runPortfolioReport(
      { sites: [...TWO_SITES], tags: ['nonexistent'] },
      portfolioPorts({}),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('nonexistent');
  });

  it('names a requested check that does not exist yet instead of ignoring it', async () => {
    const result = await runPortfolioReport(
      {
        sites: [
          {
            name: 'A',
            url: 'https://a.example',
            checks: ['uptime', 'accessibility'] as CheckName[],
          },
          { name: 'B', url: 'https://b.example', checks: ['accessibility'] as CheckName[] },
        ],
      },
      portfolioPorts({}),
    );

    const notes = structured(result)['notes'] as string[];
    expect(notes[0]).toContain('accessibility was requested by 2 sites');
    expect(text(result)).toContain('accessibility');
  });

  it('reads the portfolio from a file when given no sites inline', async () => {
    const file = JSON.stringify({
      version: 1,
      defaults: { checks: ['uptime'] as CheckName[] },
      sites: [{ name: 'From file', url: 'https://filed.example' }],
    });

    const result = await runPortfolioReport(
      {},
      portfolioPorts({}, { files: { 'sites.json': file } }),
    );

    expect(structured(result)).toMatchObject({ source: 'file', file: 'sites.json', siteCount: 1 });
  });

  it('tells the caller how to fix a missing portfolio file', async () => {
    const result = await runPortfolioReport({}, portfolioPorts({}));

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('sites.example.json');
  });

  it('reports an unusable portfolio file as invalid input, naming the file', async () => {
    const result = await runPortfolioReport(
      { file: 'broken.json' },
      portfolioPorts({}, { files: { 'broken.json': '{ oops' } }),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('invalid_input');
    expect(text(result)).toContain('broken.json');
  });

  it('has nothing to compare against on the first run, and says so', async () => {
    const result = await runPortfolioReport(
      { sites: [...TWO_SITES] },
      portfolioPorts({ 'healthy.example': {}, 'urgent.example': {} }),
    );

    expect(structured(result)['changes']).toMatchObject({
      comparedWithPreviousRun: false,
      previousRunAt: null,
      regressed: [],
    });
    // An empty list of regressions must never read as "nothing regressed".
    expect(text(result)).toContain('nothing to compare against');
  });

  it('reports what got worse and what got better since the previous run', async () => {
    const history = createMemoryHistory();
    const sites = [...TWO_SITES];

    await runPortfolioReport(
      { sites },
      portfolioPorts({ 'healthy.example': {}, 'urgent.example': { cert: 3 } }, { history }),
    );

    const second = await runPortfolioReport(
      { sites },
      portfolioPorts({ 'healthy.example': { status: 500 }, 'urgent.example': {} }, { history }),
    );

    expect(structured(second)['changes']).toMatchObject({
      comparedWithPreviousRun: true,
      previousRunAt: NOW.toISOString(),
      regressed: [{ site: 'Healthy Ltd', from: 'ok', to: 'critical' }],
      improved: [{ site: 'Urgent Ltd', from: 'critical', to: 'ok' }],
      newFindings: [{ site: 'Healthy Ltd', code: 'server_error' }],
    });
    expect(text(second)).toContain('Healthy Ltd got worse');
  });

  it('carries the notes from the portfolio file into the report', async () => {
    const result = await runPortfolioReport(
      {
        sites: [
          {
            name: 'Noted',
            url: 'https://noted.example',
            checks: ['uptime'],
            notes: 'Renewal is slow to approve.',
          },
        ],
      },
      portfolioPorts({}),
    );

    expect((structured(result)['sites'] as { notes: string }[])[0]?.notes).toBe(
      'Renewal is slow to approve.',
    );
  });
});
