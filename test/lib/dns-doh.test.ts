import { MockAgent, setGlobalDispatcher, type Dispatcher, getGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasDsRecord, resolveCaaOverDoh } from '../../src/lib/dns.js';

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

describe('resolveCaaOverDoh', () => {
  it('parses the presentation form the endpoint answers in', async () => {
    // DNS-over-HTTPS returns `0 issue "digicert.com"`, not the object node:dns
    // builds, so the tag has to become a property name again.
    replyWith({
      Status: 0,
      Answer: [
        { name: 'github.com', type: 257, TTL: 3600, data: '0 issue "digicert.com"' },
        { name: 'github.com', type: 257, TTL: 3600, data: '0 issuewild "letsencrypt.org"' },
      ],
    });

    await expect(resolveCaaOverDoh('github.com', 1000)).resolves.toEqual([
      { critical: 0, issue: 'digicert.com' },
      { critical: 0, issuewild: 'letsencrypt.org' },
    ]);
  });

  it('keeps the critical flag rather than assuming it is zero', async () => {
    replyWith({ Status: 0, Answer: [{ type: 257, data: '128 iodef "mailto:sec@example.com"' }] });

    await expect(resolveCaaOverDoh('example.com', 1000)).resolves.toEqual([
      { critical: 128, iodef: 'mailto:sec@example.com' },
    ]);
  });

  it('is empty for a domain that genuinely publishes none', async () => {
    replyWith({ Status: 0, Answer: [] });

    await expect(resolveCaaOverDoh('example.com', 1000)).resolves.toEqual([]);
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

    await expect(resolveCaaOverDoh('example.com', 1000)).resolves.toEqual([
      { critical: 0, issue: 'sectigo.com' },
    ]);
  });

  it('is empty when the endpoint itself fails', async () => {
    replyWith('gateway timeout', 504);

    await expect(resolveCaaOverDoh('example.com', 1000)).resolves.toEqual([]);
  });
});
