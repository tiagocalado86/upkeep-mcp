/** Options for {@link createTtlCache}. */
export interface TtlCacheOptions {
  /** Default entry lifetime in milliseconds. */
  ttlMs: number;
  /**
   * Hard bound on entries, so a long-running server cannot grow without limit.
   * The oldest entry is evicted first.
   * @default 500
   */
  maxEntries?: number;
  /** Injected clock, so expiry is testable without fake timers. */
  now?: () => number;
}

/** A time-to-live cache holding one kind of value. */
export interface TtlCache<T> {
  /**
   * Returns the cached value, or runs `load` once and caches what it resolves to.
   *
   * In-flight loads are shared: checking twenty `.com` domains at once makes one
   * request to `rdap.verisign.com`, not twenty. A rejected load is **not**
   * cached, so a transient failure does not poison the entry for its whole TTL.
   */
  fetch(key: string, load: () => Promise<T>): Promise<T>;
  /** The cached value if present and unexpired, without loading anything. */
  peek(key: string): T | undefined;
  /** Stores a value, optionally with a lifetime other than the default. */
  set(key: string, value: T, ttlMs?: number): void;
  /** Drops one entry. */
  delete(key: string): void;
  /** Drops everything. */
  clear(): void;
  /** Number of entries held, including expired ones not yet swept. */
  readonly size: number;
}

interface Entry<T> {
  expiresAt: number;
  /** The promise, not the value, so concurrent misses collapse into one load. */
  value: Promise<T>;
  /** Set once the promise resolves, so `peek` can answer synchronously. */
  settled?: { value: T };
}

/**
 * Creates an in-memory TTL cache.
 *
 * There is no file or database behind this by design — see
 * `docs/adr/0005-in-memory-cache-no-database.md`. RDAP and DNS are slow and
 * change rarely, which is all the caching this tool needs.
 *
 * @param options Lifetime, bound and clock.
 * @returns A cache holding values of one type.
 * @throws Never.
 */
export function createTtlCache<T>(options: TtlCacheOptions): TtlCache<T> {
  const { ttlMs, maxEntries = 500, now = Date.now } = options;
  const entries = new Map<string, Entry<T>>();

  function live(key: string): Entry<T> | undefined {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  function insert(key: string, entry: Entry<T>): void {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) {
      // Map iterates in insertion order, so the first key is the oldest.
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  }

  return {
    fetch(key, load) {
      const existing = live(key);
      if (existing !== undefined) return existing.value;

      const entry: Entry<T> = { expiresAt: now() + ttlMs, value: Promise.resolve() as Promise<T> };
      entry.value = load().then(
        (value) => {
          entry.settled = { value };
          return value;
        },
        (cause: unknown) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw cause;
        },
      );
      insert(key, entry);
      return entry.value;
    },

    peek(key) {
      return live(key)?.settled?.value;
    },

    set(key, value, entryTtlMs) {
      insert(key, {
        expiresAt: now() + (entryTtlMs ?? ttlMs),
        value: Promise.resolve(value),
        settled: { value },
      });
    },

    delete(key) {
      entries.delete(key);
    },

    clear() {
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}
