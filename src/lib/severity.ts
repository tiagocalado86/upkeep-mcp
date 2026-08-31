import type { Finding, Severity } from '../types.js';

/**
 * Rank used to compare severities. `unknown` sits below `warning` on purpose:
 * not knowing something is worth surfacing, but it must never outrank a fact.
 */
const RANK: Record<Severity, number> = {
  ok: 0,
  info: 1,
  unknown: 2,
  warning: 3,
  critical: 4,
};

/**
 * Whole days from `now` until `iso`, floored.
 *
 * Floored rather than rounded so that "expires in 30 minutes" reads as `0` days
 * and not as `1`. In a maintenance report, something expiring today should say
 * today. Negative values mean it already expired.
 *
 * @param iso An ISO 8601 timestamp, or `null` when the date is unknown.
 * @param now The moment to measure from.
 * @returns Whole days, or `null` when `iso` is `null` or unparseable.
 * @throws Never.
 */
export function daysUntil(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;
  return Math.floor((target - now.getTime()) / 86_400_000);
}

/**
 * Grades how urgent an expiry is.
 *
 * @param days Whole days until expiry, or `null` when unknown.
 * @param warnDays Threshold below which an expiry becomes a warning. Callers pass
 *   the per-site value from the portfolio file; the default matches the 30-day
 *   window the quarterly report is built around.
 * @returns `unknown` when `days` is `null`, `critical` once expired or within a
 *   week, `warning` within `warnDays`, otherwise `ok`.
 * @throws Never.
 */
export function expirySeverity(days: number | null, warnDays = 30): Severity {
  if (days === null) return 'unknown';
  if (days <= 7) return 'critical';
  if (days <= warnDays) return 'warning';
  return 'ok';
}

/**
 * The worst severity among some findings.
 *
 * @param findings Findings to reduce. An empty list means nothing was wrong.
 * @returns The highest-ranked severity present, or `ok` when there are none.
 * @throws Never.
 */
export function worstSeverity(findings: readonly Finding[]): Severity {
  let worst: Severity = 'ok';
  for (const finding of findings) {
    if (RANK[finding.severity] > RANK[worst]) worst = finding.severity;
  }
  return worst;
}

/**
 * Builds a {@link Finding}. A one-line helper, but it keeps the argument order
 * consistent at every call site.
 *
 * @param code Stable machine identifier.
 * @param severity How much attention it needs.
 * @param message One sentence a client would understand.
 * @returns The finding.
 * @throws Never.
 */
export function finding(code: string, severity: Severity, message: string): Finding {
  return { code, severity, message };
}
