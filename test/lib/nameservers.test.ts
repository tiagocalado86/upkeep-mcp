import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/lib/defaults.js';
import { RRTYPE_SOA, type DnsMessage, type ResourceRecord } from '../../src/lib/dns-wire.js';
import { CheckError } from '../../src/lib/errors.js';
import { askNameservers, type NameserverProbe } from '../../src/lib/nameservers.js';

/**
 * A probe whose answers are given rather than fetched.
 *
 * The wire format is tested next door against bytes; this is about what is made
 * of the answers, so the answers are handed over directly — the seam this
 * project uses everywhere instead of mocking a builtin.
 */
function probe(options: {
  addresses?: Record<string, string[]>;
  answers?: Record<string, { serial?: number; authoritative?: boolean; rcode?: number } | Error>;
}): NameserverProbe {
  return {
    resolveAddresses: (host) =>
      Promise.resolve(options.addresses?.[host] ?? [`10.0.0.${String(host.length)}`]),
    query: (address) => {
      const answer = options.answers?.[address];
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(soaAnswer(answer ?? {}));
    },
  };
}

/**
 * @param options What the server should be taken to have said.
 * @returns A parsed message of the shape `queryOverTcp` returns.
 */
function soaAnswer(options: {
  serial?: number;
  authoritative?: boolean;
  rcode?: number;
}): DnsMessage {
  // `readSoaSerial` walks the message from the record's data offset, so the
  // bytes have to be real even here: two names, then the serial.
  const name = Uint8Array.from([2, 110, 115, 0]);
  const numbers = new Uint8Array(20);
  new DataView(numbers.buffer).setUint32(0, options.serial ?? 1);
  const data = new Uint8Array(name.length * 2 + numbers.length);
  data.set(name, 0);
  data.set(name, name.length);
  data.set(numbers, name.length * 2);

  const record: ResourceRecord = {
    name: 'example.com',
    type: RRTYPE_SOA,
    ttl: 300,
    data,
    dataOffset: 0,
  };
  const rcode = options.rcode ?? 0;

  return {
    authoritative: options.authoritative ?? true,
    rcode,
    rcodeName: rcode === 5 ? 'REFUSED' : 'NOERROR',
    answers: rcode === 0 ? [record] : [],
    authority: [],
    bytes: data,
  };
}

