import { MockAgent, setGlobalDispatcher, type Dispatcher, getGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaaRecord as NodeCaaRecord } from 'node:dns';
import type { DnsResolver } from '../../src/lib/dns.js';
import { CheckError } from '../../src/lib/errors.js';
import {
  createDefaultPorts,
  foundAnything,
  resolveRecordsWithCaa,
  rethrowForRemoteCaller,
} from '../../src/lib/ports.js';
import { emptyDns, healthyDns } from '../helpers/fake-ports.js';

describe('foundAnything', () => {
  it('is false for a name that returned nothing at all', () => {
    // This is the NXDOMAIN case: every record set comes back empty and the
    // lookup itself succeeded, so without this the answer would be cached as
    // confidently as a real one.
    expect(foundAnything(emptyDns())).toBe(false);
  });

  it('is true for a domain that resolves', () => {
    expect(foundAnything(healthyDns())).toBe(true);
  });

  it('is true for a domain that exists but serves nothing', () => {
    // A parked or mail-only domain has nameservers, or an MX, and no addresses.
    // It exists, and its answer is worth the full lifetime.
    expect(foundAnything({ ...emptyDns(), ns: ['ns1.example.net'] })).toBe(true);
    expect(foundAnything({ ...emptyDns(), mx: [{ exchange: 'mx.example', priority: 10 }] })).toBe(
      true,
    );
    expect(foundAnything({ ...emptyDns(), txt: ['v=spf1 -all'] })).toBe(true);
  });

  it('is true when only the www sibling resolves', () => {
    expect(foundAnything({ ...emptyDns(), wwwResolves: true })).toBe(true);
  });
});

describe('createDefaultPorts with publicTargetsOnly', () => {
  // The guard was wired into the TLS path and nowhere else, so a public
  // instance would have fetched `https://host:22/` and reported back whether
  // the connection was refused. The policy was right; only the wiring was
  // missing, so this asserts the wiring, on every path that leaves the process.
  //
  // The target is an RFC 5737 documentation address: public as far as the
  // guard is concerned, needs no lookup because it is a literal, and is never
  // contacted because the port is refused first.
  const ports = createDefaultPorts({ publicTargetsOnly: true });

  it('refuses a port that is not a web port, on every outbound path', async () => {
    await expect(ports.http.hop('https://192.0.2.1:22/', 1000)).rejects.toThrow(/port scanner/);
    await expect(ports.http.text('https://192.0.2.1:3306/', 1000, 1000)).rejects.toThrow(
      /port scanner/,
    );
    await expect(ports.robots.forOrigin('https://192.0.2.1:8080')).rejects.toThrow(/port scanner/);
    await expect(ports.browser.audit('https://192.0.2.1:9222/', ['wcag2a'])).rejects.toThrow(
      /port scanner/,
    );
    await expect(ports.tls.inspect('192.0.2.1', 22, ['192.0.2.1'])).rejects.toThrow(/port scanner/);
  });

  it('refuses port 443 over plain HTTP, and 80 over HTTPS', async () => {
    await expect(ports.http.hop('http://192.0.2.1:443/', 1000)).rejects.toThrow(/port scanner/);
    await expect(ports.http.hop('https://192.0.2.1:80/', 1000)).rejects.toThrow(/port scanner/);
  });
});

