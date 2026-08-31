import { describe, expect, it } from 'vitest';
import { CheckError } from '../../src/lib/errors.js';
import { runDomainCheck } from '../../src/tools/domain-check.js';
import {
  emptyDns,
  fakePorts,
  findingCodes,
  healthyDns,
  registration,
  structured,
  text,
} from '../helpers/fake-ports.js';

describe('runDomainCheck', () => {
  it('reports registration and DNS for a healthy domain', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: healthyDns(),
      }),
    );

    const report = structured(result);
    expect(result.isError).toBeFalsy();
    expect(report['severity']).toBe('ok');
    expect(report['registration']).toMatchObject({
      source: 'rdap',
      registrar: 'Example Registrar',
      daysUntilExpiry: 346,
    });
    expect(report['dnssec']).toEqual({ delegationSigned: true, source: 'rdap' });
    expect(findingCodes(result)).toEqual([]);
  });

  it('checks the registrable domain when given a URL with a subdomain', async () => {
    const result = await runDomainCheck(
      { domain: 'https://www.shop.example.co.uk/basket' },
      fakePorts({ rdap: { registration: registration(), delegationSigned: true } }),
    );

    expect(structured(result)).toMatchObject({
      domain: 'www.shop.example.co.uk',
      registrableDomain: 'example.co.uk',
    });
  });

  it('records the Unicode form of an internationalised domain', async () => {
    const result = await runDomainCheck(
      { domain: 'café.pt' },
      fakePorts({ rdap: { registration: registration(), delegationSigned: null } }),
    );

    expect(structured(result)).toMatchObject({
      domain: 'xn--caf-dma.pt',
      unicodeDomain: 'café.pt',
    });
  });

  it('rejects an IP address, which has no registration', async () => {
    const result = await runDomainCheck({ domain: '192.0.2.1' }, fakePorts());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('IP address');
  });

  it('rejects input that is not a domain at all', async () => {
    const result = await runDomainCheck({ domain: 'not a domain' }, fakePorts());
    expect(result.isError).toBe(true);
  });

  it('warns as expiry approaches and turns critical inside a week', async () => {
    const soon = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: {
          registration: registration({
            expiresAt: '2026-09-20T00:00:00.000Z',
            daysUntilExpiry: 19,
          }),
          delegationSigned: true,
        },
        dnsRecords: healthyDns(),
      }),
    );
    expect(findingCodes(soon)).toContain('domain_expires_soon');
    expect(structured(soon)['severity']).toBe('warning');

    const imminent = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: {
          registration: registration({ expiresAt: '2026-09-03T00:00:00.000Z', daysUntilExpiry: 2 }),
          delegationSigned: true,
        },
        dnsRecords: healthyDns(),
      }),
    );
    expect(structured(imminent)['severity']).toBe('critical');
  });

  it('reports an expired registration', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: {
          registration: registration({
            expiresAt: '2026-08-01T00:00:00.000Z',
            daysUntilExpiry: -30,
          }),
          delegationSigned: null,
        },
        dnsRecords: emptyDns(),
      }),
    );

    expect(findingCodes(result)).toContain('domain_expired');
    expect(text(result)).toContain('expired 30 days ago');
  });

  it('explains a registry that publishes no expiry date, as information not alarm', async () => {
    const result = await runDomainCheck(
      { domain: 'example.de' },
      fakePorts({
        rdap: {
          registration: registration({
            source: 'unavailable',
            expiresAt: null,
            daysUntilExpiry: null,
            unavailableReason: 'the .de registry does not publish expiry dates',
          }),
          delegationSigned: true,
        },
        dnsRecords: healthyDns(),
      }),
    );

    expect(findingCodes(result)).toEqual(['registration_expiry_unavailable']);
    // A gap in what a registry publishes is not a problem with the domain.
    expect(structured(result)['severity']).toBe('info');
    expect(text(result)).toContain('no expiry date available');
  });

  it('reports an unregistered domain once, not twice', async () => {
    const result = await runDomainCheck(
      { domain: 'nope.com' },
      fakePorts({
        rdap: new CheckError(
          'not_found',
          'nope.com is not registered, according to the .com registry',
        ),
        dnsRecords: emptyDns(),
      }),
    );

    expect(findingCodes(result)).toEqual(['domain_not_registered', 'domain_does_not_resolve']);
  });

  it('still reports DNS when the registry cannot be reached', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: new CheckError('network', 'registry unreachable'),
        dnsRecords: healthyDns(),
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(findingCodes(result)).toContain('registration_lookup_failed');
    expect(structured(result)['dns']).toMatchObject({ apexResolves: true });
  });

  it('still reports registration when DNS cannot be reached', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: new CheckError('timeout', 'DNS lookup for example.com timed out after 4s'),
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(findingCodes(result)).toContain('dns_lookup_failed');
    expect(structured(result)['registration']).toMatchObject({ source: 'rdap' });
  });

  it('fails only when neither the registry nor DNS could be reached', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: new CheckError('timeout', 'the registry timed out'),
        dnsRecords: new CheckError('timeout', 'DNS timed out'),
      }),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('timeout');
  });

  it('warns when only www resolves', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: healthyDns({ apexResolves: false, a: [] }),
      }),
    );

    expect(findingCodes(result)).toContain('apex_does_not_resolve');
  });

  it('does not report a resolution problem for a domain that has no www', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: healthyDns({ wwwResolves: false }),
      }),
    );

    expect(findingCodes(result)).toEqual([]);
  });

  it('flags a registry hold', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: {
          registration: registration({ statuses: ['client hold', 'pending delete'] }),
          delegationSigned: true,
        },
        dnsRecords: healthyDns(),
      }),
    );

    expect(findingCodes(result)).toEqual(
      expect.arrayContaining(['domain_on_hold', 'domain_pending_delete']),
    );
    expect(structured(result)['severity']).toBe('critical');
  });

  it('falls back to a DNS-over-HTTPS query when the registry says nothing about DNSSEC', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: null },
        dnsRecords: healthyDns(),
        dsRecord: true,
      }),
    );

    expect(structured(result)['dnssec']).toEqual({ delegationSigned: true, source: 'doh' });
  });

  it('says the delegation status is unknown rather than guessing', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: null },
        dnsRecords: healthyDns(),
        dsRecord: null,
      }),
    );

    expect(structured(result)['dnssec']).toEqual({ delegationSigned: null, source: 'unknown' });
    expect(text(result)).toContain('not established');
  });
});
