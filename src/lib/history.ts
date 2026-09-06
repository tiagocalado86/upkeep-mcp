import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import * as z from 'zod/v4';
import { TTL } from './defaults.js';
import { CHECK_NAMES, type CheckName } from './portfolio.js';
import type { Severity } from '../types.js';

/**
 * What the last portfolio run found, so the next one can say what changed.
 *
 * Held in memory by default and written nowhere. A portfolio file names a
 * person's clients, and "what was wrong with which client site last Tuesday" is
 * not something this server puts on someone's disk uninvited —
 * `docs/adr/0011-in-memory-run-history.md` is the reasoning, and it ends by
 * saying that persistence, if it ever arrives, belongs behind this same
 * interface and has to be opted into.
 *
 * That is what a `history` path in the portfolio file is:
 * `docs/adr/0018-opt-in-history-file.md`. The user names a file, in the file
 * they already keep and already know the location of, and this server writes one
 * snapshot to it. Without that line nothing changes and nothing is written.
 */

/** One site's outcome, reduced to what a comparison needs. */
export interface SiteOutcome {
  /** The worst severity found for that site. */
  severity: Severity;
  /** The finding codes reported, so new problems can be named. */
  codes: string[];
  /**
   * Which checks produced it.
   *
   * Without this a comparison lies. The tool's own description recommends a
   * quick `checks: ["uptime"]` pass; comparing that against a full run would
   * report every certificate and registration finding as newly appeared, or —
   * worse, in the other order — announce that a site with a certificate
   * expiring in three days has improved from critical to ok.
   */
  checks: CheckName[];
}

/** The outcome of one whole run. */
export interface RunSnapshot {
  /** When the run happened, ISO 8601 UTC. */
  takenAt: string;
  /** Outcomes keyed by site URL. */
  sites: Record<string, SiteOutcome>;
}

/**
 * Where one portfolio's history lives.
 *
 * Per call rather than per server, because the answer comes out of the portfolio
 * file being reported on: two portfolios checked by one server keep separate
 * histories, and a report over sites passed inline keeps none at all.
 */
export type HistoryStore =
  /** This process's memory, lost on restart. The default, and what the user gets unasked. */
  | { kind: 'memory' }
  /** A file the user named in their portfolio. */
  | { kind: 'file'; path: string };

/** What there was to compare against, and why there was nothing when there was nothing. */
export interface PreviousRun {
  /** The previous run, or `null` when there is none usable. */
  snapshot: RunSnapshot | null;
  /**
   * Why there is none, worded to be read aloud — `no history file at /…/x.json
   * yet; this run creates it`. `null` when there is one.
   *
   * Never silence. An empty list of regressions must not be readable as
   * "nothing regressed", and a history file that exists but could not be read
   * must not be readable as "this is the first run".
   */
  unavailableReason: string | null;
}

/** Whether a run was recorded, and why not when it was not. */
export interface RecordOutcome {
  /** Whether the snapshot was stored. */
  stored: boolean;
  /** Why it was not, or `null` when it was. */
  reason: string | null;
}

/** Storage for the previous run. */
export interface RunHistory {
  /**
   * The last recorded run for a portfolio.
   *
   * @param store Where that portfolio's history lives.
   * @param now The moment to measure the snapshot's age against.
   */
  previous(store: HistoryStore, now: Date): Promise<PreviousRun>;
  /**
   * Records a run, replacing whatever was there.
   *
   * @param store Where that portfolio's history lives.
   * @param snapshot What this run found.
   */
  record(store: HistoryStore, snapshot: RunSnapshot): Promise<RecordOutcome>;
}

/**
 * The on-disk form.
 *
 * Versioned from the first release that writes one. A file this server both
 * writes and reads back is a format, and a format with no version is one that
 * can never change without silently misreading its own past output.
 */
const fileSchema = z.object({
  version: z.literal(1),
  takenAt: z.iso.datetime(),
  sites: z.record(
    z.string(),
    z.object({
      severity: z.enum(['ok', 'info', 'warning', 'critical', 'unknown']),
      codes: z.array(z.string()),
      checks: z.array(z.enum(CHECK_NAMES)),
    }),
  ),
});

/**
 * Permissions for a history file this server creates.
 *
 * Owner read and write, nothing else. The file names a person's client sites and
 * says which of them were broken; on a shared machine the default umask would
 * hand that to every other account on it. Applied at creation only, which is
 * what `writeFile` supports — a file the user has since widened is theirs to
 * widen.
 */
const OWNER_ONLY = 0o600;

/**
 * Works out where a portfolio's history belongs.
 *
 * A relative path is resolved against the portfolio file's own directory, not
 * against the working directory. That is the difference between a working
 * setting and a puzzling one: a desktop MCP client starts this server in `/`,
 * which `portfolio_report`'s own input description already warns about, so
 * `"history": "upkeep-history.json"` has to mean "beside my sites.json" or it
 * means nothing anyone can predict.
 *
 * @param portfolioFile The portfolio file being reported on, or `null` when the
 *   sites were passed inline.
 * @param setting The `history` path from that file, or `null` when it names none.
 * @returns Where to keep the history. Memory whenever the user has not asked for
 *   otherwise, and memory for an inline portfolio, which has no file to sit
 *   beside and no identity to persist under.
 * @throws Never.
 */
export function historyStoreFor(
  portfolioFile: string | null,
  setting: string | null,
): HistoryStore {
  if (setting === null) return { kind: 'memory' };
  if (isAbsolute(setting)) return { kind: 'file', path: setting };
  if (portfolioFile === null) return { kind: 'memory' };

  return { kind: 'file', path: resolve(dirname(resolve(portfolioFile)), setting) };
}

