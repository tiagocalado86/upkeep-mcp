import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../../src/lib/concurrency.js';

/** A promise that resolves when someone calls its `release`. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('mapWithConcurrency', () => {
  it('returns results in input order, not completion order', async () => {
    const results = await mapWithConcurrency([30, 20, 10], 3, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return delay;
    });

    expect(results).toEqual([30, 20, 10]);
  });

  it('never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, index) => index),
      4,
      async (value) => {
        running += 1;
        peak = Math.max(peak, running);
        await Promise.resolve();
        running -= 1;
        return value;
      },
    );

    expect(peak).toBeLessThanOrEqual(4);
  });

  it('starts the next job as soon as a slot frees, rather than in batches', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];

    const work = mapWithConcurrency([0, 1, 2], 2, async (index) => {
      started.push(index);
      await gates[index]?.promise;
      return index;
    });

    await Promise.resolve();
    expect(started).toEqual([0, 1]);

    // Freeing one slot must let the third job start, without waiting for the
    // other job in the batch.
    gates[0]?.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);

    gates[1]?.release();
    gates[2]?.release();
    await expect(work).resolves.toEqual([0, 1, 2]);
  });

  it('treats a limit below one as one', async () => {
    let peak = 0;
    let running = 0;

    await mapWithConcurrency([1, 2, 3], 0, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running -= 1;
      return value;
    });

    expect(peak).toBe(1);
  });

  it('does nothing with an empty list', async () => {
    await expect(
      mapWithConcurrency([], 5, () => Promise.reject(new Error('never'))),
    ).resolves.toEqual([]);
  });

  it('propagates the first rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, (value) =>
        value === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(value),
      ),
    ).rejects.toThrow('boom');
  });
});
