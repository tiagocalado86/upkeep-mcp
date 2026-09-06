import { describe, expect, it } from 'vitest';
import type { CheckName } from '../../src/lib/portfolio.js';
import { runAxe, type AxeRun } from '../../src/lib/axe.js';
import { CheckError } from '../../src/lib/errors.js';
import { LIMITS, TIMEOUTS } from '../../src/lib/defaults.js';
import { createDefaultPorts } from '../../src/lib/ports.js';
import { decodeSitemapBody, readSitemap } from '../../src/lib/sitemap.js';
import { runDomainCheck } from '../../src/tools/domain-check.js';
import { runAccessibilityAudit } from '../../src/tools/accessibility-audit.js';
import { runPortfolioReport } from '../../src/tools/portfolio-report.js';
import { runSeoAudit } from '../../src/tools/seo-audit.js';
import { runSiteCrawl } from '../../src/tools/site-crawl.js';
import { runSslCheck } from '../../src/tools/ssl-check.js';
import { runUptimeCheck } from '../../src/tools/uptime-check.js';
import { findingCodes, structured, text } from '../helpers/fake-ports.js';

/**
 * Real network checks against control targets.
 *
 * Excluded from CI on purpose: a third party's outage must never fail a build.
 * Run with `npm run test:integration`. Nothing here points at a real client site.
 */
const ports = createDefaultPorts();

