/**
 * Timeouts, lifetimes and limits, gathered in one place so the numbers a report
 * depends on are reviewable together rather than scattered through the code.
 *
 * Every one of these is a deliberate choice, not a default inherited from a
 * library. The reasoning for the awkward ones is in the comments.
 */

/** Network deadlines, in milliseconds. */
export const TIMEOUTS = {
  /**
   * Whole-operation deadline for a DNS query.
   *
   * This is enforced by racing the query against a timer and calling
   * `resolver.cancel()`, **not** by the resolver's own `timeout` option. That
   * option is per attempt and backs off exponentially per round, so the worst
   * case is roughly `timeout × (2 ** tries - 1)`: with Node's default of four
   * tries, a nominal 2s timeout can hang for about 30 seconds.
   */
  dnsMs: 4_000,
  /** Per-attempt timeout handed to the resolver, paired with a single try. */
  dnsAttemptMs: 2_000,
  /** One RDAP request. */
  rdapMs: 8_000,
  /** The IANA bootstrap file, fetched at most once per process. */
  bootstrapMs: 5_000,
  /**
   * TLS handshake. Enforced with an explicit timer that destroys the socket:
   * `tls.connect`'s own `timeout` option emits an event but leaves the socket
   * open.
   */
  tlsMs: 8_000,
  /** One HTTP hop. */
  httpHopMs: 10_000,
  /** The whole redirect chain, however many hops it takes. */
  httpChainMs: 20_000,
} as const;

/** Cache lifetimes, in milliseconds. */
export const TTL = {
  /** DNS answers. Short, because a records change is exactly what a check should catch. */
  dnsMs: 5 * 60_000,
  /**
   * DNS misses. Much shorter than a hit: a delegation that has just been fixed
   * must not keep looking broken for five minutes.
   */
  dnsNegativeMs: 60_000,
  /** RDAP responses. Registration data changes on renewal, not hourly. */
  rdapMs: 6 * 60 * 60_000,
  /** TLS probes. */
  tlsMs: 15 * 60_000,
} as const;

/** Politeness limits applied to every outbound request. */
export const LIMITS = {
  /** Requests in flight across all hosts. */
  maxConcurrentTotal: 5,
  /** Requests in flight to any single host. */
  maxConcurrentPerHost: 1,
  /** Minimum gap between two requests to the same host. */
  minIntervalMs: 500,
  /** Redirect hops followed before the chain is reported as truncated. */
  maxRedirects: 10,
  /** Certificates walked before the chain walk gives up. */
  maxChainDepth: 12,
} as const;

/** Days until expiry below which a certificate or registration becomes a warning. */
export const DEFAULT_EXPIRY_WARNING_DAYS = 30;