describe('askNameservers', () => {
  it('reports a zone every nameserver serves at the same version', async () => {
    const check = await askNameservers(
      'example.com',
      ['ns1.example.com', 'ns2.example.com'],
      probe({
        addresses: { 'ns1.example.com': ['192.0.2.1'], 'ns2.example.com': ['192.0.2.2'] },
        answers: { '192.0.2.1': { serial: 7 }, '192.0.2.2': { serial: 7 } },
      }),
    );

    expect(check.checked).toBe(true);
    expect(check.agree).toBe(true);
    expect(check.serials).toEqual([7]);
    expect(check.answers.map((answer) => answer.outcome)).toEqual([
      'authoritative',
      'authoritative',
    ]);
  });

  it('sees two servers holding different versions of the zone', async () => {
    const check = await askNameservers(
      'example.com',
      ['ns1.example.com', 'ns2.example.com'],
      probe({
        addresses: { 'ns1.example.com': ['192.0.2.1'], 'ns2.example.com': ['192.0.2.2'] },
        answers: { '192.0.2.1': { serial: 9 }, '192.0.2.2': { serial: 7 } },
      }),
    );

    expect(check.agree).toBe(false);
    expect(check.serials).toEqual([7, 9]);
  });

  it('calls a nameserver whose own name does not resolve unresolvable', async () => {
    // No resolver can reach it either, so this is a fault of the delegation
    // rather than a limit of asking over TCP.
    const check = await askNameservers(
      'example.com',
      ['gone.example.com'],
      probe({ addresses: { 'gone.example.com': [] } }),
    );

    expect(check.answers[0]).toMatchObject({
      outcome: 'unresolvable',
      address: null,
      problem: 'its hostname does not resolve to any address',
    });
  });

  it('calls a server that answers without authority lame', async () => {
    const check = await askNameservers(
      'example.com',
      ['ns1.example.com'],
      probe({
        addresses: { 'ns1.example.com': ['192.0.2.1'] },
        answers: { '192.0.2.1': { authoritative: false } },
      }),
    );

    expect(check.answers[0]).toMatchObject({ outcome: 'lame', serial: null });
    expect(check.answers[0]?.problem).toContain('without claiming authority');
  });

  it('calls a REFUSED answer lame, and names the response code', async () => {
    const check = await askNameservers(
      'example.com',
      ['ns1.example.com'],
      probe({
        addresses: { 'ns1.example.com': ['192.0.2.1'] },
        answers: { '192.0.2.1': { rcode: 5 } },
      }),
    );

    expect(check.answers[0]).toMatchObject({ outcome: 'lame' });
    expect(check.answers[0]?.problem).toContain('REFUSED');
  });

  it('calls a connection that will not open unreachable, not lame', async () => {
    // Plenty of nameservers answer UDP and refuse TCP. Resolvers do not notice
    // and neither should a report: this says nothing about the delegation.
    const check = await askNameservers(
      'example.com',
      ['ns1.example.com'],
      probe({
        addresses: { 'ns1.example.com': ['192.0.2.1'] },
        answers: {
          '192.0.2.1': new CheckError('network', 'it refused a connection on TCP port 53'),
        },
      }),
    );

    expect(check.answers[0]).toMatchObject({
      outcome: 'unreachable',
      address: '192.0.2.1',
      problem: 'it refused a connection on TCP port 53',
    });
  });

  it('leaves a server that could not be asked out of the comparison', async () => {
    const check = await askNameservers(
      'example.com',
      ['ns1.example.com', 'ns2.example.com'],
      probe({
        addresses: { 'ns1.example.com': ['192.0.2.1'], 'ns2.example.com': ['192.0.2.2'] },
        answers: {
          '192.0.2.1': { serial: 7 },
          '192.0.2.2': new CheckError('timeout', 'it did not answer within 5000ms over TCP'),
        },
      }),
    );

    // One serial seen and one server unasked is not a disagreement.
    expect(check.agree).toBe(true);
    expect(check.serials).toEqual([7]);
  });

  it('asks nothing when the domain publishes no nameservers', async () => {
    const check = await askNameservers('example.com', [], probe({}));

    expect(check).toMatchObject({ checked: false, answers: [], agree: true });
    expect(check.unavailableReason).toContain('no NS records');
  });

  it('bounds how many nameservers it will ask, and says which it left out', async () => {
    const many = Array.from({ length: 12 }, (_unused, index) => `ns${String(index)}.example.com`);

    const check = await askNameservers('example.com', many, probe({}));

    expect(check.answers).toHaveLength(LIMITS.maxNameserversQueried);
    expect(check.unavailableReason).toBe(
      `only the first ${String(LIMITS.maxNameserversQueried)} of 12 nameservers were asked`,
    );
  });

  it('reports a guard refusal as one nameserver unreachable, not as a failed check', async () => {
    // An NS record pointing at a private address is refused by the guard the
    // caller wraps the probe in. That is one bad nameserver, not a reason to
    // abandon the domain.
    const check = await askNameservers('example.com', ['ns1.example.com', 'ns2.example.com'], {
      resolveAddresses: (host) =>
        host === 'ns1.example.com'
          ? Promise.reject(
              new CheckError('invalid_input', 'ns1.example.com resolves to 10.0.0.1 (private)'),
            )
          : Promise.resolve(['192.0.2.2']),
      query: () => Promise.resolve(soaAnswer({ serial: 3 })),
    });

    expect(check.answers[0]).toMatchObject({ outcome: 'unreachable' });
    expect(check.answers[0]?.problem).toContain('private');
    expect(check.answers[1]).toMatchObject({ outcome: 'authoritative', serial: 3 });
  });
});
