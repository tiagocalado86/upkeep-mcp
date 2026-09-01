/**
 * Admission control for a publicly reachable instance.
 *
 * Every other limit in this project protects the hosts being checked. This one
 * protects the instance doing the checking, and the person paying for its
 * egress: a public MCP endpoint that fetches URLs on request is a free proxy
 * unless something says no.
 */

/** What a caller is allowed to do right now. */
export type Admission =
  { ok: true; release: () => void } | { ok: false; status: number; message: string };

/** How much traffic one instance will take. */
export interface InboundLimits {
  /** Sustained requests per minute, per client. */
  perClientPerMinute: number;
  /** How many a client may spend at once before the sustained rate applies. */
  burst: number;
  /** Requests in flight across all clients. */
  maxConcurrent: number;
  /** Clients tracked at once, so the bookkeeping cannot grow without limit. */
  maxClients: number;
}

/** One client's token bucket. */
interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Creates an inbound limiter: a token bucket per client and one global
 * concurrency cap.
 *
 * A bucket rather than a fixed window because the honest shape of demo traffic
 * is a burst — a client connects, lists tools, calls two of them — followed by
 * nothing. A fixed window either refuses that burst or permits a flood.
 *
 * @param limits How much traffic to take.
 * @param now Injected clock, so the refill can be tested without waiting.
 * @returns A limiter. Every successful admission **must** be released, or the
 *   concurrency slot leaks.
 * @throws Never.
 */
export function createInboundLimiter(
  limits: InboundLimits,
  now: () => number = Date.now,
): { admit(client: string): Admission; readonly inFlight: number } {
  const buckets = new Map<string, Bucket>();
  let inFlight = 0;

  const refill = (bucket: Bucket): void => {
    const elapsed = now() - bucket.lastRefill;
    const earned = (elapsed / 60_000) * limits.perClientPerMinute;
    if (earned <= 0) return;
    bucket.tokens = Math.min(limits.burst, bucket.tokens + earned);
    bucket.lastRefill = now();
  };

  return {
    get inFlight() {
      return inFlight;
    },

    admit(client) {
      if (inFlight >= limits.maxConcurrent) {
        return {
          ok: false,
          status: 503,
          message: 'this demo instance is busy; try again in a moment',
        };
      }

      let bucket = buckets.get(client);
      if (bucket === undefined) {
        bucket = { tokens: limits.burst, lastRefill: now() };
        // Map iterates in insertion order, so the first key is the least
        // recently created. A flood of distinct addresses must not become a
        // memory leak.
        if (buckets.size >= limits.maxClients) {
          const oldest = buckets.keys().next();
          if (oldest.done !== true) buckets.delete(oldest.value);
        }
      } else {
        refill(bucket);
      }
      buckets.set(client, bucket);

      if (bucket.tokens < 1) {
        return {
          ok: false,
          status: 429,
          message: `this demo instance allows ${String(limits.perClientPerMinute)} requests a minute; run it locally for more`,
        };
      }

      bucket.tokens -= 1;
      inFlight += 1;
      let released = false;
      return {
        ok: true,
        release: () => {
          // Guarded because a double release would let the cap drift upwards
          // until it stopped capping anything.
          if (released) return;
          released = true;
          inFlight -= 1;
        },
      };
    },
  };
}

/**
 * Identifies the client behind a request.
 *
 * @param forwardedFor The `X-Forwarded-For` header, which a platform proxy
 *   sets and a direct caller can forge. Trusting it is right behind Cloud Run
 *   and wrong on the open internet; either way, the worst a forged value buys
 *   is a fresh bucket, which the global concurrency cap still contains.
 * @param socketAddress The peer address, used when there is no header.
 * @returns A key to rate limit on.
 * @throws Never.
 */
export function clientKey(
  forwardedFor: string | undefined,
  socketAddress: string | undefined,
): string {
  const first = forwardedFor?.split(',')[0]?.trim();
  if (first !== undefined && first !== '') return first;
  return socketAddress ?? 'unknown';
}
