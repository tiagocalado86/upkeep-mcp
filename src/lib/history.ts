import type { CheckName } from './portfolio.js';
import type { Severity } from '../types.js';

/**
 * What the last portfolio run found, so the next one can say what changed.
 *
 * Held in memory for the life of the server process and nowhere else. A
 * portfolio file names a person's clients, and "what was wrong with which
 * client site last Tuesday" is not something this project writes to disk — see
 * `docs/adr/0011-in-memory-run-history.md`. The consequence is honest and
 * stated in the output: a fresh process has nothing to compare against, and
 * says so rather than implying nothing changed.
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

/** Storage for the previous run. */
export interface RunHistory {
  /** The last recorded run, or `null` when this process has not seen one. */
  previous(): RunSnapshot | null;
  /** Records a run, replacing whatever was there. */
  record(snapshot: RunSnapshot): void;
}

/**
 * Creates in-memory run history.
 *
 * @returns History holding exactly one snapshot: the previous run. Keeping more
 *   would be a database with extra steps, and the report only ever asks "what
 *   changed since last time".
 * @throws Never.
 */
export function createMemoryHistory(): RunHistory {
  let last: RunSnapshot | null = null;

  return {
    previous: () => last,
    record: (snapshot) => {
      last = snapshot;
    },
  };
}
