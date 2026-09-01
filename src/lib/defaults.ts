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
  /** Fetching one HTML document, reading of the body included. */
  pageMs: 15_000,
  /** Fetching `robots.txt` or a sitemap, which are small and should be quick. */
  supportFileMs: 8_000,
  /**
   * Launching a browser, loading a page and running axe over it.
   *
   * Far longer than any other deadline here, and it has to be: a cold browser
   * start is seconds before the page is even requested, and axe walks the whole
   * rendered tree afterwards.
   */
  browserMs: 45_000,
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
  /**
   * `robots.txt`. Longer than DNS because it changes rarely, and every page a
   * crawl touches has to consult it: caching is what keeps one audit from
   * asking the same host over and over.
   */
  robotsMs: 30 * 60_000,
} as const;

/** Politeness limits applied to every outbound request. */
export const LIMITS = {
  /** Requests in flight across all hosts. */
  maxConcurrentTotal: 5,
  /**
   * Browsers open at once.
   *
   * Counted separately from the request limiter, and not by accident. An audit
   * holds its slot for as long as the page takes — seconds, not milliseconds —
   * while the browser makes requests the limiter never sees. Sharing the pool
   * meant four audits starving every other check of the five slots, without
   * pacing a single one of the browser's own requests. Two is what a laptop
   * running a portfolio can hold without swapping.
   */
  maxConcurrentBrowsers: 2,
  /** Requests in flight to any single host. */
  maxConcurrentPerHost: 1,
  /** Minimum gap between two requests to the same host. */
  minIntervalMs: 500,
  /** Redirect hops followed before the chain is reported as truncated. */
  maxRedirects: 10,
  /** Certificates walked before the chain walk gives up. */
  maxChainDepth: 12,
  /**
   * Bytes of an HTML document read before the rest is abandoned.
   *
   * Two mebibytes is far past any hand-written page and still small enough that
   * a hostile endless response costs nothing. A truncated document is reported
   * as truncated rather than analysed as if it were whole.
   */
  maxHtmlBytes: 2 * 1024 * 1024,
  /** Bytes of a `robots.txt` or sitemap read before the rest is abandoned. */
  maxSupportFileBytes: 512 * 1024,
  /**
   * Internal links whose status is checked on one audit.
   *
   * Every check is one request, paced by the per-host limiter, so this is the
   * difference between an audit that answers in seconds and one that answers in
   * minutes. Links beyond the cap are counted and reported as unchecked, never
   * silently dropped.
   */
  maxLinksChecked: 25,
} as const;

/**
 * Days until a registration expires below which it becomes a warning.
 *
 * Thirty days is the lead time a manual renewal actually needs: an expired card
 * on file, a registrar transfer or an owner who has to be chased all take days,
 * and the quarterly report is built around a 30-day window.
 */
export const DOMAIN_EXPIRY_WARNING_DAYS = 30;

/**
 * Days until a certificate expires below which it becomes a warning.
 *
 * Deliberately shorter than the domain threshold, because certificates renew
 * themselves and registrations do not. ACME issuers sign for 90 days and their
 * clients renew with 30 remaining, so a certificate with 28 days left is a
 * healthy site in the middle of a normal renewal. Warning there would fire on
 * nearly every well-run site in the portfolio and teach the reader to skip the
 * column. By 14 days the automatic renewal has demonstrably failed.
 */
export const CERT_EXPIRY_WARNING_DAYS = 14;
