import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRdapDomain, serverFor } from '../../src/lib/rdap.js';

const exampleCom: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/rdap-example-com.json', import.meta.url), 'utf8'),
);

describe('serverFor', () => {
  const services = new Map([
    ['com', 'https://rdap.verisign.com/com/v1/'],
    ['goodexample.com', 'https://rdap.example-registrar.test/'],
    ['uk', 'https://rdap.nominet.uk/uk/'],
  ]);

  it('matches the suffix, not a substring', () => {
    expect(serverFor('example.com', services)).toBe('https://rdap.verisign.com/com/v1/');
  });

  it('prefers the longest matching suffix', () => {
    // The registry really does contain both `com` and `goodexample.com`, which is
    // why matching is label-wise longest-first and never endsWith().
    expect(serverFor('goodexample.com', services)).toBe('https://rdap.example-registrar.test/');
    expect(serverFor('www.goodexample.com', services)).toBe('https://rdap.example-registrar.test/');
  });

  it('does not let a name ending in the same letters match', () => {
    // `notgoodexample.com` shares a suffix with `goodexample.com` textually but
    // not label-wise, so it must fall through to `com`.
    expect(serverFor('notgoodexample.com', services)).toBe('https://rdap.verisign.com/com/v1/');
  });

  it('resolves a multi-part suffix through its right-most label', () => {
    expect(serverFor('example.co.uk', services)).toBe('https://rdap.nominet.uk/uk/');
  });

  it('falls back to the override map for a TLD absent from the registry', () => {
    expect(serverFor('github.io', services)).toContain('identitydigital');
  });

  it('is null when nothing publishes RDAP for the suffix', () => {
    expect(serverFor('example.invalidtld', services)).toBeNull();
  });
});

describe('parseRdapDomain', () => {
  it('reads a real registry response', () => {
    const facts = parseRdapDomain(exampleCom);

    expect(facts.expiresAt).toBe('2027-08-13T04:00:00.000Z');
    expect(facts.registeredAt).toBe('1995-08-14T04:00:00.000Z');
    expect(facts.statuses).toContain('client transfer prohibited');
    expect(facts.registrar).not.toBeNull();
    expect(facts.ianaRegistrarId).not.toBeNull();
  });

  it('normalises an offset timestamp to UTC', () => {
    const facts = parseRdapDomain({
      events: [{ eventAction: 'expiration', eventDate: '2027-02-28T23:59:00+01:00' }],
    });
    expect(facts.expiresAt).toBe('2027-02-28T22:59:00.000Z');
  });

  it('accepts fractional seconds, which some registries emit', () => {
    const facts = parseRdapDomain({
      events: [{ eventAction: 'expiration', eventDate: '2027-03-08T19:12:48.273Z' }],
    });
    expect(facts.expiresAt).toBe('2027-03-08T19:12:48.273Z');
  });

  it('accepts a bare date, which a strict RFC 3339 parser would reject', () => {
    const facts = parseRdapDomain({
      events: [{ eventAction: 'expiration', eventDate: '2027-04-21' }],
    });
    expect(facts.expiresAt).toBe('2027-04-21T00:00:00.000Z');
  });

  it('matches event actions case-insensitively', () => {
    const facts = parseRdapDomain({
      events: [{ eventAction: 'Expiration', eventDate: '2027-01-01T00:00:00Z' }],
    });
    expect(facts.expiresAt).toBe('2027-01-01T00:00:00.000Z');
  });

  it('ignores events it does not recognise', () => {
    const facts = parseRdapDomain({
      events: [
        { eventAction: 'last changed', eventDate: '2026-08-14T08:01:43Z' },
        { eventAction: 'last update of RDAP database', eventDate: '2026-08-31T09:50:52Z' },
      ],
    });
    expect(facts.expiresAt).toBeNull();
    expect(facts.registeredAt).toBeNull();
  });

  it('finds the registrar when the role array carries more than one role', () => {
    const facts = parseRdapDomain({
      entities: [
        { roles: ['technical'], vcardArray: ['vcard', [['fn', {}, 'text', 'Not this one']]] },
        {
          roles: ['registrar', 'sponsor'],
          publicIds: [{ type: 'IANA Registrar ID', identifier: 376 }],
          vcardArray: [
            'vcard',
            [
              ['version', {}, 'text', '4.0'],
              ['fn', {}, 'text', 'Example Registrar'],
            ],
          ],
        },
      ],
    });

    expect(facts.registrar).toBe('Example Registrar');
    // Registries return the identifier as a number as well as a string.
    expect(facts.ianaRegistrarId).toBe('376');
  });

  it('keeps a redacted registrar name as published rather than inventing one', () => {
    const facts = parseRdapDomain({
      entities: [
        {
          roles: ['registrar'],
          vcardArray: ['vcard', [['fn', {}, 'text', 'REDACTED FOR PRIVACY']]],
        },
      ],
    });
    expect(facts.registrar).toBe('REDACTED FOR PRIVACY');
  });

  it('reads DNSSEC delegation only from delegationSigned', () => {
    expect(parseRdapDomain({ secureDNS: { delegationSigned: true } }).delegationSigned).toBe(true);
    expect(parseRdapDomain({ secureDNS: { delegationSigned: false } }).delegationSigned).toBe(
      false,
    );
    // Every member of secureDNS is optional, so its absence is "not stated",
    // never "not signed".
    expect(parseRdapDomain({ secureDNS: { dsData: [] } }).delegationSigned).toBeNull();
    expect(parseRdapDomain({}).delegationSigned).toBeNull();
  });

  it('survives payloads that are not shaped like an RDAP response at all', () => {
    for (const payload of [null, undefined, 'a string', 42, [], { events: 'not an array' }]) {
      const facts = parseRdapDomain(payload);
      expect(facts).toMatchObject({
        registrar: null,
        ianaRegistrarId: null,
        statuses: [],
        registeredAt: null,
        expiresAt: null,
        delegationSigned: null,
      });
    }
  });

  it('lowercases statuses and drops non-string entries', () => {
    const facts = parseRdapDomain({ status: ['Client Transfer Prohibited', 42, null] });
    expect(facts.statuses).toEqual(['client transfer prohibited']);
  });
});
