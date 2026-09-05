import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DnsRecords } from '../types.js';
import { CheckError } from './errors.js';
import { runAxe, type AxeRun } from './axe.js';
import { createTtlCache } from './cache.js';
import { LIMITS, TTL } from './defaults.js';
import {
  hasDsRecord,
  resolveAddresses,
  resolveCaaOverDoh,
  resolveRecords,
  type DnsResolver,
} from './dns.js';
import { getText, httpHop, type HttpHopResult, type TextResult } from './http-client.js';
import {
  allowAnyTarget,
  allowOnlyPublicTargets,
  type TargetGuard,
  type WebProtocol,
} from './public-target.js';
import { createMemoryHistory, type RunHistory } from './history.js';
import { createHostLimiter } from './rate-limit.js';
import { fetchRobots, type RobotsFetch } from './robots.js';
import { lookupDomain, type RdapLookup } from './rdap.js';
import { daysUntil } from './severity.js';
import { inspectTls, type TlsInspection } from './tls.js';

/**
 * The I/O boundary.
 *
 * Tools reach the network only through these interfaces, which is what makes
 * "no tool performs I/O directly" a fact the compiler enforces rather than a
 * convention. Tests pass fakes; nothing mocks a Node builtin.
 */

/** DNS lookups. */
export interface DnsClient {
  /** Every record set for a domain and its `www` sibling. */
  resolveRecords(domain: string): Promise<DnsRecords>;
  /** Whether the parent zone publishes a DS record, or `null` if unestablished. */
  hasDsRecord(domain: string): Promise<boolean | null>;
}

/** Registration lookups over RDAP. */
export interface RdapClient {
  /** Registration facts for a registrable domain. */
  lookupDomain(registrable: string, now: Date): Promise<RdapLookup>;
}

/** TLS handshakes. */
export interface TlsProbe {
  /** Connects and reports on the certificate served for `host`. */
  inspect(host: string, port: number, names: readonly string[]): Promise<TlsInspection>;
}

/** Single HTTP requests, never following redirects. */
export interface HttpProbe {
  /** One hop. */
  hop(url: string, timeoutMs: number, signal?: AbortSignal): Promise<HttpHopResult>;
  /** A whole document, following redirects, read up to a byte limit. */
  text(url: string, timeoutMs: number, maxBytes: number): Promise<TextResult>;
}

/** Auditing a rendered page in a real browser. */
export interface BrowserProbe {
  /**
   * Runs axe-core over a page.
   *
   * @throws {CheckError} `not_found` when no browser is installed.
   */
  audit(url: string, tags: readonly string[]): Promise<AxeRun>;
}

/** Reading local files the user pointed this server at. */
export interface FileReader {
  /**
   * Reads a UTF-8 text file.
   *
   * @throws {CheckError} `not_found` when it does not exist, `invalid_input`
   *   when it is not a `.json` file, `unexpected` for anything else.
   */
  readText(path: string): Promise<string>;
}

/** `robots.txt` lookups. */
export interface RobotsClient {
  /** The rules an origin publishes, e.g. for `https://example.com`. */
  forOrigin(origin: string): Promise<RobotsFetch>;
}

/** Everything a tool may reach for. */
export interface Ports {
  dns: DnsClient;
  rdap: RdapClient;
  tls: TlsProbe;
  http: HttpProbe;
  robots: RobotsClient;
  browser: BrowserProbe;
  files: FileReader;
  /** What the previous portfolio run found, for reporting what changed. */
  history: RunHistory;
  /** Injected so a report's timestamps and day counts are deterministic in tests. */
  now(): Date;
}

/**
 * The shared caches and limiter.
 *
 * Module-level rather than per-call, so that a `portfolio_report` running twenty
 * sites collapses their overlapping RDAP and DNS work. Created lazily so that
 * importing a tool module opens nothing.
 */
let shared: {
  dnsCache: ReturnType<typeof createTtlCache<DnsRecords>>;
  dsCache: ReturnType<typeof createTtlCache<boolean | null>>;
  rdapCache: ReturnType<typeof createTtlCache<RdapLookup>>;
  tlsCache: ReturnType<typeof createTtlCache<TlsInspection>>;
  robotsCache: ReturnType<typeof createTtlCache<RobotsFetch>>;
  history: RunHistory;
  limiter: ReturnType<typeof createHostLimiter>;
  browsers: ReturnType<typeof createHostLimiter>;
} | null = null;

