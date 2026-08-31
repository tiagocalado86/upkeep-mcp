import type { CaaRecord as NodeCaaRecord } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import type { CaaRecord, DnsRecords, MxRecord } from '../types.js';
import { TIMEOUTS } from './defaults.js';
import { CheckError, categorise } from './errors.js';
import { getJson } from './http-client.js';

/**
 * Cloudflare's DNS-over-HTTPS JSON endpoint.
 *
 * Used for one thing only — asking whether a DS record exists — because
 * `node:dns` cannot query DS, DNSKEY or RRSIG at all and exposes no AD flag.
 */
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

/** DS is record type 43. */
const RRTYPE_DS = 43;

/**
 * Resolves every record a maintenance check cares about, for a domain and its
 * `www` sibling.
 *
 * Uses `dns.resolve*`, never `dns.lookup`: `lookup` is `getaddrinfo(3)`, so it
 * consults `/etc/hosts`, search domains and the OS cache, and collapses every
 * failure into `ENOTFOUND`. That makes it useless for answering "does this
 * domain actually exist in the DNS".
 *
 * A record type that is simply absent (`ENODATA`) is an empty array, not an
 * error — only a total failure to reach a resolver is.
 *
 * @param domain Hostname in A-label form.
 * @param timeoutMs Whole-operation deadline.
 * @returns Every record set, plus whether the apex and `www` resolve.
 * @throws {CheckError} `timeout` when the deadline passes.
 */
export async function resolveRecords(
  domain: string,
  timeoutMs: number = TIMEOUTS.dnsMs,
): Promise<DnsRecords> {
  // One try, because the resolver's own timeout is per attempt and backs off
  // exponentially per round: with Node's default of four tries, a 2s timeout can
  // take about 30 seconds to give up. The real deadline is the race below.
  const resolver = new Resolver({ timeout: TIMEOUTS.dnsAttemptMs, tries: 1 });

  const work = Promise.all([
    optional(() => resolver.resolve4(domain)),
    optional(() => resolver.resolve6(domain)),
    optional(() => resolver.resolveNs(domain)),
    optional(() => resolver.resolveMx(domain)),
    optional(() => resolver.resolveTxt(domain)),
    optional(() => resolver.resolveCaa(domain)),
    optional(() => resolver.resolve4(`www.${domain}`)),
    optional(() => resolver.resolve6(`www.${domain}`)),
  ]);

  const [a, aaaa, ns, mx, txt, caa, wwwA, wwwAaaa] = await withDeadline(
    work,
    resolver,
    timeoutMs,
    domain,
  );

  return {
    apexResolves: a.length > 0 || aaaa.length > 0,
    wwwResolves: wwwA.length > 0 || wwwAaaa.length > 0,
    a,
    aaaa,
    ns: ns.map(normaliseHostname).sort(),
    mx: mx
      .map((record): MxRecord => ({
        exchange: normaliseHostname(record.exchange),
        priority: record.priority,
      }))
      .sort((left, right) => left.priority - right.priority),
    // Each TXT record arrives as an array of 255-byte chunks. They must be joined
    // with nothing between them: joining with a space silently corrupts long
    // values such as a DKIM public key.
    txt: txt.map((chunks) => chunks.join('')),
    caa: caa.map(toCaaRecord),
  };
}

/**
 * Asks whether the parent zone publishes a DS record for this domain.
 *
 * This establishes that the delegation is signed. It does **not** validate a
 * DNSSEC chain, and nothing in this project claims to.
 *
 * @param domain Hostname in A-label form.
 * @param timeoutMs Deadline for the query.
 * @returns `true` when a DS record exists, `false` when the zone is genuinely
 *   unsigned, `null` when the resolver could not answer authoritatively.
 * @throws Never — an unreachable resolver is reported as `null`, since a DNSSEC
 *   answer is never worth failing a whole domain check over.
 */
export async function hasDsRecord(
  domain: string,
  timeoutMs: number = TIMEOUTS.dnsMs,
): Promise<boolean | null> {
  try {
    const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(domain)}&type=DS`;
    // Cloudflare returns HTTP 400 without this Accept header.
    const { status, body } = await getJson(url, timeoutMs, 'application/dns-json');
    if (status !== 200 || typeof body !== 'object' || body === null) return null;

    const payload = body as { Status?: unknown; Answer?: unknown };
    if (payload.Status !== 0) return null;
    if (!Array.isArray(payload.Answer)) return false;

    return payload.Answer.some(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { type?: unknown }).type === RRTYPE_DS,
    );
  } catch {
    return null;
  }
}

/**
 * Runs a DNS query, turning "no such record" into an empty result.
 *
 * @param query The query to run.
 * @returns What the query resolved to, or `[]` when the record type is absent.
 * @throws Never.
 */
async function optional<T>(query: () => Promise<T[]>): Promise<T[]> {
  try {
    return await query();
  } catch {
    // ENODATA (no record of this type), ENOTFOUND (no such name) and ESERVFAIL
    // all mean the same thing to a caller reading one record set: nothing to
    // report. Whether the domain exists at all is decided from the whole picture.
    return [];
  }
}

/**
 * Races DNS work against a hard deadline.
 *
 * `AbortSignal` does not work here — `node:dns` ignores it entirely, and a query
 * given an already-aborted signal still runs to its full timeout. `cancel()` is
 * the only thing that actually stops one, and it rejects in-flight queries in a
 * few milliseconds while leaving the resolver reusable.
 *
 * @param work The queries in flight.
 * @param resolver The resolver running them.
 * @param timeoutMs The deadline.
 * @param domain The domain being queried, for the message.
 * @returns Whatever `work` resolved to.
 * @throws {CheckError} `timeout` when the deadline passes first.
 */
async function withDeadline<T>(
  work: Promise<T>,
  resolver: Resolver,
  timeoutMs: number,
  domain: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      resolver.cancel();
      reject(
        new CheckError(
          'timeout',
          `DNS lookup for ${domain} timed out after ${(timeoutMs / 1000).toFixed(0)}s`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } catch (cause) {
    if (cause instanceof CheckError) throw cause;
    const code = (cause as { code?: string }).code;
    throw new CheckError(
      categorise(code),
      `DNS lookup for ${domain} failed (${code ?? 'unknown'})`,
      {
        cause,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lowercases a hostname and drops any trailing dot.
 *
 * @param hostname A hostname from a DNS answer.
 * @returns The normalised form.
 * @throws Never.
 */
function normaliseHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

/**
 * Copies a CAA answer into our own shape.
 *
 * Node does not return `{ flags, tag, value }`: the CAA tag is the *property
 * name*, and exactly one tag property is present per record.
 *
 * @param record One entry from `resolveCaa`.
 * @returns The record, with only present properties kept.
 * @throws Never.
 */
function toCaaRecord(record: NodeCaaRecord): CaaRecord {
  const result: CaaRecord = { critical: record.critical };
  for (const tag of ['issue', 'issuewild', 'iodef', 'contactemail', 'contactphone'] as const) {
    const value = record[tag];
    // Assigned conditionally rather than spread, because `exactOptionalPropertyTypes`
    // distinguishes an absent property from one explicitly set to undefined.
    if (value !== undefined) result[tag] = value;
  }
  return result;
}
