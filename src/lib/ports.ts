import type { DnsRecords } from '../types.js';
import { createTtlCache } from './cache.js';
import { LIMITS, TTL } from './defaults.js';
import { hasDsRecord, resolveRecords } from './dns.js';
import { httpHop, type HttpHopResult } from './http-client.js';
import { createHostLimiter } from './rate-limit.js';
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
}

/** Everything a tool may reach for. */
export interface Ports {
  dns: DnsClient;
  rdap: RdapClient;
  tls: TlsProbe;
  http: HttpProbe;
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
    limiter: createHostLimiter({
      minIntervalMs: LIMITS.minIntervalMs,
      maxConcurrentPerHost: LIMITS.maxConcurrentPerHost,
      maxConcurrentTotal: LIMITS.maxConcurrentTotal,
    }),
  };
  return shared;
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
  const { dnsCache, dsCache, rdapCache, tlsCache, limiter } = sharedState();

  return {
    dns: {
      // Not rate limited: these go to the system resolver, not to a third party.
      resolveRecords: (domain) => dnsCache.fetch(domain, () => resolveRecords(domain)),
      hasDsRecord: (domain) =>
        dsCache.fetch(domain, () => limiter.run('cloudflare-dns.com', () => hasDsRecord(domain))),
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
    },
    now: () => new Date(),
  };
}
