import { MockAgent, setGlobalDispatcher, type Dispatcher, getGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaaRecord as NodeCaaRecord } from 'node:dns';
import { hasDsRecord, resolveRecords, type DnsResolver } from '../../src/lib/dns.js';

let agent: MockAgent;
let original: Dispatcher;

beforeEach(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  setGlobalDispatcher(original);
  await agent.close();
});

/**
 * @param body What the DNS-over-HTTPS endpoint should answer with.
 * @param status HTTP status to answer with.
 */
function replyWith(body: string | object, status = 200): void {
  agent
    .get('https://cloudflare-dns.com')
    .intercept({ path: (path) => path.startsWith('/dns-query'), method: 'GET' })
    .reply(status, body);
}

describe('hasDsRecord', () => {
  it('is true when the parent publishes a DS record', () => {
    replyWith({ Status: 0, AD: true, Answer: [{ type: 43, data: '2371 13 2 3299…' }] });
    return expect(hasDsRecord('cloudflare.com', 1000)).resolves.toBe(true);
  });

  it('is false when the zone is genuinely unsigned', () => {
    replyWith({ Status: 0, AD: false });
    return expect(hasDsRecord('google.com', 1000)).resolves.toBe(false);
  });

  it('ignores answers of other record types', () => {
    // A CNAME in the answer section is not a DS record.
    replyWith({ Status: 0, Answer: [{ type: 5, data: 'elsewhere.example.' }] });
    return expect(hasDsRecord('example.com', 1000)).resolves.toBe(false);
  });

  it('is null — not false — when the resolver could not answer', () => {
    // Failing to establish a fact is not the same as establishing its absence.
    replyWith({ Status: 2 });
    return expect(hasDsRecord('example.com', 1000)).resolves.toBeNull();
  });

  it('is null on an HTTP error', () => {
    replyWith('', 400);
    return expect(hasDsRecord('example.com', 1000)).resolves.toBeNull();
  });

  it('is null when the endpoint is unreachable, never a thrown error', async () => {
    // A DNSSEC answer is never worth failing a whole domain check over.
    agent
      .get('https://cloudflare-dns.com')
      .intercept({ path: (path) => path.startsWith('/dns-query'), method: 'GET' })
      .replyWithError(new Error('connection refused'));

    await expect(hasDsRecord('example.com', 1000)).resolves.toBeNull();
  });

  it('is null when the body is not the shape it expects', () => {
    replyWith('not an object');
    return expect(hasDsRecord('example.com', 1000)).resolves.toBeNull();
  });
});

/**
 * A resolver that answers addresses and nothing else, so a CAA answer is the
 * only thing under test.
 *
 * @param caa What `resolveCaa` should answer with. Empty is the Cloud Run case.
 */
function resolverWithCaa(caa: NodeCaaRecord[]): DnsResolver {
  return {
    resolve4: () => Promise.resolve(['203.0.113.10']),
    resolve6: () => Promise.resolve([]),
    resolveNs: () => Promise.resolve([]),
    resolveMx: () => Promise.resolve([]),
    resolveTxt: () => Promise.resolve([]),
    resolveCaa: () => Promise.resolve(caa),
    cancel: () => undefined,
  };
}

describe("CAA, when the platform's resolver will not answer for it", () => {
  it('asks DNS-over-HTTPS and parses the presentation form', async () => {
    // Cloud Run answers A, AAAA, NS, MX and TXT and returns nothing for CAA,
    // which is indistinguishable from a domain that publishes none. Reported
    // as an absence, it says a client is unprotected against mis-issuance.
    replyWith({
      Status: 0,
      Answer: [
        { name: 'github.com', type: 257, TTL: 3600, data: '0 issue "digicert.com"' },
        { name: 'github.com', type: 257, TTL: 3600, data: '0 issuewild "letsencrypt.org"' },
      ],
    });

    const records = await resolveRecords('github.com', 1000, () => resolverWithCaa([]));

    expect(records.caa).toEqual([
      { critical: 0, issue: 'digicert.com' },
      { critical: 0, issuewild: 'letsencrypt.org' },
    ]);
  });

  it('keeps the critical flag rather than assuming it is zero', async () => {
    replyWith({ Status: 0, Answer: [{ type: 257, data: '128 iodef "mailto:sec@example.com"' }] });

    const records = await resolveRecords('example.com', 1000, () => resolverWithCaa([]));

    expect(records.caa).toEqual([{ critical: 128, iodef: 'mailto:sec@example.com' }]);
  });

  it('does not ask when the resolver already answered', async () => {
    let asked = 0;
    agent
      .get('https://cloudflare-dns.com')
      .intercept({ path: (path) => path.startsWith('/dns-query'), method: 'GET' })
      .reply(200, () => {
        asked += 1;
        return { Status: 0, Answer: [] };
      });

    const records = await resolveRecords('example.com', 1000, () =>
      resolverWithCaa([{ critical: 0, issue: 'letsencrypt.org' }]),
    );

    expect(records.caa).toEqual([{ critical: 0, issue: 'letsencrypt.org' }]);
    expect(asked).toBe(0);
  });

  it('reports no CAA when neither source has one', async () => {
    replyWith({ Status: 0, Answer: [] });

    const records = await resolveRecords('example.com', 1000, () => resolverWithCaa([]));

    expect(records.caa).toEqual([]);
  });

  it('ignores an answer it cannot represent rather than inventing a record', async () => {
    // An unknown tag and a malformed line both have to be dropped: a CaaRecord
    // with no tag property would claim the domain restricts issuance to nothing.
    replyWith({
      Status: 0,
      Answer: [
        { type: 257, data: '0 unknowntag "whatever"' },
        { type: 257, data: 'not a caa record' },
        { type: 5, data: 'alias.example.com' },
        { type: 257, data: '0 issue "sectigo.com"' },
      ],
    });

    const records = await resolveRecords('example.com', 1000, () => resolverWithCaa([]));

    expect(records.caa).toEqual([{ critical: 0, issue: 'sectigo.com' }]);
  });

  it('reports no CAA when the endpoint itself fails', async () => {
    replyWith('gateway timeout', 504);

    const records = await resolveRecords('example.com', 1000, () => resolverWithCaa([]));

    expect(records.caa).toEqual([]);
  });
});