describe('ssl_check against badssl.com control certificates', () => {
  it('reports an expired certificate as expired', async () => {
    const result = await runSslCheck({ domain: 'expired.badssl.com' }, ports);

    expect(result.isError).toBeFalsy();
    expect(findingCodes(result)).toContain('cert_expired');
    expect(structured(result)['chain']).toMatchObject({ valid: false, error: 'CERT_HAS_EXPIRED' });
  });

  it('reports a self-signed certificate rather than refusing to look', async () => {
    const result = await runSslCheck({ domain: 'self-signed.badssl.com' }, ports);

    expect(result.isError).toBeFalsy();
    expect(structured(result)['chain']).toMatchObject({
      valid: false,
      error: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
  });

  it('identifies a missing intermediate, the most common real misconfiguration', async () => {
    const result = await runSslCheck({ domain: 'incomplete-chain.badssl.com' }, ports);

    expect(structured(result)['chain']).toMatchObject({
      valid: false,
      error: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
  });

  it('reports an untrusted root', async () => {
    const result = await runSslCheck({ domain: 'untrusted-root.badssl.com' }, ports);

    expect(structured(result)['chain']).toMatchObject({ valid: false });
  });

  it('reports a hostname mismatch as coverage, not as a broken chain', async () => {
    const result = await runSslCheck({ domain: 'wrong.host.badssl.com' }, ports);

    expect(findingCodes(result)).toContain('host_not_covered');
    expect(findingCodes(result)).not.toContain('chain_invalid');
  });

  it('verifies a healthy certificate and walks its chain to the root', async () => {
    const result = await runSslCheck({ domain: 'example.com' }, ports);
    const chain = structured(result)['chain'] as { valid: boolean; length: number };

    expect(chain.valid).toBe(true);
    // The self-signed root points at itself; a walk without a cycle guard would
    // never terminate.
    expect(chain.length).toBeGreaterThan(1);
    expect(chain.length).toBeLessThanOrEqual(12);
  });

  it('fails cleanly against a host that does not resolve', async () => {
    const result = await runSslCheck({ domain: 'this-host-does-not-exist-9x7q.com' }, ports);

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/network|timeout|not_found/);
  });
});

describe('ssl_check revocation against live responders', () => {
  /**
   * @param result A tool result.
   * @returns Its revocation report.
   */
  function revocation(result: Awaited<ReturnType<typeof runSslCheck>>): Record<string, unknown> {
    return structured(result)['revocation'] as Record<string, unknown>;
  }

  it('reads a stapled answer without contacting the authority', async () => {
    // DigiCert staples. This is the free path and the one most large sites take.
    const result = await runSslCheck({ domain: 'digicert.com' }, ports);

    expect(revocation(result)).toMatchObject({
      checked: true,
      status: 'good',
      source: 'stapled',
      signatureVerified: true,
    });
    expect(findingCodes(result)).not.toContain('cert_revoked');
  });

  it('asks the responder when the server staples nothing', async () => {
    // Sectigo issues GitHub's certificate with an OCSP URL and GitHub does not
    // staple, which is exactly the case the direct query exists for.
    const result = await runSslCheck({ domain: 'github.com' }, ports);

    expect(revocation(result)).toMatchObject({ checked: true, status: 'good' });
    expect(revocation(result)['responder']).toMatch(/^https?:\/\//);
  });

  it('finds a revoked certificate that the handshake reports as valid', async () => {
    // The whole point of this feature. SSL.com publishes this host with a
    // certificate revoked on purpose; Node verifies its chain happily, and
    // before revocation checking this tool called it healthy.
    const result = await runSslCheck({ domain: 'revoked-rsa-dv.ssl.com' }, ports);

    expect(structured(result)['chain']).toMatchObject({ valid: true });
    expect(revocation(result)).toMatchObject({
      checked: true,
      status: 'revoked',
      signatureVerified: true,
    });
    expect(findingCodes(result)).toContain('cert_revoked');
    expect(structured(result)['severity']).toBe('critical');
  });

  it("says plainly that a Let's Encrypt certificate cannot be checked at all", async () => {
    // Not a defect and not a finding: since 2025 the issuer publishes no
    // responder, so there is nowhere to ask. A tool that stayed silent here
    // would be implying it had checked.
    const result = await runSslCheck({ domain: 'letsencrypt.org' }, ports);

    expect(revocation(result)).toMatchObject({ checked: false, status: null, responder: null });
    expect(revocation(result)['unavailableReason']).toMatch(/names no OCSP responder/);
    expect(findingCodes(result)).not.toContain('revocation_check_failed');
    expect(structured(result)['severity']).toBe('ok');
  });
});

describe('domain_check against real registries', () => {
  it('reads an expiry date and nameservers for a .com domain', async () => {
    const result = await runDomainCheck({ domain: 'example.com' }, ports);
    const report = structured(result);

    expect(result.isError).toBeFalsy();
    expect(report['registration']).toMatchObject({ source: 'rdap' });
    expect((report['registration'] as { daysUntilExpiry: number }).daysUntilExpiry).toBeGreaterThan(
      0,
    );
    expect((report['dns'] as { ns: string[] }).ns.length).toBeGreaterThan(0);
  });

  it('says plainly that a .de registration has no published expiry date', async () => {
    const result = await runDomainCheck({ domain: 'denic.de' }, ports);
    const registration = structured(result)['registration'] as {
      expiresAt: string | null;
      unavailableReason: string | null;
    };

    expect(result.isError).toBeFalsy();
    expect(registration.expiresAt).toBeNull();
    expect(registration.unavailableReason).toContain('.de');
  });

  it('reads an expiry date for .io through the override map', async () => {
    const result = await runDomainCheck({ domain: 'github.io' }, ports);

    expect(structured(result)['registration']).toMatchObject({ source: 'rdap' });
  });

  it('reports an unregistered domain without crashing', async () => {
    const result = await runDomainCheck({ domain: 'this-domain-does-not-exist-9x7q.com' }, ports);

    expect(result.isError).toBeFalsy();
    expect(findingCodes(result)).toContain('domain_not_registered');
    expect(findingCodes(result)).toContain('domain_does_not_resolve');
  });

  it('handles an internationalised domain end to end', async () => {
    const result = await runDomainCheck({ domain: 'bücher.de' }, ports);

    expect(structured(result)).toMatchObject({
      domain: 'xn--bcher-kva.de',
      unicodeDomain: 'bücher.de',
    });
  });
});

describe('domain_check asking real nameservers over TCP', () => {
  it('gets the same zone serial from every nameserver of a healthy domain', async () => {
    // Cloudflare's nameservers answer TCP and serve one zone from one place, so
    // agreement is the expected answer. This is the case that has to keep
    // working: everything else here is about not crying wolf.
    const result = await runDomainCheck({ domain: 'example.com' }, ports);
    const check = structured(result)['nameservers'] as {
      checked: boolean;
      agree: boolean;
      serials: number[];
      answers: { outcome: string }[];
    };

    expect(check.checked).toBe(true);
    expect(check.answers.every((answer) => answer.outcome === 'authoritative')).toBe(true);
    expect(check.serials).toHaveLength(1);
    expect(check.agree).toBe(true);
    expect(findingCodes(result)).not.toContain('nameservers_disagree');
  });

  it('does not call a domain broken because its nameservers refuse TCP', async () => {
    // sapo.pt's four nameservers all answer UDP and refuse TCP, which RFC 7766
    // forbids and no resolver notices — the domain resolves perfectly. The
    // whole grading exists so that this reads as unestablished rather than as a
    // fault, and it is the one case fixtures would never have surfaced.
    const result = await runDomainCheck({ domain: 'sapo.pt' }, ports);
    const check = structured(result)['nameservers'] as { answers: { outcome: string }[] };
    const codes = findingCodes(result);

    expect(check.answers.every((answer) => answer.outcome !== 'lame')).toBe(true);
    expect(codes).not.toContain('nameserver_not_authoritative');
    expect(codes).not.toContain('nameserver_does_not_resolve');
  });

  it('skips the queries when asked to', async () => {
    const result = await runDomainCheck({ domain: 'example.com', checkNameservers: false }, ports);

    expect(structured(result)['nameservers']).toMatchObject({ checked: false });
  });
});

describe('uptime_check against a real site', () => {
  it('fetches a page and reports its redirect chain', async () => {
    const result = await runUptimeCheck({ url: 'http://github.com' }, ports);
    const report = structured(result);

    expect(result.isError).toBeFalsy();
    expect(report['reachable']).toBe(true);
    expect(report['status']).toBe(200);
    expect(report['https']).toMatchObject({ upgradesToHttps: true });
    expect((report['hsts'] as { present: boolean }).present).toBe(true);
  });
});

describe('seo_audit against a real page', () => {
  it('reads a live page and reports what its markup is missing', async () => {
    const result = await runSeoAudit({ url: 'https://example.com/' }, ports);

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({ fetched: true, status: 200 });
    expect(structured(result)['page']).toMatchObject({ title: 'Example Domain' });
    expect(findingCodes(result)).toContain('meta_description_missing');
  });

  it('reads a sitemap whose name says gzip and whose bytes do not', async () => {
    // A real trap avoided. This URL ends in `.xml.gz`, is declared as the
    // sitemap in that host's robots.txt, and is served as plain `text/xml`:
    // the extension lies. Keying the decision on the name, or on the content
    // type, would try to unpack XML and report a working sitemap as broken.
    // The first two bytes of a gzip member are the only thing here that is not
    // a matter of opinion, so they are what decides.
    const response = await ports.http.bytes(
      'https://www.nytimes.com/sitemaps/new/news.xml.gz',
      TIMEOUTS.supportFileMs,
      LIMITS.maxSupportFileBytes,
    );
    const decoded = await decodeSitemapBody(response.body, response.truncated);

    expect(decoded.compressed).toBe(false);
    expect(decoded.problem).toBeNull();
    expect(readSitemap(decoded.body, response.truncated).kind).toBe('urlset');
  });

  it('finds nothing wrong with the sitemap the protocol publishes about itself', async () => {
    // The rules are checked against a real document here, because that is the
    // only place a false alarm shows up: against fixtures every rule passes by
    // construction. Run against sitemaps.org, nytimes.com, gov.uk,
    // wordpress.org and vercel.com they reported nothing; against
    // cloudflare.com and nodejs.org they reported something true. Only the
    // clean case is pinned, because the others are somebody else's file and a
    // large one is read only as far as the byte cap — nodejs.org's stray hosts
    // sit past it, so a live assertion on them would be an assertion about
    // where a cut lands.
    const url = 'https://www.sitemaps.org/sitemap.xml';
    const response = await ports.http.bytes(
      url,
      TIMEOUTS.supportFileMs,
      LIMITS.maxSupportFileBytes,
    );
    const decoded = await decodeSitemapBody(response.body, response.truncated);
    const reading = readSitemap(decoded.body, response.truncated, url);

    expect(reading.kind).toBe('urlset');
    expect(reading.entryCount).toBeGreaterThan(0);
    expect(reading.defects).toEqual([]);
  });

  it('obeys a robots.txt that forbids it, without requesting the page', async () => {
    // GitHub's robots.txt disallows unknown crawlers on this path. The check is
    // that the tool reports the refusal rather than fetching anyway.
    const result = await runSeoAudit(
      { url: 'https://github.com/search?q=test', checkLinks: false },
      ports,
    );

    expect(result.isError).toBeFalsy();
    expect(structured(result)['fetched']).toBe(false);
    expect(findingCodes(result)).toContain('page_disallowed_by_robots');
  });
});

describe('site_crawl against a real site', () => {
  it('walks a small site and finds what one page cannot say about itself', async () => {
    // sitemaps.org is small, static, and allows crawling. Three of its pages
    // call themselves "sitemaps.org - Home", which is the finding this tool
    // exists for and which auditing any one of them would never produce.
    const result = await runSiteCrawl({ url: 'https://www.sitemaps.org/', maxPages: 8 }, ports);
    const report = structured(result);
    const crawl = report['crawl'] as { pagesFetched: number; stoppedBecause: string };

    expect(result.isError).toBeFalsy();
    expect(crawl.pagesFetched).toBeGreaterThan(1);
    expect((report['pages'] as { url: string }[])[0]?.url).toContain('sitemaps.org');
    // Everything it visited is on the origin it started from.
    for (const page of report['pages'] as { url: string }[]) {
      expect(page.url.startsWith('https://www.sitemaps.org')).toBe(true);
    }
  });

  it('fetches only the starting page when told to go no deeper', async () => {
    const result = await runSiteCrawl({ url: 'https://example.com/', maxDepth: 0 }, ports);

    expect((structured(result)['crawl'] as { pagesFetched: number }).pagesFetched).toBe(1);
  });
});

describe('portfolio_report against real domains', () => {
  it('checks a small portfolio and ranks it, comparing a second run with the first', async () => {
    const sites: { name: string; url: string; checks: CheckName[] }[] = [
      { name: 'Example Ltd', url: 'https://example.com', checks: ['domain', 'ssl', 'uptime'] },
      { name: 'Example Foundation', url: 'https://example.org', checks: ['ssl'] },
    ];

    const first = await runPortfolioReport({ sites }, ports);
    expect(first.isError).toBeFalsy();
    expect(structured(first)).toMatchObject({
      siteCount: 2,
      changes: { comparedWithPreviousRun: false },
    });

    // The second run shares this module's ports, so it has the first to compare
    // against — the in-memory history working end to end.
    const second = await runPortfolioReport({ sites }, ports);
    expect(structured(second)['changes']).toMatchObject({
      comparedWithPreviousRun: true,
      regressed: [],
    });
  }, 60_000);
});

describe('accessibility_audit against a real page in a real browser', () => {
  it('renders a page and reports what axe found', async () => {
    // Skipped rather than failed when no browser is installed: this suite is
    // run by hand, and a missing browser is a machine that has not run
    // `playwright install`, not a broken build.
    const result = await runAccessibilityAudit({ url: 'https://example.com/' }, ports);

    if (result.isError === true) {
      expect(text(result)).toContain('npx playwright install chromium');
      return;
    }

    expect(structured(result)).toMatchObject({ audited: true, standard: 'wcag2aa' });
    expect(structured(result)['pageTitle']).toBe('Example Domain');
    expect(structured(result)['passCount']).toBeGreaterThan(0);
    expect(structured(result)['axeVersion']).toMatch(/^\d+\.\d+\.\d+$/);
  }, 90_000);

  it('still audits a page when every request is put through a policy', async () => {
    // The unit test proves the decision; only a real browser proves the wiring —
    // that intercepting every request does not break navigation or leave the
    // page waiting on a route nobody answered.
    const asked: string[] = [];

    let run: AxeRun;
    try {
      run = await runAxe('https://example.com/', ['wcag2a'], 60_000, (target) => {
        asked.push(target.hostname);
        return Promise.resolve();
      });
    } catch (cause) {
      // A machine that has not run `playwright install`, not a broken build.
      expect(String(cause)).toContain('npx playwright install chromium');
      return;
    }

    expect(run.title).toBe('Example Domain');
    expect(asked).toContain('example.com');
  }, 90_000);

  it('renders nothing from an origin the policy refuses', async () => {
    // Everything is refused, so the navigation itself is aborted. The audit has
    // to fail rather than quietly report a clean page: zero violations found on
    // a page that never loaded is the worst answer this tool could give.
    const run = await runAxe('https://example.com/', ['wcag2a'], 60_000, () =>
      Promise.reject(new Error('refused by policy')),
    ).catch((cause: unknown) => cause);

    expect(run).toBeInstanceOf(CheckError);
    if (!(run instanceof CheckError)) return;
    if (run.message.includes('npx playwright install chromium')) return;
    expect(['network', 'timeout']).toContain(run.code);
  }, 90_000);
});