/**
 * @returns The process-wide caches and rate limiter, creating them on first use.
 * @throws Never.
 */
function sharedState(): NonNullable<typeof shared> {
  shared ??= {
    dnsCache: createTtlCache<DnsRecords>({ ttlMs: TTL.dnsMs }),
    dsCache: createTtlCache<boolean | null>({ ttlMs: TTL.dnsMs }),
    rdapCache: createTtlCache<RdapLookup>({ ttlMs: TTL.rdapMs }),
    tlsCache: createTtlCache<TlsInspection>({ ttlMs: TTL.tlsMs }),
    robotsCache: createTtlCache<RobotsFetch>({ ttlMs: TTL.robotsMs }),
    history: createMemoryHistory(),
    limiter: createHostLimiter({
      minIntervalMs: LIMITS.minIntervalMs,
      maxConcurrentPerHost: LIMITS.maxConcurrentPerHost,
      maxConcurrentTotal: LIMITS.maxConcurrentTotal,
    }),
    browsers: createHostLimiter({
      minIntervalMs: LIMITS.minIntervalMs,
      maxConcurrentPerHost: LIMITS.maxConcurrentPerHost,
      maxConcurrentTotal: LIMITS.maxConcurrentBrowsers,
    }),
  };
  return shared;
}

/**
 * Whether a DNS lookup found the domain at all.
 *
 * Exported for its own test: it decides how long a "nothing here" answer is
 * cached, which is the difference between noticing a fixed delegation in a
 * minute and noticing it in five.
 *
 * A name that does not exist is not an error from `resolveRecords` — every
 * record set simply comes back empty — so without this the answer would be
 * cached as confidently as a real one, and a delegation that has just been
 * fixed would keep looking broken for a full TTL.
 *
 * @param records What the resolver returned.
 * @returns `true` if any record of any kind was found.
 * @throws Never.
 */
export function foundAnything(records: DnsRecords): boolean {
  return (
    records.apexResolves ||
    records.wwwResolves ||
    records.ns.length > 0 ||
    records.mx.length > 0 ||
    records.txt.length > 0
  );
}

/**
 * Resolves a domain's records, asking DNS-over-HTTPS for CAA when the platform's
 * own resolver returned none.
 *
 * The two are composed here rather than inside `resolveRecords` for the same
 * reason `hasDsRecord` is a separate call: `resolveRecords` races every query
 * against one deadline, so a slow third party inside it can spend the whole
 * budget and reject a lookup whose other five record sets had already arrived.
 * `domain_check` reads that rejection as `domain_does_not_resolve`, critical —
 * a healthy site at the top of a portfolio report because Cloudflare was slow.
 *
 * Here the fallback runs only after the lookup has already succeeded, cannot
 * fail it, and goes through the same per-host limiter as every other
 * third-party call. Without that pacing, a twenty-site `portfolio_report` would
 * open twenty unpaced requests to one endpoint, and a throttled response reads
 * as `[]` — the very silent absence the fallback exists to remove.
 *
 * @param domain Hostname in A-label form.
 * @param limiter The per-host limiter, so this is paced like every other
 *   third-party call.
 * @returns The records, with CAA filled in from the fallback when the resolver
 *   returned none.
 * Exported for its own test: the pacing and the "cannot fail the lookup"
 * guarantee are the whole point of it, and neither is observable through
 * {@link createDefaultPorts}, which builds a real resolver.
 *
 * @param domain Hostname in A-label form.
 * @param limiter The per-host limiter, so this is paced like every other
 *   third-party call.
 * @param createResolver Builds the resolver. Injected for tests only.
 * @returns The records, with CAA filled in from the fallback when the resolver
 *   returned none.
 * @throws {CheckError} Whatever `resolveRecords` throws. The fallback itself
 *   never throws, so it cannot turn a healthy domain into a failed lookup.
 */
export async function resolveRecordsWithCaa(
  domain: string,
  limiter: ReturnType<typeof createHostLimiter>,
  createResolver?: () => DnsResolver,
): Promise<DnsRecords> {
  const records = await resolveRecords(domain, undefined, createResolver);
  if (records.caa.length > 0) return records;

  const caa = await limiter.run('cloudflare-dns.com', () => resolveCaaOverDoh(domain));
  return { ...records, caa };
}

