import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TTL } from '../../src/lib/defaults.js';
import {
  createDurableHistory,
  createMemoryHistory,
  historyStoreFor,
  type HistoryStore,
  type RunSnapshot,
} from '../../src/lib/history.js';

/**
 * Run history, and the one thing it must never do: make an empty answer look
 * like a calm one.
 *
 * Every path through this module ends in either a snapshot or a sentence
 * explaining why there is none. A first run, a file that is not there yet, a
 * file somebody else wrote, a baseline from two quarters ago and a directory
 * that cannot be written to are five different situations, and a report that
 * renders them all as "no change" is worse than one that never compared.
 */

const MEMORY: HistoryStore = { kind: 'memory' };
const NOW = new Date('2026-09-06T12:00:00.000Z');

/**
 * @param overrides Fields to change.
 * @returns A snapshot of one site.
 */
function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    takenAt: '2026-09-05T12:00:00.000Z',
    sites: {
      'https://example.com/': { severity: 'warning', codes: ['a'], checks: ['uptime'] },
    },
    ...overrides,
  };
}

describe('historyStoreFor', () => {
  it('is memory when the portfolio names no history file', () => {
    // The default, and the whole of the opt-in: without that line the server
    // writes nothing at all.
    expect(historyStoreFor('/Users/you/sites.json', null)).toEqual({ kind: 'memory' });
  });

  it('resolves a relative path against the portfolio file, not the working directory', () => {
    // A desktop client starts this server in `/`. Resolving against the working
    // directory would put a file named after the user's clients at `/`, or fail,
    // and either way "beside my sites.json" is the only reading anyone intends.
    expect(historyStoreFor('/Users/you/clients/sites.json', 'upkeep-history.json')).toEqual({
      kind: 'file',
      path: '/Users/you/clients/upkeep-history.json',
    });
  });

  it('takes an absolute path as given', () => {
    expect(historyStoreFor('/Users/you/sites.json', '/var/tmp/h.json')).toEqual({
      kind: 'file',
      path: '/var/tmp/h.json',
    });
  });

  it('is memory for an inline portfolio, which has no file to sit beside', () => {
    expect(historyStoreFor(null, 'upkeep-history.json')).toEqual({ kind: 'memory' });
  });
});

describe('createMemoryHistory', () => {
  it('says why a first run has nothing to compare against', async () => {
    const previous = await createMemoryHistory().previous(MEMORY, NOW);

    expect(previous.snapshot).toBeNull();
    expect(previous.unavailableReason).toMatch(/nothing survived the last restart/);
  });

  it('returns the run it was given', async () => {
    const history = createMemoryHistory();
    await history.record(MEMORY, snapshot());

    expect((await history.previous(MEMORY, NOW)).snapshot).toEqual(snapshot());
  });

  it('keeps only the most recent run', async () => {
    const history = createMemoryHistory();
    await history.record(MEMORY, snapshot({ takenAt: '2026-09-04T12:00:00.000Z' }));
    await history.record(MEMORY, snapshot({ takenAt: '2026-09-05T12:00:00.000Z' }));

    expect((await history.previous(MEMORY, NOW)).snapshot?.takenAt).toBe(
      '2026-09-05T12:00:00.000Z',
    );
  });

  it('keeps two portfolios apart', async () => {
    // One server may be asked about several portfolios. Comparing one against
    // the other would report every site of each as new, every time.
    const history = createMemoryHistory();
    const a: HistoryStore = { kind: 'file', path: '/a.json' };
    const b: HistoryStore = { kind: 'file', path: '/b.json' };

    await history.record(a, snapshot());

    expect((await history.previous(a, NOW)).snapshot).not.toBeNull();
    expect((await history.previous(b, NOW)).snapshot).toBeNull();
  });

  it('does not share state between instances', async () => {
    const first = createMemoryHistory();
    await first.record(MEMORY, snapshot());

    expect((await createMemoryHistory().previous(MEMORY, NOW)).snapshot).toBeNull();
  });
});

