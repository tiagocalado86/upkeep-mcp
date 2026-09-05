import { describe, expect, it } from 'vitest';
import { SPF_LOOKUP_LIMIT, analyseEmailAuth } from '../../src/lib/email-auth.js';

/** The analysis of a domain publishing only these TXT records at its apex. */
function spf(...txt: string[]) {
  return analyseEmailAuth(txt, []).spf;
}

/** The analysis of a domain publishing only these TXT records at `_dmarc`. */
function dmarc(...dmarcTxt: string[]) {
  return analyseEmailAuth([], dmarcTxt).dmarc;
}

describe('SPF', () => {
  it('reports a domain publishing none', () => {
    expect(spf()).toEqual({
      present: false,
      record: null,
      recordCount: 0,
      all: null,
      directLookups: 0,
    });
  });

  it('ignores TXT records that are not SPF', () => {
    // A domain's apex TXT set is a junk drawer: verification tokens, DKIM
    // policy, site ownership proofs. Only one of them is an SPF record.
    const result = spf(
      'google-site-verification=abc123',
      'v=spf1 include:_spf.example.net -all',
      'MS=ms12345678',
    );

    expect(result.present).toBe(true);
    expect(result.record).toBe('v=spf1 include:_spf.example.net -all');
  });

  it('does not mistake a record that merely starts with the version string', () => {
    // `v=spf1` must be a whole term. `v=spf10` is not SPF, and treating it as
    // such would report a policy the domain does not have.
    expect(spf('v=spf10 -all').present).toBe(false);
  });

  it('reads each qualifier on the all mechanism', () => {
    expect(spf('v=spf1 -all').all).toBe('fail');
    expect(spf('v=spf1 ~all').all).toBe('softfail');
    expect(spf('v=spf1 ?all').all).toBe('neutral');
    expect(spf('v=spf1 +all').all).toBe('pass');
  });

  it('reads a bare all as the permissive setting it is', () => {
    // The default qualifier is `+`. An administrator who writes `all` meaning
    // "everything else" has authorised the entire internet.
    expect(spf('v=spf1 include:_spf.example.net all').all).toBe('pass');
  });

  it('reports no all mechanism as absent rather than as a policy', () => {
    expect(spf('v=spf1 include:_spf.example.net').all).toBeNull();
  });

  it('counts more than one record without choosing between them', () => {
    // RFC 7208 §4.5: a receiver seeing two returns permerror, so SPF stops
    // applying altogether. Picking one here would describe a domain that works.
    const result = spf('v=spf1 include:a.example.net -all', 'v=spf1 include:b.example.net -all');

    expect(result.recordCount).toBe(2);
  });

  it('counts only the terms that cost a DNS lookup', () => {
    // ip4 and ip6 resolve nothing, so they are free however many there are.
    const result = spf(
      'v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 include:a.example.net a mx exists:%{i}.e.net -all',
    );

    expect(result.directLookups).toBe(4);
  });

  it('counts the redirect modifier, which costs a lookup like any mechanism', () => {
    expect(spf('v=spf1 redirect=_spf.example.net').directLookups).toBe(1);
  });

  it('does not count exp, which is only read once a message has already failed', () => {
    expect(spf('v=spf1 include:a.example.net exp=why.example.net -all').directLookups).toBe(1);
  });

  it('counts a record over the limit receivers enforce', () => {
    const includes = Array.from(
      { length: SPF_LOOKUP_LIMIT + 1 },
      (_unused, index) => `include:s${String(index)}.example.net`,
    ).join(' ');

    expect(spf(`v=spf1 ${includes} -all`).directLookups).toBe(SPF_LOOKUP_LIMIT + 1);
  });

  it('is case-insensitive, as the DNS is', () => {
    expect(spf('V=SPF1 INCLUDE:a.example.net -ALL').all).toBe('fail');
  });
});

describe('DMARC', () => {
  it('reports a domain publishing none', () => {
    expect(dmarc()).toEqual({
      present: false,
      record: null,
      recordCount: 0,
      policy: null,
      reportingAddresses: [],
    });
  });

  it('reads the policy and the reporting addresses', () => {
    const result = dmarc('v=DMARC1; p=reject; rua=mailto:dmarc@example.com; pct=100');

    expect(result.policy).toBe('reject');
    expect(result.reportingAddresses).toEqual(['mailto:dmarc@example.com']);
  });

  it('reads every reporting address when more than one is published', () => {
    const result = dmarc(
      'v=DMARC1; p=quarantine; rua=mailto:a@example.com,mailto:b@example.net!10m',
    );

    expect(result.reportingAddresses).toEqual(['mailto:a@example.com', 'mailto:b@example.net!10m']);
  });

  it('treats an unrecognised policy as none at all', () => {
    // Receivers ignore an invalid `p`, so reporting it as a policy would say the
    // domain is protected when nothing is protecting it.
    expect(dmarc('v=DMARC1; p=block; rua=mailto:a@example.com').policy).toBeNull();
  });

  it('reports a record with no p tag as present but without a policy', () => {
    const result = dmarc('v=DMARC1; rua=mailto:a@example.com');

    expect(result.present).toBe(true);
    expect(result.policy).toBeNull();
  });

  it('ignores TXT records at the label that are not DMARC', () => {
    expect(dmarc('some-other-verification=abc').present).toBe(false);
  });

  it('counts more than one record', () => {
    expect(dmarc('v=DMARC1; p=none', 'v=DMARC1; p=reject').recordCount).toBe(2);
  });

  it('tolerates the spacing administrators actually write', () => {
    expect(dmarc('v=DMARC1;p=reject;rua=mailto:a@example.com').policy).toBe('reject');
    expect(dmarc('v=DMARC1 ; p = reject ; rua = mailto:a@example.com').policy).toBe('reject');
  });

  it('keeps the first value when a tag is repeated', () => {
    // RFC 7489 §6.6.3 says records with duplicate tags are discarded; this at
    // least does not let a trailing duplicate silently override the real policy.
    expect(dmarc('v=DMARC1; p=reject; p=none').policy).toBe('reject');
  });
});

describe('the two together', () => {
  it('reads each from its own label', () => {
    // A DMARC record published at the apex by mistake is not a DMARC record,
    // and an SPF record is never found at `_dmarc`.
    const result = analyseEmailAuth(
      ['v=spf1 -all', 'v=DMARC1; p=reject'],
      ['v=DMARC1; p=none; rua=mailto:a@example.com'],
    );

    expect(result.spf.all).toBe('fail');
    expect(result.dmarc.policy).toBe('none');
  });
});