/** How a set of ports treats the targets it is asked about. */
export interface PortOptions {
  /**
   * Refuse anything that is not public unicast on port 443.
   *
   * Off by default, which is right for a server running on someone's own
   * machine: pointing it at a staging box on the local network is exactly what
   * a maintenance tool is for. The HTTP entrypoint turns it on, because the
   * same freedom offered to strangers is an instance-metadata reader.
   */
  publicTargetsOnly?: boolean;
}

/**
 * @param url The target.
 * @param protocol Its scheme, already narrowed to one this project requests.
 * @returns The port the request will actually reach, filled in from the scheme
 *   when the URL leaves it implicit.
 * @throws Never.
 */
function portOf(url: URL, protocol: WebProtocol): number {
  if (url.port !== '') return Number(url.port);
  return protocol === 'https:' ? 443 : 80;
}

/**
 * Applies the whole target policy to one URL: the host and the port.
 *
 * Every outbound request goes through here rather than through `assertPublic`
 * alone. The port was checked on the TLS path and nowhere else, so a public
 * deployment promising "only the web ports" would still fetch
 * `https://some-host:22/` and report back whether the connection was refused —
 * a port scan run from someone else's address, which is exactly what
 * `docs/adr/0012-public-target-guard.md` says the guard exists to prevent.
 *
 * @param guard The policy in force.
 * @param url The target.
 * @throws {CheckError} `invalid_input` when the host or the port is refused;
 *   `not_found` when the host resolves to nothing.
 */
async function assertReachable(guard: TargetGuard, url: URL): Promise<void> {
  // The address first, then the port. A loopback URL on some high port is
  // refused for being loopback, which is what the caller needs to hear; saying
  // "that is not a web port" of `http://127.0.0.1:9229/` would be true and
  // useless.
  await guard.assertPublic(url.hostname);

  // A scheme this project never requests has no policy here on purpose:
  // deciding it in a second place is how the first gap opened.
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    guard.assertPort(portOf(url, url.protocol), url.protocol);
  }
}

/**
 * Rewrites the "no browser is installed" refusal for a caller who is not on
 * this machine.
 *
 * `runAxe` names `npx playwright install chromium`, which is the fix on the
 * machine the server runs on. A public instance is somebody else's machine and
 * ships no browser on purpose
 * (`docs/adr/0013-playwright-core-and-an-optional-browser.md`), so that advice
 * is unfollowable there — and it reads as a broken deployment rather than as a
 * documented limit of the hosted instance.
 *
 * Exported for its own test: the hosted instance is the one configuration this
 * project cannot exercise offline, since the machine running the suite has a
 * browser.
 *
 * @param cause Whatever the audit threw.
 * @returns Never.
 * @throws {CheckError} `not_found` worded for a remote caller when the browser
 *   was missing; the original failure, untouched, for anything else.
 */
export function rethrowForRemoteCaller(cause: unknown): never {
  if (cause instanceof CheckError && cause.code === 'not_found') {
    throw new CheckError(
      'not_found',
      'this server runs no browser, so accessibility_audit cannot run here; every other check can. ' +
        'To audit a page, run the server on your own machine: `npx -y upkeep-mcp`, then ' +
        '`npx playwright install chromium` once',
      { cause },
    );
  }
  throw cause;
}

/**
 * Builds the real ports, with caching and per-host rate limiting wired in.
 *
 * The limiter is keyed by the host actually contacted, never by the domain being
 * asked about: twenty `.com` domains all reach `rdap.verisign.com`, and a
 * limiter keyed on the input would pace nothing.
 *
 * @param options How to treat the targets. See {@link PortOptions}.
 * @returns Ports backed by real network I/O.
 * @throws Never.
 */
