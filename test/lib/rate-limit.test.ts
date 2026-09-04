import { describe, expect, it, vi } from 'vitest';
import { createHostLimiter } from '../../src/lib/rate-limit.js';

/**
 * A controllable clock and sleep, so pacing is asserted without waiting.
 *
 * @returns The injectables plus the running virtual time.
 */
function fakeTime(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  read: () => number;
} {
  let clock = 0;
  return {
    now: () => clock,
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
    read: () => clock,
  };
}

describe('createHostLimiter', () => {
  it('runs the task and returns its value', async () => {
    const time = fakeTime();
    const limiter = createHostLimiter({
      minIntervalMs: 500,
      maxConcurrentPerHost: 1,
      maxConcurrentTotal: 5,
      ...time,
    });

    await expect(limiter.run('a.example', () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('does not delay the first request to a host', async () => {
    const time = fakeTime();
    const limiter = createHostLimiter({
      minIntervalMs: 500,
      maxConcurrentPerHost: 1,
      maxConcurrentTotal: 5,
      ...time,
    });

    await limiter.run('a.example', () => Promise.resolve(null));
    expect(time.read()).toBe(0);
  });

  it('spaces consecutive requests to the same host', async () => {
    const time = fakeTime();
    const limiter = createHostLimiter({
      minIntervalMs: 500,
      maxConcurrentPerHost: 1,
      maxConcurrentTotal: 5,
      ...time,
    });

    await limiter.run('a.example', () => Promise.resolve(null));
    await limiter.run('a.example', () => Promise.resolve(null));
    expect(time.read()).toBe(500);
  });

  it('does not make one host wait for another', async () => {
    const time = fakeTime();
    const limiter = createHostLimiter({
      minIntervalMs: 500,
      maxConcurrentPerHost: 1,
      maxConcurrentTotal: 5,
      ...time,
    });

    await limiter.run('a.example', () => Promise.resolve(null));
    await limiter.run('b.example', () => Promise.resolve(null));
    expect(time.read()).toBe(0);
  });

  it('keeps pacing a host after it has gone idle', async () => {
    // Discarding a host's state the moment it goes idle would lose the time of
    // its last request and silently defeat the interval.
    const time = fakeTime();
    const limiter = createHostLimiter({
      minIntervalMs: 500,
      maxConcurrentPerHost: 1,
      maxConcurrentTotal: 5,
      ...time,
    });

    await limiter.run('a.example', () => Promise.resolve(null));
    await limiter.run('b.example', () => Promise.resolve(null));
    await limiter.run('a.example', () => Promise.resolve(null));
    expect(time.read()).toBe(500);
  });

  it('holds concurrent work to one request per host at a time', async () => {
    const limiter = createHostLimiter({
      minIntervalMs: 0,
      maxConcurrentPerHost: 1,
      maxConcurrentTotal: 5,
    });

    let inFlight = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    };

    await Promise.all([1, 2, 3, 4].map(() => limiter.run('a.example', task)));
    expect(peak).toBe(1);
  });

  it('caps concurrency across all hosts', async () => {
    const limiter = createHostLimiter({
      minIntervalMs: 0,
      maxConcurrentPerHost: 1,
      maxConcurrentTotal: 2,
    });

    let inFlight = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    };

    await Promise.all(['a', 'b', 'c', 'd'].map((host) => limiter.run(host, task)));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('releases the slot even when the task throws', async () => {
    const limiter = createHostLimiter({
      minIntervalMs: 0,
      maxConcurrentPerHost: 1,
      maxConcurrentTotal: 1,
    });

    await expect(limiter.run('a.example', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    // A leaked slot would make this hang rather than fail.
    await expect(limiter.run('a.example', () => Promise.resolve('fine'))).resolves.toBe('fine');
  });

  it('runs tasks under the host they actually contact', async () => {
    // Twenty .com domains all reach one RDAP server; keying on the input domain
    // would pace nothing at all.
    const time = fakeTime();
    const limiter = createHostLimiter({
      minIntervalMs: 500,
      maxConcurrentPerHost: 1,
      maxConcurrentTotal: 5,
      ...time,
    });

    const seen = vi.fn();
    await limiter.run('rdap.verisign.com', () => Promise.resolve(seen('a.com')));
    await limiter.run('rdap.verisign.com', () => Promise.resolve(seen('b.com')));

    expect(seen).toHaveBeenCalledTimes(2);
    expect(time.read()).toBe(500);
  });

  it('gives a freed slot to a waiter that can use it, not to the front of the queue', async () => {
    // Callers queue in bulk — a page's whole link list goes to the limiter at
    // once — so the front of the queue is usually another request to a host
    // that is already busy. Waking only that one spends the wake-up on a waiter
    // which cannot move, and the freed slot idles until something else finishes.
    const limiter = createHostLimiter({
      minIntervalMs: 0,
      maxConcurrentPerHost: 1,
      maxConcurrentTotal: 2,
    });

    let openGate = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    let thirdHostRan = false;

    // Holds one of the two slots for as long as the gate stays shut.
    const holdingASlot = limiter.run('a.example', () => gate);
    // Queued behind it, on the same host: cannot use a slot freed by anyone.
    const stuckBehindIt = limiter.run('a.example', () => Promise.resolve());
    // Takes the second slot and gives it straight back.
    const givesTheSlotBack = limiter.run('b.example', () => Promise.resolve());
    // Queued last, on an idle host: the only waiter the freed slot fits.
    const wantsTheFreedSlot = limiter.run('c.example', () => {
      thirdHostRan = true;
      return Promise.resolve();
    });

    await givesTheSlotBack;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(thirdHostRan).toBe(true);

    openGate();
    await Promise.all([holdingASlot, stuckBehindIt, wantsTheFreedSlot]);
  });

  it('keeps two pools independent, which is why browsers get their own', async () => {
    // An audit holds its slot for seconds. Sharing one pool with the request
    // limiter meant a handful of audits starved every other check, while pacing
    // none of the browser's own traffic.
    const requests = createHostLimiter({
      minIntervalMs: 0,
      maxConcurrentPerHost: 1,
      maxConcurrentTotal: 2,
    });
    const browsers = createHostLimiter({
      minIntervalMs: 0,
      maxConcurrentPerHost: 1,
      maxConcurrentTotal: 1,
    });

    let held = 0;
    const forever = new Promise<void>(() => undefined);
    void browsers.run('a.example', () => {
      held += 1;
      return forever;
    });

    let ranAnyway = false;
    void requests.run('b.example', () => {
      ranAnyway = true;
      return Promise.resolve();
    });

    // The limiter admits work on a microtask, not synchronously.
    await Promise.resolve();
    await Promise.resolve();

    expect(held).toBe(1);
    expect(ranAnyway).toBe(true);
  });
});
