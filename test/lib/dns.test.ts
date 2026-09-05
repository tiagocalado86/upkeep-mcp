import { MockAgent, setGlobalDispatcher, type Dispatcher, getGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaaRecord as NodeCaaRecord } from 'node:dns';
import { resolveRecords, type DnsResolver } from '../../src/lib/dns.js';
import { CheckError } from '../../src/lib/errors.js';

// `resolveRecords` races every query against one deadline, so nothing inside it
// may talk to a third party: a slow one would spend the whole budget and reject
// a lookup whose other record sets had already arrived. The CAA fallback lives
// in `ports.ts` for that reason. Net connect is disabled here to keep it that
// way, and `asks nothing of the network` below is what actually catches a
// regression — a reintroduced fallback would swallow its own failure and pass.
let agent: MockAgent;
let original: Dispatcher;
let outbound: number;

beforeEach(() => {
  original = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  outbound = 0;
  agent
    .get('https://cloudflare-dns.com')
    .intercept({ path: (path) => path.startsWith('/dns-query'), method: 'GET' })
    .reply(200, () => {
      outbound += 1;
      return { Status: 0, Answer: [] };
    })
    .persist();
});

afterEach(async () => {
  setGlobalDispatcher(original);
  await agent.close();
});

/** Answers each query type with whatever the test supplies. */
function resolver(answers: Partial<Record<keyof DnsResolver, unknown>> = {}): DnsResolver {
  const answer = <T>(key: keyof DnsResolver, fallback: T): Promise<T> => {
    const value = answers[key];
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve((value as T | undefined) ?? fallback);
  };

  return {
    // The www sibling is asked for separately; `byHost` below covers it.
    resolve4: (hostname) =>
      hostname.startsWith('www.') ? Promise.resolve([]) : answer('resolve4', [] as string[]),
    resolve6: () => answer('resolve6', [] as string[]),
    resolveNs: () => answer('resolveNs', [] as string[]),
    resolveMx: () => answer('resolveMx', [] as { exchange: string; priority: number }[]),
    resolveTxt: () => answer('resolveTxt', [] as string[][]),
    resolveCaa: () => answer('resolveCaa', [] as NodeCaaRecord[]),
    cancel: () => undefined,
  };
}

/** A resolver answering per hostname, for the apex-versus-www cases. */
function byHost(answers: Record<string, string[]>): DnsResolver {
  return {
    resolve4: (hostname) => Promise.resolve(answers[hostname] ?? []),
    resolve6: () => Promise.resolve([]),
    resolveNs: () => Promise.resolve([]),
    resolveMx: () => Promise.resolve([]),
    resolveTxt: () => Promise.resolve([]),
    resolveCaa: () => Promise.resolve([]),
    cancel: () => undefined,
  };
}

describe('resolveRecords', () => {
  it('asks nothing of the network, whatever the resolver answers', async () => {
    // A domain with no CAA is the common case, and it is the one that used to
    // trigger an outbound request from inside the deadline. Composing the
    // fallback in `ports.ts` is what keeps a slow endpoint from being reported
    // as `domain_does_not_resolve`.
    const records = await resolveRecords('example.com', 1000, () => resolver());

    expect(records.caa).toEqual([]);
    expect(outbound).toBe(0);
  });

  it('joins the chunks of a TXT record with nothing between them', async () => {
    // A DKIM public key arrives in 255-byte chunks. Joining them with a space
    // silently corrupts the key, and the corruption is invisible in a report.
    const records = await resolveRecords('example.com', 1000, () =>
      resolver({ resolveTxt: [['v=DKIM1; k=rsa; p=MIGfMA0GCS', 'qGSIb3DQEBAQUAA4GN']] }),
    );

    expect(records.txt).toEqual(['v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GN']);
  });

  it('sorts mail exchangers by priority, lowest first', async () => {
    const records = await resolveRecords('example.com', 1000, () =>
      resolver({
        resolveMx: [
          { exchange: 'BACKUP.example.com.', priority: 20 },
          { exchange: 'Primary.example.com.', priority: 10 },
        ],
      }),
    );

    expect(records.mx).toEqual([
      { exchange: 'primary.example.com', priority: 10 },
      { exchange: 'backup.example.com', priority: 20 },
    ]);
  });

  it('lowercases nameservers, drops the trailing dot and sorts them', async () => {
    const records = await resolveRecords('example.com', 1000, () =>
      resolver({ resolveNs: ['NS2.Example.NET.', 'ns1.example.net.'] }),
    );

    expect(records.ns).toEqual(['ns1.example.net', 'ns2.example.net']);
  });

  it('keeps the CAA tag as the property name Node gives it', async () => {
    const records = await resolveRecords('example.com', 1000, () =>
      resolver({
        resolveCaa: [
          { critical: 0, issue: 'letsencrypt.org' },
          { critical: 128, iodef: 'mailto:security@example.com' },
        ] as NodeCaaRecord[],
      }),
    );

    expect(records.caa).toEqual([
      { critical: 0, issue: 'letsencrypt.org' },
      { critical: 128, iodef: 'mailto:security@example.com' },
    ]);
    // An absent tag must be absent, not present and undefined.
    expect('issuewild' in (records.caa[0] ?? {})).toBe(false);
  });

  it('treats a missing record type as empty rather than as a failure', async () => {
    const records = await resolveRecords('example.com', 1000, () =>
      resolver({
        resolve4: ['192.0.2.1'],
        resolveMx: Object.assign(new Error('queryMx ENODATA'), { code: 'ENODATA' }),
      }),
    );

    expect(records.a).toEqual(['192.0.2.1']);
    expect(records.mx).toEqual([]);
  });

  it('reports the apex and www separately', async () => {
    const onlyWww = await resolveRecords('example.com', 1000, () =>
      byHost({ 'www.example.com': ['192.0.2.1'] }),
    );
    expect(onlyWww).toMatchObject({ apexResolves: false, wwwResolves: true });

    const onlyApex = await resolveRecords('example.com', 1000, () =>
      byHost({ 'example.com': ['192.0.2.1'] }),
    );
    expect(onlyApex).toMatchObject({ apexResolves: true, wwwResolves: false });
  });

  it('resolves nothing for a name that does not exist, without throwing', async () => {
    const records = await resolveRecords('nx.example', 1000, () => byHost({}));

    expect(records).toMatchObject({ apexResolves: false, wwwResolves: false, ns: [] });
  });

  it('cancels the resolver when the deadline passes, and says so', async () => {
    const cancel = vi.fn();
    const hanging: DnsResolver = {
      resolve4: () => new Promise(() => undefined),
      resolve6: () => new Promise(() => undefined),
      resolveNs: () => new Promise(() => undefined),
      resolveMx: () => new Promise(() => undefined),
      resolveTxt: () => new Promise(() => undefined),
      resolveCaa: () => new Promise(() => undefined),
      cancel,
    };

    const error = await resolveRecords('slow.example', 10, () => hanging).catch(
      (cause: unknown) => cause,
    );

    // node:dns ignores AbortSignal entirely; cancel() is the only thing that
    // actually stops a query, so it must be called.
    expect(cancel).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(CheckError);
    expect((error as CheckError).code).toBe('timeout');
    expect((error as CheckError).message).toContain('slow.example');
  });
});