export function createDefaultPorts(options: PortOptions = {}): Ports {
  const { dnsCache, dsCache, rdapCache, tlsCache, robotsCache, history, limiter, browsers } =
    sharedState();
  const guard: TargetGuard =
    options.publicTargetsOnly === true
      ? allowOnlyPublicTargets((hostname) => resolveAddresses(hostname))
      : allowAnyTarget();

  return {
    dns: {
      resolveRecords: (domain) =>
        dnsCache.fetch(
          domain,
          () => resolveRecordsWithCaa(domain, limiter),
          (records) => (foundAnything(records) ? TTL.dnsMs : TTL.dnsNegativeMs),
        ),
      hasDsRecord: (domain) =>
        dsCache.fetch(
          domain,
          () => limiter.run('cloudflare-dns.com', () => hasDsRecord(domain)),
          // `null` means the resolver would not answer, not that the zone is
          // unsigned, so it is a miss and is held for the shorter time.
          (signed) => (signed === null ? TTL.dnsNegativeMs : TTL.dnsMs),
        ),
    },
    rdap: {
      lookupDomain: async (registrable, now) => {
        const lookup = await rdapCache.fetch(registrable, () => lookupDomain(registrable, now));
        // The cached entry outlives a day boundary, so the day count is derived
        // fresh from the cached date rather than served stale.
        return {
          ...lookup,
          registration: {
            ...lookup.registration,
            daysUntilExpiry: daysUntil(lookup.registration.expiresAt, now),
          },
        };
      },
    },
    tls: {
      inspect: async (host, port, names) => {
        guard.assertPort(port, 'https:');
        await guard.assertPublic(host);
        return tlsCache.fetch(`${host}:${String(port)}|${names.join(',')}`, () =>
          limiter.run(host, () => inspectTls(host, port, names)),
        );
      },
    },
    http: {
      // Never cached: caching an uptime check defeats the tool.
      hop: async (url, timeoutMs, signal) => {
        await assertReachable(guard, new URL(url));
        return limiter.run(new URL(url).host, () => httpHop(url, timeoutMs, signal));
      },
      text: async (url, timeoutMs, maxBytes) => {
        await assertReachable(guard, new URL(url));
        const result = await limiter.run(new URL(url).host, () =>
          getText(url, timeoutMs, maxBytes),
        );
        // `getText` follows redirects, so the URL that was checked and the URL
        // that answered are not necessarily the same host.
        await assertReachable(guard, new URL(result.url));
        return result;
      },
    },
    robots: {
      // Cached per origin: an audit consults the rules before every request it
      // makes, and asking the host each time would be the opposite of polite.
      forOrigin: async (origin) => {
        await assertReachable(guard, new URL(origin));
        return robotsCache.fetch(origin, () =>
          limiter.run(new URL(origin).host, () => fetchRobots(origin)),
        );
      },
    },
    browser: {
      // Its own pool, not the request limiter's. An audit holds a slot for
      // seconds while the browser makes requests nothing here counts, so
      // sharing the pool starved every other check without pacing any of the
      // browser's own traffic. Still one at a time per host, which is the part
      // that was politeness rather than bookkeeping.
      //
      // The page's own URL and everything it embeds go through the same
      // policy: `runAxe` is handed the check and applies it to every request
      // the browser makes. Before that, only the page URL was inspected, and a
      // single `<img>` was enough to make the server fetch anything.
      audit: async (url, tags) => {
        await assertReachable(guard, new URL(url));
        const run = await browsers
          .run(new URL(url).host, () =>
            runAxe(url, tags, undefined, (target) => assertReachable(guard, target)),
          )
          // Only on a public instance: locally, "install a browser" is exactly
          // the right thing to tell the person who started the server.
          .catch((cause: unknown) => {
            if (options.publicTargetsOnly === true) rethrowForRemoteCaller(cause);
            throw cause;
          });
        // Where it ended, not only where it was sent: a public URL that
        // redirects to loopback would otherwise return that page's title and
        // selectors to the caller.
        await assertReachable(guard, new URL(run.url));
        return run;
      },
    },
    files: { readText: readTextFile },
    history,
    now: () => new Date(),
  };
}

/**
 * Reads a portfolio file from disk.
 *
 * Restricted to `.json` on purpose. The only local file this server has any
 * business reading is a portfolio list, and a tool that will open whatever path
 * it is handed is a tool that can be talked into reading something else.
 *
 * @param path Path to the file, absolute or relative to the working directory.
 * @returns The file contents as UTF-8 text.
 * @throws {CheckError} `invalid_input` for a path that is not a `.json` file,
 *   `not_found` when there is nothing there, `unexpected` otherwise.
 */
async function readTextFile(path: string): Promise<string> {
  if (!path.toLowerCase().endsWith('.json')) {
    throw new CheckError('invalid_input', `${path} is not a .json file`);
  }

  try {
    return await readFile(resolve(path), 'utf8');
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new CheckError('not_found', `there is no file at ${resolve(path)}`);
    }
    throw new CheckError(
      'unexpected',
      `could not read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