describe('rethrowForRemoteCaller', () => {
  // `npx playwright install chromium` is the fix on the machine the server runs
  // on, and unfollowable by someone connecting to somebody else's. The published
  // image now ships a browser (ADR 0016), so meeting this remotely means that
  // deployment is broken — which the message has to say, since "run the server
  // yourself" as a permanent answer would now be wrong.
  it('tells a remote caller this instance is at fault, not the tool', () => {
    const missing = new CheckError(
      'not_found',
      'no browser is installed for this check; run `npx playwright install chromium` once',
    );

    expect(() => {
      rethrowForRemoteCaller(missing);
    }).toThrow(/fault in this instance rather than a limit of the tool/);
  });

  it('keeps the code, and the original failure as the cause', () => {
    const missing = new CheckError('not_found', 'no browser is installed for this check');

    try {
      rethrowForRemoteCaller(missing);
      expect.unreachable('it must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CheckError);
      expect((error as CheckError).code).toBe('not_found');
      expect((error as CheckError).cause).toBe(missing);
    }
  });

  it('passes every other failure through untouched', () => {
    // A page that would not load, or a target the guard refused, has nothing to
    // do with the browser being absent and must keep its own message.
    const timeout = new CheckError(
      'timeout',
      'https://example.com did not finish loading within 20s',
    );
    expect(() => {
      rethrowForRemoteCaller(timeout);
    }).toThrow(timeout);

    const odd = new Error('boom');
    expect(() => {
      rethrowForRemoteCaller(odd);
    }).toThrow(odd);
  });
});

describe('resolveRecordsWithCaa', () => {
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

  /** @param body What the DNS-over-HTTPS endpoint should answer with. */
  function replyWith(body: string | object, status = 200): void {
    agent
      .get('https://cloudflare-dns.com')
      .intercept({ path: (path) => path.startsWith('/dns-query'), method: 'GET' })
      .reply(status, body);
  }

  /** A resolver that answers addresses, and whatever CAA the case needs. */
  function resolverWithCaa(caa: NodeCaaRecord[]): () => DnsResolver {
    return () => ({
      resolve4: () => Promise.resolve(['203.0.113.10']),
      resolve6: () => Promise.resolve([]),
      resolveNs: () => Promise.resolve(['ns1.example.net']),
      resolveMx: () => Promise.resolve([]),
      resolveTxt: () => Promise.resolve([]),
      resolveCaa: () => Promise.resolve(caa),
      cancel: () => undefined,
    });
  }

  /** A limiter that records what it was asked to pace, and runs it. */
  function recordingLimiter(): {
    hosts: string[];
    run: <T>(h: string, w: () => Promise<T>) => Promise<T>;
  } {
    const hosts: string[] = [];
    return {
      hosts,
      run: <T>(host: string, work: () => Promise<T>): Promise<T> => {
        hosts.push(host);
        return work();
      },
    };
  }

  it('asks the endpoint when the platform resolver returned no CAA', async () => {
    replyWith({ Status: 0, Answer: [{ type: 257, data: '0 issue "pki.goog"' }] });
    const limiter = recordingLimiter();

    const records = await resolveRecordsWithCaa('google.com', limiter, resolverWithCaa([]));

    expect(records.caa).toEqual([{ critical: 0, issue: 'pki.goog' }]);
  });

  it('paces the fallback through the limiter, keyed on the host it contacts', async () => {
    // Twenty sites in a portfolio_report would otherwise open twenty unpaced
    // requests to one endpoint, and a throttled answer reads as `[]` — the
    // silent absence this fallback exists to remove, reintroduced under load.
    replyWith({ Status: 0, Answer: [] });
    const limiter = recordingLimiter();

    await resolveRecordsWithCaa('example.com', limiter, resolverWithCaa([]));

    expect(limiter.hosts).toEqual(['cloudflare-dns.com']);
  });

  it('does not ask when the resolver already answered', async () => {
    // No interceptor is registered and net connect is disabled, so a request
    // here would be a failure rather than a silent extra round trip.
    const limiter = recordingLimiter();

    const records = await resolveRecordsWithCaa(
      'example.com',
      limiter,
      resolverWithCaa([{ critical: 0, issue: 'letsencrypt.org' }]),
    );

    expect(records.caa).toEqual([{ critical: 0, issue: 'letsencrypt.org' }]);
    expect(limiter.hosts).toEqual([]);
  });

  it('never lets a failing endpoint turn a healthy domain into a failed lookup', async () => {
    // The reason this composition lives here and not inside resolveRecords:
    // there the fallback sat inside the deadline every query is raced against,
    // so a slow third party rejected the whole lookup — which domain_check
    // reports as `domain_does_not_resolve`, critical, for a healthy site whose
    // other five record sets had already arrived.
    replyWith('gateway timeout', 504);
    const limiter = recordingLimiter();

    const records = await resolveRecordsWithCaa('example.com', limiter, resolverWithCaa([]));

    expect(records.caa).toEqual([]);
    expect(records.a).toEqual(['203.0.113.10']);
    expect(records.ns).toEqual(['ns1.example.net']);
    expect(records.apexResolves).toBe(true);
  });
});
