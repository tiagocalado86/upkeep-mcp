import { describe, expect, it } from 'vitest';
import { CheckError } from '../../src/lib/errors.js';
import { runDomainCheck } from '../../src/tools/domain-check.js';
import {
  agreeingNameservers,
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

  it('does not call a domain unresolvable when the lookup itself failed', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: new Error('DNS lookup for example.com timed out after 4s'),
      }),
    );

    // "The domain does not resolve at all" is a fact about the domain. A
    // timeout is a fact about the lookup, and it used to be reported as the
    // former — at critical, directly above the warning contradicting it.
    expect(findingCodes(result)).toEqual(['dns_lookup_failed']);
    expect(structured(result)['severity']).toBe('warning');
    expect(structured(result)['dnsResolved']).toBe(false);
    expect(text(result)).toContain('Resolves: not established');
  });
});

describe('runDomainCheck, email authentication', () => {
  /** The findings a domain publishing these records produces. */
  async function codesFor(txt: string[], dmarcTxt: string[]) {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: healthyDns({ txt, dmarcTxt }),
      }),
    );
    return { codes: findingCodes(result), report: structured(result), result };
  }

  it('reports a domain with SPF and DMARC in place as clean', async () => {
    const { codes, report } = await codesFor(
      ['v=spf1 include:_spf.example.net -all'],
      ['v=DMARC1; p=reject; rua=mailto:dmarc@example.com'],
    );

    expect(codes).toEqual([]);
    expect(report['email']).toEqual({
      spf: {
        present: true,
        record: 'v=spf1 include:_spf.example.net -all',
        recordCount: 1,
        all: 'fail',
        directLookups: 1,
      },
      dmarc: {
        present: true,
        record: 'v=DMARC1; p=reject; rua=mailto:dmarc@example.com',
        recordCount: 1,
        policy: 'reject',
        reportingAddresses: ['mailto:dmarc@example.com'],
      },
    });
  });

  it('treats an absent record as information, not as a warning', async () => {
    // `portfolio_report` ranks a whole portfolio by severity. Grading every
    // client who has not got round to DMARC as a warning would bury the
    // certificate expiring on Friday, which is the thing the report is for.
    const { codes, report } = await codesFor([], []);

    expect(codes).toEqual(['spf_not_published', 'dmarc_not_published']);
    expect(report['severity']).toBe('info');
  });

  it('warns about a record that is present and broken', async () => {
    // Two SPF records is not a lesser version of one: receivers return permerror
    // and skip SPF entirely, so the domain is worse off than with none.
    const { codes, report } = await codesFor(
      ['v=spf1 include:a.example.net -all', 'v=spf1 include:b.example.net -all'],
      ['v=DMARC1; p=reject; rua=mailto:dmarc@example.com'],
    );

    expect(codes).toContain('spf_multiple_records');
    expect(report['severity']).toBe('warning');
  });

  it('warns about an SPF record that authorises the whole internet', async () => {
    const { codes, report } = await codesFor(
      ['v=spf1 +all'],
      ['v=DMARC1; p=reject; rua=mailto:dmarc@example.com'],
    );

    expect(codes).toContain('spf_allows_any_sender');
    expect(report['severity']).toBe('warning');
  });

  it('warns when the SPF record is already over the lookup limit', async () => {
    const includes = Array.from(
      { length: 11 },
      (_unused, index) => `include:s${String(index)}.example.net`,
    ).join(' ');
    const { codes } = await codesFor(
      [`v=spf1 ${includes} -all`],
      ['v=DMARC1; p=reject; rua=mailto:dmarc@example.com'],
    );

    expect(codes).toContain('spf_too_many_lookups');
  });

  it('does not warn about a record merely close to the limit', async () => {
    // The count does not follow includes, so it is a lower bound. Warning under
    // the limit would be guessing about zones this project never reads.
    const includes = Array.from(
      { length: 10 },
      (_unused, index) => `include:s${String(index)}.example.net`,
    ).join(' ');
    const { codes } = await codesFor(
      [`v=spf1 ${includes} -all`],
      ['v=DMARC1; p=reject; rua=mailto:dmarc@example.com'],
    );

    expect(codes).not.toContain('spf_too_many_lookups');
  });

  it('separates DMARC that watches from DMARC that acts', async () => {
    const { codes, report } = await codesFor(
      ['v=spf1 -all'],
      ['v=DMARC1; p=none; rua=mailto:dmarc@example.com'],
    );

    expect(codes).toEqual(['dmarc_not_enforcing']);
    expect(report['severity']).toBe('info');
  });

  it('notes a DMARC policy nobody will ever see a report for', async () => {
    const { codes } = await codesFor(['v=spf1 -all'], ['v=DMARC1; p=reject']);

    expect(codes).toEqual(['dmarc_no_reporting_address']);
  });

  it('says nothing about email for a domain that does not resolve at all', async () => {
    // True and useless. An expired domain has bigger problems than DMARC, and
    // the finding that matters must not be queued behind two that do not.
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: new CheckError('not_found', 'example.com is not registered'),
        dnsRecords: emptyDns(),
      }),
    );

    expect(findingCodes(result)).toEqual(['domain_not_registered', 'domain_does_not_resolve']);
  });

  it('says nothing about email when the DNS lookup itself failed', async () => {
    // Empty records stand in for a failed lookup. Reading them as fact would
    // report every unreachable domain as publishing no SPF.
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: new CheckError('timeout', 'DNS lookup for example.com timed out after 5s'),
      }),
    );

    expect(findingCodes(result)).toEqual(['dns_lookup_failed']);
  });

  it('names both policies in the text a person reads', async () => {
    const { result } = await codesFor(
      ['v=spf1 ~all'],
      ['v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com'],
    );

    expect(text(result)).toContain('Email: SPF ~all, DMARC p=quarantine.');
  });
});

