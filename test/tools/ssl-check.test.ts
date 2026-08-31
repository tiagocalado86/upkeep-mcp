import { describe, expect, it } from 'vitest';
import { CheckError } from '../../src/lib/errors.js';
import { runSslCheck } from '../../src/tools/ssl-check.js';
import {
  fakePorts,
  findingCodes,
  healthyDns,
  inspection,
  structured,
  text,
} from '../helpers/fake-ports.js';

describe('runSslCheck', () => {
  it('reports a healthy certificate with nothing to act on', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({ tls: inspection(), dnsRecords: healthyDns() }),
    );

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      host: 'example.com',
      port: 443,
      issuer: 'R11',
      daysUntilExpiry: 91,
      severity: 'ok',
    });
    expect(findingCodes(result)).toEqual([]);
  });

  it('states plainly that revocation was not checked', async () => {
    // Node performs no CRL or OCSP lookup, so a revoked certificate verifies
    // cleanly. Saying so is the honest option.
    const result = await runSslCheck({ domain: 'example.com' }, fakePorts({ tls: inspection() }));

    expect(structured(result)['chain']).toMatchObject({ revocationChecked: false });
    expect(text(result)).toContain('Revocation is not checked');
  });

  it('uses the port it was given', async () => {
    const result = await runSslCheck(
      { domain: 'example.com', port: 8443 },
      fakePorts({ tls: inspection() }),
    );
    expect(structured(result)['port']).toBe(8443);
  });

  it('reports an expired certificate', async () => {
    const result = await runSslCheck(
      { domain: 'expired.example.com' },
      fakePorts({
        tls: inspection({
          leaf: { validTo: '2015-04-12T23:59:59.000Z' },
          chain: { valid: false, error: 'CERT_HAS_EXPIRED' },
          hostMatches: { 'expired.example.com': '*.example.com' },
        }),
      }),
    );

    expect(findingCodes(result)).toEqual(expect.arrayContaining(['cert_expired', 'chain_invalid']));
    expect(structured(result)['severity']).toBe('critical');
  });

  it('leaves a certificate 24 days out alone, because that is a normal ACME renewal', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        tls: inspection({ leaf: { validTo: '2026-09-25T00:00:00.000Z' } }),
      }),
    );

    expect(structured(result)['daysUntilExpiry']).toBe(24);
    expect(findingCodes(result)).not.toContain('cert_expires_soon');
    expect(structured(result)['severity']).toBe('ok');
  });

  it('warns once the automatic renewal should already have happened', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        tls: inspection({ leaf: { validTo: '2026-09-12T00:00:00.000Z' } }),
      }),
    );

    expect(structured(result)['daysUntilExpiry']).toBe(11);
    expect(findingCodes(result)).toContain('cert_expires_soon');
    expect(structured(result)['severity']).toBe('warning');
  });

  it('reports an unreadable expiry date as unknown rather than as nothing wrong', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({ tls: inspection({ leaf: { validTo: null } }) }),
    );

    expect(structured(result)['daysUntilExpiry']).toBeNull();
    expect(findingCodes(result)).toContain('cert_dates_unavailable');
    expect(structured(result)['severity']).toBe('unknown');
  });

  it('names a missing intermediate for what it is', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        tls: inspection({ chain: { valid: false, error: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }),
      }),
    );

    expect(findingCodes(result)).toContain('chain_invalid');
    expect(text(result)).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  });

  it('describes a hostname mismatch once, and not as a broken chain', async () => {
    const result = await runSslCheck(
      { domain: 'wrong.example.com' },
      fakePorts({
        tls: inspection({
          chain: { valid: false, error: 'ERR_TLS_CERT_ALTNAME_INVALID' },
          hostMatches: { 'wrong.example.com': null, 'example.com': null, 'www.example.com': null },
        }),
      }),
    );

    expect(findingCodes(result)).toEqual(['host_not_covered']);
    expect(text(result)).toContain('verifies, but not for this hostname');
  });

  it('reports which SAN entry matched', async () => {
    const result = await runSslCheck(
      { domain: 'shop.example.com' },
      fakePorts({
        tls: inspection({ hostMatches: { 'shop.example.com': '*.example.com' } }),
      }),
    );

    expect(structured(result)['coverage']).toMatchObject({
      coversRequestedHost: true,
      matchedVia: '*.example.com',
    });
    expect(text(result)).toContain('matched via *.example.com');
  });

  it('warns about missing www coverage only when www resolves', async () => {
    const missingWww = inspection({
      hostMatches: { 'example.com': 'example.com', 'www.example.com': null },
    });

    const resolves = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({ tls: missingWww, dnsRecords: healthyDns() }),
    );
    expect(findingCodes(resolves)).toContain('www_not_covered');

    const doesNot = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({ tls: missingWww, dnsRecords: healthyDns({ wwwResolves: false }) }),
    );
    expect(findingCodes(doesNot)).toEqual([]);
  });

  it('warns when the certificate covers www but not the apex', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        tls: inspection({
          hostMatches: { 'example.com': null, 'www.example.com': 'www.example.com' },
        }),
        dnsRecords: healthyDns(),
      }),
    );

    expect(findingCodes(result)).toContain('apex_not_covered');
  });

  it('warns about an outdated TLS version', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({ tls: inspection({ protocol: 'TLSv1' }) }),
    );

    expect(findingCodes(result)).toContain('tls_version_outdated');
  });

  it('accepts TLS 1.2 and 1.3 without comment', async () => {
    for (const protocol of ['TLSv1.2', 'TLSv1.3']) {
      const result = await runSslCheck(
        { domain: 'example.com' },
        fakePorts({ tls: inspection({ protocol }) }),
      );
      expect(findingCodes(result)).not.toContain('tls_version_outdated');
    }
  });

  it('fails when the handshake cannot be completed at all', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        tls: new CheckError('timeout', 'TLS handshake with example.com:443 timed out after 8s'),
      }),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('timed out after 8s');
  });

  it('still reports the certificate when DNS is unavailable, without claiming www is absent', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({ tls: inspection(), dnsRecords: new CheckError('timeout', 'DNS timed out') }),
    );

    expect(result.isError).toBeFalsy();
    // Null, not false: a lookup that never answered established nothing.
    expect(structured(result)['coverage']).toMatchObject({ wwwResolves: null });
  });

  it('says it could not judge www coverage rather than passing the certificate', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        // Covers the apex only. With DNS unavailable the old code read
        // wwwResolves as false, which switched the www check off and reported
        // a clean certificate.
        tls: inspection({
          subjectAltName: 'DNS:example.com',
          hostMatches: { 'example.com': 'example.com', 'www.example.com': null },
        }),
        dnsRecords: new CheckError('timeout', 'DNS timed out'),
      }),
    );

    expect(findingCodes(result)).toContain('www_coverage_unjudged');
    expect(structured(result)['severity']).toBe('unknown');
  });

  it('rejects input that is not a host', async () => {
    const result = await runSslCheck({ domain: '' }, fakePorts());
    expect(result.isError).toBe(true);
  });
});
