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
  /**
   * One OCSP query to a certificate authority's responder.
   *
   * Shorter than an HTTP hop on purpose. This is an extra question asked on top
   * of a check that has already succeeded, so a slow responder must not be able
   * to dominate the time an `ssl_check` takes; the answer is worth having, and
   * it is not worth waiting ten seconds for.
   */
  ocspMs: 6_000,
  /** One HTTP hop. */
  httpHopMs: 10_000,
  /** The whole redirect chain, however many hops it takes. */
  httpChainMs: 20_000,
  /** Fetching one HTML document, reading of the body included. */
  pageMs: 15_000,
  /** Fetching `robots.txt` or a sitemap, which are small and should be quick. */
  supportFileMs: 8_000,
  /**
   * One question to one authoritative nameserver, over TCP.
   *
   * Longer than a resolver query because it is a TCP connection to a server on
   * the other side of the world rather than a UDP round trip to one down the
   * street, and shorter than an HTTP hop because a nameserver that takes five
   * seconds to answer its own SOA is itself the finding.
   */
  nameserverMs: 5_000,
  /**
   * A whole crawl, however many pages it visits.
   *
   * Two minutes, and it is a stop rather than a failure: what was crawled up to
   * it is reported with the reason it stopped. The per-host limiter paces one
   * request every half second, so this is roughly what a hundred pages of a
   * slow site costs, and a tool that can run for longer than a client waits is
   * a tool nobody runs twice.
   */
  crawlMs: 120_000,
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
   * OCSP answers, keyed by certificate fingerprint.
   *
   * Responders publish an answer good for about a week and pre-sign it, so
   * asking twice inside an hour returns the identical bytes. An hour is short
   * against that and long enough that a twenty-site portfolio report run twice
   * in a morning asks each certificate authority once.
   */
  ocspMs: 60 * 60_000,
  /**
   * `robots.txt`. Longer than DNS because it changes rarely, and every page a
   * crawl touches has to consult it: caching is what keeps one audit from
   * asking the same host over and over.
   */
  robotsMs: 30 * 60_000,
  /**
   * How far back a recorded portfolio run may be and still be called "last
   * time".
   *
   * A quarter, because the quarterly report is the unit this project is built
   * around: two full runs a quarter apart is the comparison a retainer actually
   * produces, and anything inside that window is a baseline worth having.
   * Beyond it the comparison stops meaning anything — every certificate has
   * renewed twice by then, so "improved since March" in a weekly review is
   * noise dressed as information. An expired baseline is reported with its date
   * and its age rather than silently ignored.
   */
  historyMs: 90 * 24 * 60 * 60_000,
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
  /**
   * Bytes of an OCSP response read before the rest is abandoned.
   *
   * Real responses are a few hundred bytes; the largest observed here was 623.
   * Sixty-four kibibytes is far past any legitimate answer and still small
   * enough that a responder streaming forever costs nothing.
   */
  maxOcspResponseBytes: 64 * 1024,
  /** Bytes of a `robots.txt` or sitemap read before the rest is abandoned. */
  maxSupportFileBytes: 512 * 1024,
  /**
   * Bytes a gzipped sitemap may unpack to before it is refused.
   *
   * The compressed read is already capped at `maxSupportFileBytes`, so this is
   * the second half of the same bound: without it, half a mebibyte of gzip can
   * expand to hundreds of mebibytes, and a decompressor that trusts its input
   * is the classic way to be handed one. Sixteen mebibytes is roughly thirty
   * times the compressed cap and comfortably past a full 50,000-URL sitemap,
   * which is about ten megabytes of XML; anything beyond it is not a sitemap.
   */
  maxSitemapUnpackedBytes: 16 * 1024 * 1024,
  /**
   * Nameservers asked directly about a zone.
   *
   * Eight is past what any delegation needs — RFC 1034 suggests two or three,
   * and the largest hosts publish four — and it is a bound on a zone that
   * publishes a hundred of them, which is a cheap way to make one check cost a
   * hundred connections. Which ones were left out is reported rather than
   * silently dropped.
   */
  maxNameserversQueried: 8,
  /**
   * Pages one crawl will fetch.
   *
   * The budget ADR 0010 said a crawl would have to arrive with. Every page is
   * one request paced by the per-host limiter at one every half second, so
   * twenty-five is about fifteen seconds and the hundred this allows is about a
   * minute. Pages found and not visited are counted and reported, never
   * silently dropped.
   */
  maxPagesCrawled: 25,
  /** Pages one crawl will fetch at the very most, whatever the caller asks for. */
  maxPagesCrawledCeiling: 100,
  /**
   * Links deep from the entry page a crawl will follow.
   *
   * Three levels reaches everything a small business site has; past that the
   * page count is the real bound anyway.
   */
  maxCrawlDepth: 3,
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
