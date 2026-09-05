import type { EmailAuth, DmarcPolicy, SpfPolicy } from '../types.js';

/**
 * SPF and DMARC, read from records the domain already publishes.
 *
 * Everything here is parsing. The records arrive with the rest of the TXT set
 * in `dns.ts`, so establishing a domain's email authentication costs one extra
 * query — the `_dmarc` label — and nothing else. No message is sent, no mail
 * server is contacted, and nothing is inferred that the zone does not state.
 *
 * DKIM is deliberately absent. A DKIM key lives at `<selector>._domainkey`, and
 * a selector cannot be discovered from the DNS — only guessed, one query per
 * guess. That is subdomain enumeration wearing a useful hat, and principle 3
 * rules it out. A domain with no DKIM and a domain whose selector this project
 * failed to guess are indistinguishable from outside, so it says nothing about
 * either rather than reporting the second as the first.
 */

/**
 * Mechanisms and modifiers that cost a DNS lookup, per RFC 7208 §4.6.4.
 *
 * `ip4`, `ip6` and `all` are absent because they resolve nothing. `exp` is
 * absent because it is only evaluated when a message actually fails, which is
 * not the count receivers enforce.
 */
const LOOKUP_TERMS = ['include', 'a', 'mx', 'ptr', 'exists', 'redirect'] as const;

/**
 * The number of lookups RFC 7208 §4.6.4 allows before a receiver must return
 * `permerror` — which means the SPF record is not evaluated at all.
 */
export const SPF_LOOKUP_LIMIT = 10;

/** `v=spf1` must be the whole first term, not merely a prefix. */
const SPF_VERSION = /^v=spf1(\s|$)/i;

/** `v=DMARC1` is the first tag, and the only one whose position is fixed. */
const DMARC_VERSION = /^v=DMARC1(\s*;|\s*$)/i;

/** `all`, with the qualifier that decides what it means. */
const ALL_MECHANISM = /^([+\-~?]?)all$/i;

/** One term that costs a lookup: `include:x`, `a`, `a:x`, `mx/24`, `redirect=x`. */
const LOOKUP_TERM = new RegExp(`^(${LOOKUP_TERMS.join('|')})([:=/].*)?$`, 'i');

/**
 * Reads a domain's SPF and DMARC policy out of its TXT records.
 *
 * @param txt TXT records published at the domain itself, already joined from
 *   their chunks.
 * @param dmarcTxt TXT records published at `_dmarc.<domain>`.
 * @returns What each policy says. Absent is a state, never an error: a domain
 *   publishing neither is a normal answer and the commonest one.
 * @throws Never.
 */
export function analyseEmailAuth(txt: readonly string[], dmarcTxt: readonly string[]): EmailAuth {
  return { spf: readSpf(txt), dmarc: readDmarc(dmarcTxt) };
}

/**
 * Reads the SPF record.
 *
 * @param txt Every TXT record at the domain.
 * @returns The policy. `recordCount` above one is reported rather than resolved:
 *   RFC 7208 §4.5 says a receiver seeing two must return `permerror`, so
 *   choosing one here would describe a domain that works when it does not.
 * @throws Never.
 */
function readSpf(txt: readonly string[]): SpfPolicy {
  const records = txt.filter((record) => SPF_VERSION.test(record.trim()));
  const record = records[0] ?? null;

  if (record === null) {
    return { present: false, record: null, recordCount: 0, all: null, directLookups: 0 };
  }

  const terms = record.trim().split(/\s+/).slice(1);
  let all: SpfPolicy['all'] = null;
  let directLookups = 0;

  for (const term of terms) {
    const allMatch = ALL_MECHANISM.exec(term);
    if (allMatch !== null) {
      // The default qualifier is `+`, which is why a bare `all` is the most
      // permissive setting there is rather than a neutral one.
      all = qualifierMeaning(allMatch[1] === '' ? '+' : (allMatch[1] ?? '+'));
      continue;
    }
    if (LOOKUP_TERM.test(term)) directLookups += 1;
  }

  return { present: true, record, recordCount: records.length, all, directLookups };
}

/**
 * @param qualifier One of `+`, `-`, `~`, `?`.
 * @returns What that qualifier tells a receiver to do with unlisted senders.
 * @throws Never.
 */
function qualifierMeaning(qualifier: string): SpfPolicy['all'] {
  switch (qualifier) {
    case '-':
      return 'fail';
    case '~':
      return 'softfail';
    case '?':
      return 'neutral';
    default:
      return 'pass';
  }
}

/**
 * Reads the DMARC record.
 *
 * @param dmarcTxt Every TXT record at `_dmarc.<domain>`.
 * @returns The policy, with `policy` null when the record exists but names no
 *   `p=` tag — which is invalid, and different from publishing nothing.
 * @throws Never.
 */
function readDmarc(dmarcTxt: readonly string[]): DmarcPolicy {
  const records = dmarcTxt.filter((record) => DMARC_VERSION.test(record.trim()));
  const record = records[0] ?? null;

  if (record === null) {
    return {
      present: false,
      record: null,
      recordCount: 0,
      policy: null,
      reportingAddresses: [],
    };
  }

  const tags = new Map<string, string>();
  for (const part of record.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    if (key !== '' && !tags.has(key)) tags.set(key, part.slice(separator + 1).trim());
  }

  return {
    present: true,
    record,
    recordCount: records.length,
    policy: readPolicyTag(tags.get('p')),
    reportingAddresses: readReportingAddresses(tags.get('rua')),
  };
}

/**
 * @param value The `p=` tag's value, or undefined when absent.
 * @returns The policy, or null when absent or not one of the three RFC 7489
 *   defines. An unrecognised value is null rather than a guess: receivers treat
 *   an invalid `p` as if the record were not there.
 * @throws Never.
 */
function readPolicyTag(value: string | undefined): DmarcPolicy['policy'] {
  const lowered = value?.toLowerCase();
  return lowered === 'none' || lowered === 'quarantine' || lowered === 'reject' ? lowered : null;
}

/**
 * @param value The `rua=` tag's value, or undefined when absent.
 * @returns Each reporting address, comma-separated in the record. Kept as
 *   published, `mailto:` and any `!size` limit included, because this reports
 *   what the zone says rather than tidying it.
 * @throws Never.
 */
function readReportingAddresses(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address !== '');
}
