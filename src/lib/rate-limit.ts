/** Options for {@link createHostLimiter}. */
export interface HostLimiterOptions {
  /** Minimum gap between two requests to the same host, in milliseconds. */
  minIntervalMs: number;
  /** How many requests may be in flight to one host at a time. */
  maxConcurrentPerHost: number;
  /** How many requests may be in flight across all hosts at a time. */
  maxConcurrentTotal: number;
  /** Injected clock, so pacing is testable without real time. */
  now?: () => number;
  /** Injected sleep, so tests never actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Paces outbound work so no single host is hammered. */
export interface HostLimiter {
  /**
   * Runs `task` once a slot for `host` is free and the minimum interval has
   * elapsed.
   *
   * @param host The host that will actually be contacted.
   * @param task The work to run.
   * @returns Whatever `task` resolves to.
   */
  run<T>(host: string, task: () => Promise<T>): Promise<T>;
}

interface HostState {
  active: number;
  lastStartedAt: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Creates a per-host limiter.
 *
 * **Key it by the host that is actually contacted, not by the domain being asked
 * about.** Twenty different `.com` domains all resolve to one RDAP server, so a
 * limiter keyed on the input domain would let twenty simultaneous requests hit
 * `rdap.verisign.com` while appearing to rate-limit correctly.
 *
 * @param options Pacing limits, plus the clock and sleep to use.
 * @returns A limiter.
 * @throws Never.
 */
export function createHostLimiter(options: HostLimiterOptions): HostLimiter {
  const {
    minIntervalMs,
    maxConcurrentPerHost,
    maxConcurrentTotal,
    now = Date.now,
    sleep = defaultSleep,
  } = options;

  const hosts = new Map<string, HostState>();
  const waiting: (() => void)[] = [];
  let activeTotal = 0;

  function stateFor(host: string): HostState {
    let state = hosts.get(host);
    if (state === undefined) {
      // Number.NEGATIVE_INFINITY so a host's first request never waits.
      state = { active: 0, lastStartedAt: Number.NEGATIVE_INFINITY };
      hosts.set(host, state);
    }
    return state;
  }

  /**
   * Drops hosts that are idle and past their interval. Deleting a host's state
   * the moment it goes idle would discard `lastStartedAt` and silently defeat
   * the minimum interval, so entries are only removed once that interval has
   * elapsed and can no longer affect pacing.
   */
  function prune(): void {
    if (hosts.size <= 1000) return;
    const cutoff = now() - minIntervalMs;
    for (const [host, state] of hosts) {
      if (state.active === 0 && state.lastStartedAt <= cutoff) hosts.delete(host);
    }
  }

  async function acquire(host: string): Promise<void> {
    prune();
    for (;;) {
      const state = stateFor(host);
      const hasSlot = activeTotal < maxConcurrentTotal && state.active < maxConcurrentPerHost;

      if (!hasSlot) {
        await new Promise<void>((resolve) => waiting.push(resolve));
        continue;
      }

      const waitMs = state.lastStartedAt + minIntervalMs - now();
      if (waitMs > 0) {
        await sleep(waitMs);
        continue;
      }

      state.active += 1;
      state.lastStartedAt = now();
      activeTotal += 1;
      return;
    }
  }

  /**
   * Wakes everyone waiting, rather than the one at the front of the queue.
   *
   * A freed slot is not usable by every waiter: the one at the front may be
   * queued behind another request to its own host, and waking only it spends
   * the wake-up on a waiter that goes straight back to the queue while the slot
   * it could not use sits idle until some other task happens to finish. Callers
   * queue in bulk — `seo_audit` dispatches a page's whole link list at once —
   * so most of the queue is ineligible at any moment, and one-at-a-time waking
   * collapsed a portfolio run to roughly a quarter of its throughput.
   *
   * Waking all of them is safe because the re-check is the same loop that
   * queued them: whoever cannot proceed goes back to waiting, and JavaScript's
   * single thread means the slot is claimed before the next waiter looks.
   */
  function wakeAll(): void {
    for (const wake of waiting.splice(0)) wake();
  }

  function release(host: string): void {
    const state = stateFor(host);
    state.active -= 1;
    activeTotal -= 1;
    wakeAll();
  }

  return {
    async run(host, task) {
      await acquire(host);
      try {
        return await task();
      } finally {
        release(host);
      }
    },
  };
}