describe('runDomainCheck, asking the nameservers themselves', () => {
  it('says nothing when every nameserver serves the same version of the zone', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: healthyDns(),
        nameservers: agreeingNameservers(),
      }),
    );

    expect(findingCodes(result)).toEqual([]);
    expect(structured(result)['nameservers']).toMatchObject({ checked: true, agree: true });
    expect(text(result)).toContain('all on serial 2026090701');
  });

  it('reports a nameserver whose own hostname does not resolve', async () => {
    // Nothing can reach it, this server included, so it is a fault of the
    // delegation and not of the way this check asks.
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: healthyDns(),
        nameservers: agreeingNameservers({
          'ns2.example.net': {
            outcome: 'unresolvable',
            address: null,
            serial: null,
            problem: 'its hostname does not resolve to any address',
          },
        }),
      }),
    );

    expect(findingCodes(result)).toContain('nameserver_does_not_resolve');
    expect(structured(result)['severity']).toBe('warning');
  });

  it('reports a nameserver that answers without authority for the zone', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: healthyDns(),
        nameservers: agreeingNameservers({
          'ns2.example.net': {
            outcome: 'lame',
            serial: null,
            problem: 'it answered REFUSED for the zone',
          },
        }),
      }),
    );

    expect(findingCodes(result)).toContain('nameserver_not_authoritative');
    expect(text(result)).toContain('REFUSED');
  });

  it('does not blame the domain for a nameserver that only refuses TCP', async () => {
    // Resolvers ask over UDP first. sapo.pt's four nameservers all refuse TCP
    // and the domain resolves perfectly, so this must never be a warning.
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: healthyDns(),
        nameservers: agreeingNameservers({
          'ns2.example.net': {
            outcome: 'unreachable',
            serial: null,
            problem: 'it refused a connection on TCP port 53',
          },
        }),
      }),
    );

    expect(findingCodes(result)).toContain('nameserver_not_asked');
    expect(structured(result)['severity']).toBe('info');
  });

  it('grades a domain where none could be asked as unknown, not as broken', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: healthyDns(),
        nameservers: agreeingNameservers({
          'ns1.example.net': {
            outcome: 'unreachable',
            serial: null,
            problem: 'it refused a connection on TCP port 53',
          },
          'ns2.example.net': {
            outcome: 'unreachable',
            serial: null,
            problem: 'it refused a connection on TCP port 53',
          },
        }),
      }),
    );

    expect(findingCodes(result)).toEqual(['nameservers_not_established']);
    expect(structured(result)['severity']).toBe('unknown');
    // One reason, said once, for both servers that share it.
    expect(text(result)).toContain(
      'ns1.example.net, ns2.example.net: it refused a connection on TCP port 53',
    );
  });

  it('reports servers holding different versions without calling it a fault', async () => {
    // github.com has eight nameservers across two providers that do not
    // transfer between them: four report a date-based serial and four report 1.
    // Nothing is wrong, and a warning there would be wrong on every domain run
    // that way.
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: healthyDns(),
        nameservers: agreeingNameservers({ 'ns2.example.net': { serial: 1 } }),
      }),
    );

    expect(findingCodes(result)).toEqual(['nameservers_disagree']);
    expect(structured(result)['severity']).toBe('info');
    expect(text(result)).toContain('1 on ns2.example.net');
  });

  it('skips the whole thing when the caller asks it to', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com', checkNameservers: false },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: healthyDns(),
        // Would produce a finding if it were consulted at all.
        nameservers: agreeingNameservers({ 'ns2.example.net': { outcome: 'lame', serial: null } }),
      }),
    );

    expect(findingCodes(result)).toEqual([]);
    expect(structured(result)['nameservers']).toMatchObject({
      checked: false,
      unavailableReason: 'the caller asked for the nameservers not to be queried',
    });
  });

  it('asks nothing of a domain that publishes no nameservers', async () => {
    const result = await runDomainCheck(
      { domain: 'example.com' },
      fakePorts({
        rdap: { registration: registration(), delegationSigned: true },
        dnsRecords: healthyDns({ ns: [] }),
        nameservers: new Error('the port must not be called when there is nothing to ask'),
      }),
    );

    expect(structured(result)['nameservers']).toMatchObject({ checked: false });
  });
});