describe('createDurableHistory', () => {
  let directory: string;
  let store: HistoryStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'upkeep-history-'));
    store = { kind: 'file', path: join(directory, 'upkeep-history.json') };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes nothing at all for a memory store', async () => {
    // The default path through this code. A portfolio that did not ask for a
    // file must not get one.
    const history = createDurableHistory();
    await history.record(MEMORY, snapshot());

    await expect(readFile(join(directory, 'upkeep-history.json'), 'utf8')).rejects.toThrow();
  });

  it('survives a restart, which is the whole point', async () => {
    await createDurableHistory().record(store, snapshot());

    // A second instance stands in for a second server process: it shares no
    // memory with the first, so anything it finds came off the disk.
    const previous = await createDurableHistory().previous(store, NOW);

    expect(previous.snapshot).toEqual(snapshot());
    expect(previous.unavailableReason).toBeNull();
  });

  it('writes a file only its owner can read', async () => {
    // It names a person's clients and says which of them were broken. On a
    // shared machine the default umask would hand that to every other account.
    await createDurableHistory().record(store, snapshot());
    const mode = (await stat((store as { path: string }).path)).mode & 0o777;

    expect(mode).toBe(0o600);
  });

  it('says the file is not there yet rather than saying nothing changed', async () => {
    const previous = await createDurableHistory().previous(store, NOW);

    expect(previous.snapshot).toBeNull();
    expect(previous.unavailableReason).toMatch(
      /no history file at .* yet, so this run creates one/,
    );
  });

  it('ignores a file it did not write, and says it will replace it', async () => {
    // Someone pointing `history` at an existing file of their own must not have
    // it read as a portfolio run — and must be told, because silence here is
    // indistinguishable from a first run.
    await writeFile((store as { path: string }).path, '{"hello":"world"}');
    const previous = await createDurableHistory().previous(store, NOW);

    expect(previous.snapshot).toBeNull();
    expect(previous.unavailableReason).toMatch(/not one this server wrote/);
  });

  it('ignores a file that is not JSON at all', async () => {
    await writeFile((store as { path: string }).path, 'not json {{{');

    expect((await createDurableHistory().previous(store, NOW)).snapshot).toBeNull();
  });

  it('replaces a corrupt file on the next run, so it heals itself', async () => {
    await writeFile((store as { path: string }).path, 'not json {{{');
    const history = createDurableHistory();

    await history.previous(store, NOW);
    await history.record(store, snapshot());

    expect((await createDurableHistory().previous(store, NOW)).snapshot).toEqual(snapshot());
  });

  it('refuses a baseline older than the comparison window, and says how old', async () => {
    // "Improved since March" in a weekly review is noise dressed as
    // information: every certificate has renewed twice by then.
    const stale = new Date(NOW.getTime() - TTL.historyMs - 86_400_000).toISOString();
    await createDurableHistory().record(store, snapshot({ takenAt: stale }));

    const previous = await createDurableHistory().previous(store, NOW);

    expect(previous.snapshot).toBeNull();
    expect(previous.unavailableReason).toMatch(/91 days ago and past the 90-day window/);
  });

  it('accepts a baseline exactly at the edge of the window', async () => {
    const edge = new Date(NOW.getTime() - TTL.historyMs).toISOString();
    await createDurableHistory().record(store, snapshot({ takenAt: edge }));

    expect((await createDurableHistory().previous(store, NOW)).snapshot).not.toBeNull();
  });

  it('reports a write it could not make, rather than failing the report', async () => {
    // A report that found an expired certificate is worth having even when it
    // cannot be filed. Failing the tool over the bookkeeping throws away the
    // answer.
    const unwritable: HistoryStore = { kind: 'file', path: join(directory, 'nope', 'h.json') };
    const outcome = await createDurableHistory().record(unwritable, snapshot());

    expect(outcome.stored).toBe(false);
    expect(outcome.reason).toMatch(/could not be recorded to/);
  });

  it('reports a file it could not read for a reason other than absence', async () => {
    const asDirectory: HistoryStore = { kind: 'file', path: directory };
    const previous = await createDurableHistory().previous(asDirectory, NOW);

    expect(previous.snapshot).toBeNull();
    expect(previous.unavailableReason).toMatch(/could not be read/);
  });
});