/**
 * Creates run history that keeps a snapshot in memory and nowhere else.
 *
 * A file store handed to this is honoured in memory: it is the fallback for a
 * server that must not write, and the implementation tests inject when they are
 * testing something other than the file itself.
 *
 * @returns History holding exactly one snapshot per store. Keeping more would be
 *   a database with extra steps, and the report only ever asks "what changed
 *   since last time".
 * @throws Never.
 */
export function createMemoryHistory(): RunHistory {
  const byStore = new Map<string, RunSnapshot>();

  return {
    previous: (store, now) => {
      const snapshot = byStore.get(keyOf(store)) ?? null;
      if (snapshot === null) {
        return Promise.resolve({
          snapshot: null,
          unavailableReason: firstRunReason(store),
        });
      }
      return Promise.resolve(withinWindow(snapshot, now, 'this server started'));
    },
    record: (store, snapshot) => {
      byStore.set(keyOf(store), snapshot);
      return Promise.resolve({ stored: true, reason: null });
    },
  };
}

/**
 * Creates run history that honours a file store.
 *
 * @returns History that keeps a memory store in memory and a file store in the
 *   file the user named. Nothing is written unless a portfolio asked for it.
 * @throws Never.
 */
export function createDurableHistory(): RunHistory {
  const memory = createMemoryHistory();

  return {
    previous: async (store, now) => {
      if (store.kind === 'memory') return memory.previous(store, now);

      let text: string;
      try {
        text = await readFile(store.path, 'utf8');
      } catch (cause) {
        const code = (cause as { code?: string }).code;
        return {
          snapshot: null,
          unavailableReason:
            code === 'ENOENT'
              ? `there is no history file at ${store.path} yet, so this run creates one`
              : `the history file at ${store.path} could not be read: ${messageOf(cause)}`,
        };
      }

      const parsed = parseSnapshot(text);
      if (parsed === null) {
        // Not an error the run should carry: `record` overwrites it at the end
        // of this very report, so the problem fixes itself. Saying so is still
        // required, because "unreadable" must not read as "first run".
        return {
          snapshot: null,
          unavailableReason:
            `the history file at ${store.path} is not one this server wrote, so it was ignored ` +
            'and will be replaced by this run',
        };
      }

      return withinWindow(parsed, now, `the file at ${store.path} was written`);
    },

    record: async (store, snapshot) => {
      if (store.kind === 'memory') return memory.record(store, snapshot);

      try {
        await writeFile(store.path, `${JSON.stringify({ version: 1, ...snapshot }, null, 2)}\n`, {
          encoding: 'utf8',
          mode: OWNER_ONLY,
        });
        return { stored: true, reason: null };
      } catch (cause) {
        // Never thrown onwards. A report that found an expired certificate is
        // worth having even when it cannot be filed, and failing the whole tool
        // over a write would throw away the answer to keep the bookkeeping.
        return {
          stored: false,
          reason: `this run could not be recorded to ${store.path}: ${messageOf(cause)}`,
        };
      }
    },
  };
}

/**
 * Refuses a snapshot too old to be called "last time".
 *
 * A baseline from two quarters ago compares this week against a portfolio where
 * every certificate has since renewed twice. It is not wrong so much as
 * meaningless, and a report that says "improved since March" in a weekly review
 * is noise dressed as information.
 *
 * @param snapshot The snapshot that was found.
 * @param now The moment to measure against.
 * @param since How the snapshot got there, for the message.
 * @returns The snapshot, or nothing with the age explained.
 * @throws Never.
 */
function withinWindow(snapshot: RunSnapshot, now: Date, since: string): PreviousRun {
  const ageMs = now.getTime() - new Date(snapshot.takenAt).getTime();
  if (Number.isNaN(ageMs) || ageMs <= TTL.historyMs) {
    return { snapshot, unavailableReason: null };
  }

  const days = Math.floor(ageMs / 86_400_000);
  const window = Math.floor(TTL.historyMs / 86_400_000);
  return {
    snapshot: null,
    unavailableReason:
      `the last recorded run was ${snapshot.takenAt.slice(0, 10)}, ${String(days)} days ago and ` +
      `past the ${String(window)}-day window a comparison uses, so ${since} is where this ` +
      'report starts from',
  };
}

/**
 * @param store Where the history lives.
 * @returns Why a first run has nothing to compare against, said in the terms
 *   that apply to that store.
 * @throws Never.
 */
function firstRunReason(store: HistoryStore): string {
  return store.kind === 'file'
    ? `no run has been recorded to ${store.path} yet`
    : 'this server has not run a report on this portfolio before, and the portfolio names no ' +
        'history file, so nothing survived the last restart';
}

/**
 * @param text The file contents.
 * @returns The snapshot, or `null` when the text is not one this server wrote.
 * @throws Never.
 */
function parseSnapshot(text: string): RunSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) return null;

  return { takenAt: parsed.data.takenAt, sites: parsed.data.sites };
}

/**
 * @param store Where the history lives.
 * @returns A key that separates one portfolio's history from another's within
 *   one process, so a server asked about two portfolios does not compare one
 *   against the other.
 * @throws Never.
 */
function keyOf(store: HistoryStore): string {
  return store.kind === 'memory' ? '' : store.path;
}

/**
 * @param cause Whatever was thrown.
 * @returns Its message, or its rendering when it is not an error.
 * @throws Never.
 */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
