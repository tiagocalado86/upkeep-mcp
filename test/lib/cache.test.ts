import { describe, expect, it, vi } from 'vitest';
import { createTtlCache } from '../../src/lib/cache.js';

describe('createTtlCache', () => {
  it('loads once and serves the cached value afterwards', async () => {
    const cache = createTtlCache<string>({ ttlMs: 1000 });
    const load = vi.fn(() => Promise.resolve('value'));

    await expect(cache.fetch('k', load)).resolves.toBe('value');
    await expect(cache.fetch('k', load)).resolves.toBe('value');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent misses into a single load', async () => {
    const cache = createTtlCache<string>({ ttlMs: 1000 });
    const load = vi.fn(() => Promise.resolve('value'));

    // This is what stops twenty .com domains making twenty RDAP requests.
    await Promise.all([cache.fetch('k', load), cache.fetch('k', load), cache.fetch('k', load)]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads once the entry has expired', async () => {
    let clock = 0;
    const cache = createTtlCache<string>({ ttlMs: 1000, now: () => clock });
    const load = vi.fn(() => Promise.resolve('value'));

    await cache.fetch('k', load);
    clock = 999;
    await cache.fetch('k', load);
    expect(load).toHaveBeenCalledTimes(1);

    clock = 1000;
    await cache.fetch('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed load, so a blip does not poison the entry', async () => {
    const cache = createTtlCache<string>({ ttlMs: 60_000 });
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('value');

    await expect(cache.fetch('k', load)).rejects.toThrow('transient');
    await expect(cache.fetch('k', load)).resolves.toBe('value');
    expect(cache.size).toBe(1);
  });

  it('peeks without loading, and only once the value has settled', async () => {
    const cache = createTtlCache<string>({ ttlMs: 1000 });
    expect(cache.peek('k')).toBeUndefined();

    const inFlight = cache.fetch('k', () => Promise.resolve('value'));
    expect(cache.peek('k')).toBeUndefined();

    await inFlight;
    expect(cache.peek('k')).toBe('value');
  });

  it('does not peek an expired value', () => {
    let clock = 0;
    const cache = createTtlCache<string>({ ttlMs: 1000, now: () => clock });
    cache.set('k', 'value');

    clock = 1000;
    expect(cache.peek('k')).toBeUndefined();
  });

  it('honours a per-entry lifetime', () => {
    let clock = 0;
    const cache = createTtlCache<string>({ ttlMs: 60_000, now: () => clock });
    cache.set('short', 'value', 100);

    clock = 100;
    expect(cache.peek('short')).toBeUndefined();
  });

  it('evicts the oldest entry once the bound is reached', async () => {
    const cache = createTtlCache<string>({ ttlMs: 60_000, maxEntries: 2 });
    await cache.fetch('a', () => Promise.resolve('1'));
    await cache.fetch('b', () => Promise.resolve('2'));
    await cache.fetch('c', () => Promise.resolve('3'));

    expect(cache.size).toBe(2);
    expect(cache.peek('a')).toBeUndefined();
    expect(cache.peek('c')).toBe('3');
  });

  it('drops entries on delete and clear', async () => {
    const cache = createTtlCache<string>({ ttlMs: 60_000 });
    await cache.fetch('a', () => Promise.resolve('1'));
    await cache.fetch('b', () => Promise.resolve('2'));

    cache.delete('a');
    expect(cache.peek('a')).toBeUndefined();
    expect(cache.size).toBe(1);

    cache.clear();
    expect(cache.size).toBe(0);
  });
});
