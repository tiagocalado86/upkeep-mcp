import { describe, expect, it } from 'vitest';
import { createDefaultPorts } from '../../src/lib/ports.js';
import { runDomainCheck } from '../../src/tools/domain-check.js';
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
