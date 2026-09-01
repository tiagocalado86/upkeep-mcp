import { describe, expect, it } from 'vitest';
import { createMemoryHistory, type RunHistory } from '../../src/lib/history.js';
import { CHECK_NAMES, IMPLEMENTED_CHECKS, type CheckName } from '../../src/lib/portfolio.js';
import type { Ports } from '../../src/lib/ports.js';
import { EMPTY_ROBOTS } from '../../src/lib/robots.js';
import { runPortfolioReport } from '../../src/tools/portfolio-report.js';
import {
  NOW,
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
    browser: {
      audit: () => Promise.reject(new Error('no browser fixture')),
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

/** One site's row in the report, typed so the assertions stay readable. */
interface ReportedSite {
  name: string;
  url: string;
  severity: string;
  soonestExpiryDays: number | null;
  notes: string | null;
  findings: { code: string; severity: string; check: string }[];
  checks: { check: string; ran: boolean; severity: string }[];
}

/**
 * @param result A report result.
 * @returns Its sites, in the order the report ranked them.
 */
function sitesOf(result: Awaited<ReturnType<typeof runPortfolioReport>>): ReportedSite[] {
  return structured(result)['sites'] as ReportedSite[];
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

    const sites = sitesOf(result);
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

    const sites = sitesOf(result);
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
    const site = sitesOf(result)[0];
    expect(site?.checks).toEqual([
      expect.objectContaining({ check: 'ssl', ran: false, severity: 'unknown' }),
      expect.objectContaining({ check: 'uptime', ran: true }),
    ]);
    expect(site?.findings.map((item) => item.code)).toEqual(['ssl_check_failed']);
  });

  it('runs only the checks the caller asked for', async () => {
    const result = await runPortfolioReport(
      { sites: [...TWO_SITES], checks: ['uptime'] as CheckName[] },
      portfolioPorts({ 'healthy.example': {}, 'urgent.example': {} }),
    );

    const sites = sitesOf(result);
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
    expect(sitesOf(result)[0]?.name).toBe('Kept');
  });

  it('says so when a tag matches nothing, rather than reporting an empty portfolio', async () => {
    const result = await runPortfolioReport(
      { sites: [...TWO_SITES], tags: ['nonexistent'] },
      portfolioPorts({}),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('nonexistent');
  });

  it('implements every check the portfolio format accepts', () => {
    // While these two lists agree, no site can ask for something that is
    // silently skipped. When they next diverge — a sixth check named before it
    // is built — the report says so in its notes rather than dropping it.
    expect([...IMPLEMENTED_CHECKS].sort()).toEqual([...CHECK_NAMES].sort());
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
      sitesCompared: 0,
      regressed: [],
    });
    // An empty list of regressions must never read as "nothing regressed".
    expect(text(result)).toContain('Nothing comparable in this session yet');
  });

  it('does not invent regressions when the previous run measured different checks', async () => {
    const history = createMemoryHistory();
    const sites = [...TWO_SITES];
    const fixtures = { 'healthy.example': {}, 'urgent.example': { cert: 3 } };

    // The tool's own description recommends this quick pass.
    await runPortfolioReport(
      { sites, checks: ['uptime'] as CheckName[] },
      portfolioPorts(fixtures, { history }),
    );

    const full = await runPortfolioReport({ sites }, portfolioPorts(fixtures, { history }));

    expect(structured(full)['changes']).toMatchObject({
      comparedWithPreviousRun: false,
      sitesCompared: 0,
      regressed: [],
      newFindings: [],
    });
  });

  it('does not announce an improvement when the second run simply looked at less', async () => {
    const history = createMemoryHistory();
    const sites = [...TWO_SITES];
    const fixtures = { 'healthy.example': {}, 'urgent.example': { cert: 3 } };

    await runPortfolioReport({ sites }, portfolioPorts(fixtures, { history }));

    const quick = await runPortfolioReport(
      { sites, checks: ['uptime'] as CheckName[] },
      portfolioPorts(fixtures, { history }),
    );

    // A certificate expiring in three days has not improved just because this
    // run did not look at certificates.
    expect(structured(quick)['changes']).toMatchObject({ sitesCompared: 0, improved: [] });
  });

  it('keeps two sites that share a URL apart in the history', async () => {
    const history = createMemoryHistory();
    const sites = [
      { name: 'Live', url: 'https://shared.example', checks: ['uptime'] as CheckName[] },
      { name: 'Staging entry', url: 'https://shared.example', checks: ['uptime'] as CheckName[] },
    ];

    await runPortfolioReport({ sites }, portfolioPorts({}, { history }));
    const second = await runPortfolioReport({ sites }, portfolioPorts({}, { history }));

    expect(structured(second)['changes']).toMatchObject({ sitesCompared: 2 });
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

  it('says the comparison ran and found nothing, rather than staying silent', async () => {
    const history = createMemoryHistory();
    const sites = [...TWO_SITES];
    const fixtures = { 'healthy.example': {}, 'urgent.example': { cert: 3 } };

    await runPortfolioReport({ sites }, portfolioPorts(fixtures, { history }));
    const second = await runPortfolioReport({ sites }, portfolioPorts(fixtures, { history }));

    expect(structured(second)['changes']).toMatchObject({
      comparedWithPreviousRun: true,
      sitesCompared: 2,
      regressed: [],
      improved: [],
      newFindings: [],
    });
    // Saying nothing is indistinguishable from never having compared.
    expect(text(second)).toContain('No change since');
    expect(text(second)).toContain('2 of 2 sites comparable');
  });

  it('says why the sites it could not compare were not compared', async () => {
    const history = createMemoryHistory();
    const fixtures = { 'healthy.example': {}, 'urgent.example': {}, 'quick.example': {} };
    const quick = {
      name: 'Quick Ltd',
      url: 'https://quick.example',
      checks: ['uptime'] as CheckName[],
    };

    await runPortfolioReport(
      { sites: [...TWO_SITES, quick] },
      portfolioPorts(fixtures, { history }),
    );

    // An uptime-only pass after a full run: only the site that asked for uptime
    // alone both times is comparable, and a fourth site is new.
    const second = await runPortfolioReport(
      {
        sites: [
          ...TWO_SITES,
          quick,
          { name: 'New Ltd', url: 'https://new.example', checks: ['uptime'] as CheckName[] },
        ],
        checks: ['uptime'] as CheckName[],
      },
      portfolioPorts({ ...fixtures, 'new.example': {} }, { history }),
    );

    expect(structured(second)['changes']).toMatchObject({
      sitesCompared: 1,
      sitesMeasuredDifferently: 2,
      sitesNewSincePreviousRun: 1,
    });
    // The count alone reads as a fault. The reason, and the fix, do not.
    expect(text(second)).toContain('1 of 4 sites comparable');
    expect(text(second)).toContain('2 of them measured different checks last time');
    expect(text(second)).toContain('run two full reports back to back');
    expect(text(second)).toContain('1 of them was not in the previous run');
  });

  it('names a finding that appeared without the site changing severity', async () => {
    const history = createMemoryHistory();
    const sites = [
      {
        name: 'Healthy Ltd',
        url: 'https://healthy.example',
        checks: ['domain', 'ssl'] as CheckName[],
      },
    ];

    await runPortfolioReport(
      { sites },
      portfolioPorts({ 'healthy.example': { domainDays: 20 } }, { history }),
    );

    // The registration was already expiring, so the site stays a warning: the
    // certificate is new information the severity cannot carry.
    const second = await runPortfolioReport(
      { sites },
      portfolioPorts({ 'healthy.example': { domainDays: 20, cert: 10 } }, { history }),
    );

    expect(structured(second)['changes']).toMatchObject({
      regressed: [],
      improved: [],
      newFindings: [{ site: 'Healthy Ltd', code: 'cert_expires_soon' }],
    });
    expect(text(second)).toContain('Healthy Ltd: new since the last run');
  });

  it('orders what needs action worst first across the whole portfolio', async () => {
    const result = await runPortfolioReport(
      {
        sites: [
          { name: 'A', url: 'https://a.example', checks: ['domain', 'ssl'] as CheckName[] },
          { name: 'B', url: 'https://b.example', checks: ['ssl'] as CheckName[] },
        ],
      },
      portfolioPorts({
        'a.example': { cert: 2, domainDays: 20 },
        'b.example': { cert: 3 },
      }),
    );

    // A's 20-day registration warning must not print above B's 3-day critical
    // just because A is the more urgent site overall.
    const severities = (structured(result)['needsAttention'] as { severity: string }[]).map(
      (item) => item.severity,
    );
    expect(severities).toEqual(['critical', 'critical', 'warning']);
  });

  it('does not report a site as healthy when none of its checks could run', async () => {
    const result = await runPortfolioReport(
      {
        sites: [{ name: 'Nothing asked', url: 'https://none.example', checks: [] as CheckName[] }],
      },
      portfolioPorts({}),
    );

    const site = sitesOf(result)[0];
    expect(site?.severity).toBe('unknown');
    expect(site?.checks).toEqual([]);
    expect(site?.findings.map((item) => item.code)).toContain('no_checks_ran');
    expect(text(result)).not.toContain('Nothing to do');
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

    expect(sitesOf(result)[0]?.notes).toBe('Renewal is slow to approve.');
  });

  it('spends only the link budget a site asks for', async () => {
    const requested: string[] = [];
    const ports = portfolioPorts({});
    const base = ports.http.hop.bind(ports.http);
    ports.http.hop = (url, timeoutMs, signal) => {
      requested.push(url);
      return base(url, timeoutMs, signal);
    };
    ports.http.text = (url) =>
      Promise.resolve({
        url,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        contentType: 'text/html',
        body: `<html><body>${Array.from(
          { length: 10 },
          (_, index) => `<a href="/p${String(index)}">l</a>`,
        ).join('')}</body></html>`,
        truncated: false,
      });

    await runPortfolioReport(
      {
        sites: [
          {
            name: 'Budgeted',
            url: 'https://budget.example/',
            checks: ['seo'] as CheckName[],
            maxLinks: 3,
          },
        ],
      },
      ports,
    );

    // Ten links on the page, a budget of three: exactly three requested. This
    // is the setting that decides what a portfolio run costs.
    const linkRequests = requested.filter((url) => url.includes('/p'));
    expect(linkRequests).toHaveLength(3);
  });

  it('checks no links at all when a site sets the budget to zero', async () => {
    const requested: string[] = [];
    const ports = portfolioPorts({});
    const base = ports.http.hop.bind(ports.http);
    ports.http.hop = (url, timeoutMs, signal) => {
      requested.push(url);
      return base(url, timeoutMs, signal);
    };
    ports.http.text = (url) =>
      Promise.resolve({
        url,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        contentType: 'text/html',
        body: '<html><body><a href="/a">l</a><a href="/b">l</a></body></html>',
        truncated: false,
      });

    await runPortfolioReport(
      {
        sites: [
          {
            name: 'Fast',
            url: 'https://fast.example/',
            checks: ['seo'] as CheckName[],
            maxLinks: 0,
          },
        ],
      },
      ports,
    );

    expect(requested.filter((url) => url.endsWith('/a') || url.endsWith('/b'))).toEqual([]);
  });
});
