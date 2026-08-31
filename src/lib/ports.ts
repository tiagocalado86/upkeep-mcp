import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DnsRecords } from '../types.js';
import { CheckError } from './errors.js';
import { createTtlCache } from './cache.js';
import { LIMITS, TTL } from './defaults.js';
import { hasDsRecord, resolveRecords } from './dns.js';
import { getText, httpHop, type HttpHopResult, type TextResult } from './http-client.js';
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
 * Builds the real ports, with caching and per-host rate limiting wired in.
 *
 * The limiter is keyed by the host actually contacted, never by the domain being
 * asked about: twenty `.com` domains all reach `rdap.verisign.com`, and a
 * limiter keyed on the input would pace nothing.
 *
 * @returns Ports backed by real network I/O.
 * @throws Never.
 */
export function createDefaultPorts(): Ports {
  const { dnsCache, dsCache, rdapCache, tlsCache, robotsCache, history, limiter } = sharedState();

  return {
    dns: {
      // Not rate limited: these go to the system resolver, not to a third party.
      resolveRecords: (domain) =>
        dnsCache.fetch(
          domain,
          () => resolveRecords(domain),
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
      inspect: (host, port, names) =>
        tlsCache.fetch(`${host}:${String(port)}|${names.join(',')}`, () =>
          limiter.run(host, () => inspectTls(host, port, names)),
        ),
    },
    http: {
      // Never cached: caching an uptime check defeats the tool.
      hop: (url, timeoutMs, signal) =>
        limiter.run(new URL(url).host, () => httpHop(url, timeoutMs, signal)),
      text: (url, timeoutMs, maxBytes) =>
        limiter.run(new URL(url).host, () => getText(url, timeoutMs, maxBytes)),
    },
    robots: {
      // Cached per origin: an audit consults the rules before every request it
      // makes, and asking the host each time would be the opposite of polite.
      forOrigin: (origin) =>
        robotsCache.fetch(origin, () =>
          limiter.run(new URL(origin).host, () => fetchRobots(origin)),
        ),
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
