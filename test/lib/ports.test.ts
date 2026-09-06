import { readFileSync } from 'node:fs';
import { MockAgent, setGlobalDispatcher, type Dispatcher, getGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaaRecord as NodeCaaRecord } from 'node:dns';
import type { DnsResolver } from '../../src/lib/dns.js';
import { CheckError } from '../../src/lib/errors.js';
import {
  checkRevocation,
  createDefaultPorts,
  foundAnything,
  resolveRecordsWithCaa,
  rethrowForRemoteCaller,
} from '../../src/lib/ports.js';
import type { RevocationMaterials } from '../../src/lib/tls.js';
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

describe('checkRevocation', () => {
  /** The DER of a real certificate and its issuer, plus a real signed answer. */
  function recorded(name: 'good' | 'revoked'): {
    leafDer: Uint8Array;
    issuerDer: Uint8Array;
    responseDer: Uint8Array;
  } {
    const raw = JSON.parse(readFileSync(`test/fixtures/ocsp-${name}.json`, 'utf8')) as Record<
      string,
      string
    >;
    const decode = (field: string): Uint8Array =>
      new Uint8Array(Buffer.from(raw[field] ?? '', 'base64'));
    return {
      leafDer: decode('leafDerBase64'),
      issuerDer: decode('issuerDerBase64'),
      responseDer: decode('responseDerBase64'),
    };
  }

  /**
   * @param overrides What the handshake yielded.
   * @returns Materials for a certificate that names a responder and staples
   *   nothing, which is the shape that makes the code ask.
   */
  function materials(overrides: Partial<RevocationMaterials> = {}): RevocationMaterials {
    const { leafDer, issuerDer } = recorded('good');
    return {
      leafDer,
      issuerDer,
      responderUrls: ['http://ocsp.example.test'],
      stapled: null,
      ...overrides,
    };
  }

  /** An `ask` that must never be called. */
  const never = (): Promise<Uint8Array> => {
    throw new Error('the responder was contacted when it should not have been');
  };

  it('prefers a stapled answer, and contacts nobody', async () => {
    // The whole reason stapling is asked for in the handshake: the server has
    // already put the question to the authority, so a staple settles it for
    // free. A portfolio of twenty sites that all staple makes no OCSP requests.
    const { responseDer } = recorded('good');

    const report = await checkRevocation(materials({ stapled: responseDer }), never);

    expect(report).toMatchObject({ checked: true, status: 'good', source: 'stapled' });
    expect(report.responder).toBeNull();
  });

  it('asks the responder when nothing was stapled', async () => {
    const { responseDer } = recorded('good');
    const asked: string[] = [];

    const report = await checkRevocation(materials(), (url, request) => {
      asked.push(url);
      expect(request.length).toBeGreaterThan(0);
      return Promise.resolve(responseDer);
    });

    expect(asked).toEqual(['http://ocsp.example.test']);
    expect(report).toMatchObject({
      checked: true,
      status: 'good',
      source: 'responder',
      responder: 'http://ocsp.example.test',
    });
  });

  it('falls back to the responder when the staple does not hold up', async () => {
    // A server that staples a useless response has not stopped the authority
    // from answering. Reporting the staple's failure and stopping there would
    // let any server suppress its own revocation check.
    const { responseDer } = recorded('good');
    const wrongStaple = recorded('revoked').responseDer;

    const report = await checkRevocation(materials({ stapled: wrongStaple }), () =>
      Promise.resolve(responseDer),
    );

    expect(report).toMatchObject({ checked: true, status: 'good', source: 'responder' });
  });

  it('reads a revoked certificate as revoked', async () => {
    const { leafDer, issuerDer, responseDer } = recorded('revoked');

    const report = await checkRevocation(
      materials({ leafDer, issuerDer, stapled: responseDer }),
      never,
    );

    expect(report).toMatchObject({ checked: true, status: 'revoked' });
    expect(report.revokedAt).toMatch(/^\d{4}-/);
  });

  it('says so, without a responder, when the certificate names none', async () => {
    // The ordinary state of a healthy site: since 2025 the two largest issuers
    // run no responder at all. `responder` stays null, which is what tells the
    // tool this is nothing to raise.
    const report = await checkRevocation(materials({ responderUrls: [] }), never);

    expect(report).toMatchObject({ checked: false, status: null, responder: null });
    expect(report.unavailableReason).toMatch(/names no OCSP responder/);
  });

  it('keeps a refused staple visible when there is no responder to fall back to', async () => {
    // Stapling an answer about some other certificate is how a server would try
    // to suppress its own revocation check. It is refused either way, but with
    // nowhere to fall back to the refusal is the whole story, and reporting it
    // as "this authority publishes no responder" would hide it.
    const wrongStaple = recorded('revoked').responseDer;

    const report = await checkRevocation(
      materials({ responderUrls: [], stapled: wrongStaple }),
      never,
    );

    expect(report).toMatchObject({ checked: false, status: null, source: 'stapled' });
    expect(report.unavailableReason).toMatch(/could not be used/);
  });

  it('says so when the server sent no issuer to address the question to', async () => {
    const report = await checkRevocation(materials({ issuerDer: null }), never);

    expect(report).toMatchObject({ checked: false, responder: null });
    expect(report.unavailableReason).toMatch(/did not send the certificate's issuer/);
  });

  it('never throws, whatever the responder does', async () => {
    // A revocation check is an extra question asked after a check that already
    // succeeded. A responder having a bad day must not fail an `ssl_check` that
    // has a certificate, a chain and an expiry date to report.
    const report = await checkRevocation(materials(), () =>
      Promise.reject(new CheckError('timeout', 'did not respond within 6s')),
    );

    expect(report).toMatchObject({ checked: false, status: null });
    // The responder is kept, which is what separates "asked and got nothing"
    // from "there was nobody to ask".
    expect(report.responder).toBe('http://ocsp.example.test');
    expect(report.unavailableReason).toMatch(/did not respond within 6s/);
  });

  it('reports an answer it cannot verify as unverified, not as good', async () => {
    const { responseDer } = recorded('good');
    const tampered = Uint8Array.from(responseDer);
    tampered[tampered.length - 1] = (responseDer.at(-1) ?? 0) ^ 0xff;

    const report = await checkRevocation(materials(), () => Promise.resolve(tampered));

    expect(report).toMatchObject({ status: 'good', checked: false, signatureVerified: false });
    expect(report.unavailableReason).toMatch(/signature did not verify/);
  });
});
