import type { RdapRegistration } from '../types.js';
import { TIMEOUTS } from './defaults.js';
import { CheckError } from './errors.js';
import { getJson } from './http-client.js';
import { asArray, asRecord, asScalarString, asString, toIsoUtc } from './json.js';
import { daysUntil } from './severity.js';

/** The IANA bootstrap registry that maps a TLD to its RDAP service (RFC 9224). */
const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

/**
 * TLDs that serve RDAP but are absent from the bootstrap registry.
 *
 * Kept deliberately small. `.io` earns its place because it is common in this
 * audience and its service does return an expiry date. TLDs whose RDAP exists
 * but publishes no expiry — `.de`, `.ch` — are *not* listed: a hardcoded host
 * that answers with nothing useful is worse than admitting the gap.
 */
const OVERRIDES = new Map<string, string>([['io', 'https://rdap.identitydigital.services/rdap/']]);

/** Registries known to publish no expiry date at all, for a truthful explanation. */
const NO_EXPIRY_PUBLISHED = new Set(['de', 'nl', 'no', 'au', 'fi', 'ch']);

interface BootstrapIndex {
  /** TLD or multi-label suffix, lowercased, to RDAP base URL ending in `/`. */
  services: Map<string, string>;
  /** When this copy stops being usable without revalidation. */
  expiresAt: number;
  /** Entity tag, for `If-None-Match` revalidation. */
  etag: string | null;
}

let cachedBootstrap: BootstrapIndex | null = null;
let inFlightBootstrap: Promise<BootstrapIndex> | null = null;

/**
 * Loads the IANA bootstrap registry, reusing the cached copy while it is fresh.
 *
 * RFC 9224 §8 says clients should cache the registry and honour the HTTP cache
 * headers rather than guessing an interval, which is what happens here — there
 * is no fixed refresh period in the specification. `publication` in the document
 * is a display field, not a cache key.
 *
 * @param timeoutMs Deadline for the fetch.
 * @returns The parsed index.
 * @throws {CheckError} `network` when the registry cannot be fetched and no
 *   usable cached copy exists.
 */
export async function loadBootstrap(
  timeoutMs: number = TIMEOUTS.bootstrapMs,
): Promise<BootstrapIndex> {
  const cached = cachedBootstrap;
  if (cached !== null && cached.expiresAt > Date.now()) return cached;
  inFlightBootstrap ??= fetchBootstrap(timeoutMs, cached).finally(() => {
    inFlightBootstrap = null;
  });
  return inFlightBootstrap;
}

/**
 * Fetches the bootstrap registry, revalidating a stale copy when possible.
 *
 * @param timeoutMs Deadline for the fetch.
 * @param stale A previously fetched copy, used for `If-None-Match` and as a
 *   fallback if the fetch fails.
 * @returns The parsed index.
 * @throws {CheckError} `network` when the fetch fails and there is no stale copy.
 */
async function fetchBootstrap(
  timeoutMs: number,
  stale: BootstrapIndex | null,
): Promise<BootstrapIndex> {
  try {
    const { status, headers, body } = await getJson(BOOTSTRAP_URL, timeoutMs);

    if (status === 304 && stale !== null) {
      const revalidated = { ...stale, expiresAt: Date.now() + maxAgeMs(headers) };
      cachedBootstrap = revalidated;
      return revalidated;
    }
    if (status !== 200) {
      throw new CheckError(
        'network',
        `the IANA RDAP bootstrap registry returned HTTP ${String(status)}`,
      );
    }

    const index: BootstrapIndex = {
      services: parseServices(body),
      expiresAt: Date.now() + maxAgeMs(headers),
      etag: headers.get('etag'),
    };
    cachedBootstrap = index;
    return index;
  } catch (cause) {
    // A stale index is far better than no answer: the mapping from TLD to RDAP
    // server changes on the order of months.
    if (stale !== null) return stale;
    if (cause instanceof CheckError) throw cause;
    throw new CheckError('network', 'could not load the IANA RDAP bootstrap registry', { cause });
  }
}

/**
 * Reads `Cache-Control: max-age`, falling back to a day.
 *
 * @param headers Response headers.
 * @returns Lifetime in milliseconds.
 * @throws Never.
 */
function maxAgeMs(headers: Headers): number {
  const match = /max-age=(\d+)/.exec(headers.get('cache-control') ?? '');
  const seconds = match?.[1] === undefined ? 86_400 : Number(match[1]);
  return Math.max(seconds, 300) * 1000;
}

/**
 * Turns the bootstrap document into a suffix-to-server map.
 *
 * @param body The decoded bootstrap document.
 * @returns One entry per published suffix.
 * @throws {CheckError} `network` when the document is not shaped as RFC 9224
 *   describes, which would make every subsequent lookup silently wrong.
 */
function parseServices(body: unknown): Map<string, string> {
  const services = asArray(asRecord(body)?.['services']);
  if (services === null) {
    throw new CheckError(
      'network',
      'the IANA RDAP bootstrap registry was not in the expected format',
    );
  }

  const map = new Map<string, string>();
  for (const service of services) {
    const pair = asArray(service);
    const suffixes = asArray(pair?.[0]);
    const urls = asArray(pair?.[1]);
    if (suffixes === null || urls === null) continue;

    // Prefer https; the registry lists http entries for a handful of services.
    const base =
      urls.map(asString).find((url) => url !== null && url.startsWith('https://')) ?? null;
    if (base === null) continue;

    for (const suffix of suffixes) {
      const key = asString(suffix)?.toLowerCase();
      if (key !== undefined) map.set(key, base.endsWith('/') ? base : `${base}/`);
    }
  }
  return map;
}

/**
 * Finds the RDAP service for a domain.
 *
 * Matching is label-wise longest match, right to left, as RFC 9224 §4 requires —
 * never `endsWith`. The registry contains both `com` and `goodexample.com`, and
 * `example.com` must match only `com`.
 *
 * @param domain A registrable domain in A-label form.
 * @param services The bootstrap index.
 * @returns The base URL, or `null` when the suffix publishes no RDAP service.
 * @throws Never.
 */
export function serverFor(domain: string, services: Map<string, string>): string | null {
  const labels = domain.split('.');
  for (let index = 0; index < labels.length; index += 1) {
    const suffix = labels.slice(index).join('.');
    const base = services.get(suffix);
    if (base !== undefined) return base;
  }
  const tld = labels[labels.length - 1];
  return tld === undefined ? null : (OVERRIDES.get(tld) ?? null);
}

/** Registration facts read from an RDAP domain object. */
export interface RdapDomainFacts {
  registrar: string | null;
  ianaRegistrarId: string | null;
  statuses: string[];
  registeredAt: string | null;
  expiresAt: string | null;
  /** From `secureDNS.delegationSigned`, when the registry publishes it. */
  delegationSigned: boolean | null;
}

/**
 * Reads the fields worth reporting out of an RDAP domain object.
 *
 * Pure, so the awkward real-world payloads — offsets instead of `Z`, fractional
 * seconds, a date with no time, a redacted registrar name — are covered by
 * fixtures rather than by a live registry.
 *
 * @param payload A decoded RDAP domain response.
 * @returns The facts, with anything absent as `null` or an empty array.
 * @throws Never.
 */
export function parseRdapDomain(payload: unknown): RdapDomainFacts {
  const root = asRecord(payload);

  let registeredAt: string | null = null;
  let expiresAt: string | null = null;
  for (const event of asArray(root?.['events']) ?? []) {
    const record = asRecord(event);
    // Event actions are lowercase and space-separated: `expiration`,
    // `registration`, `last changed`. Lowercasing both sides costs nothing and
    // survives a registry that disagrees.
    const action = asString(record?.['eventAction'])?.toLowerCase();
    if (action === 'expiration') expiresAt ??= toIsoUtc(record?.['eventDate']);
    if (action === 'registration') registeredAt ??= toIsoUtc(record?.['eventDate']);
  }

  return {
    registrar: registrarName(root),
    ianaRegistrarId: registrarId(root),
    statuses: (asArray(root?.['status']) ?? [])
      .map(asString)
      .filter((status): status is string => status !== null)
      .map((status) => status.toLowerCase()),
    registeredAt,
    expiresAt,
    delegationSigned: delegationSigned(root),
  };
}

/**
 * Finds the registrar entity's display name.
 *
 * @param root The RDAP domain object.
 * @returns The name, or `null` when absent or redacted to an empty string.
 * @throws Never.
 */
function registrarName(root: Record<string, unknown> | null): string | null {
  const entity = findRegistrar(root);
  // jCard is ['vcard', [[name, params, type, value], …]]. `fn` is single-valued,
  // so index 3 is safe — but it can legitimately be 'REDACTED FOR PRIVACY'.
  const properties = asArray(asArray(entity?.['vcardArray'])?.[1]) ?? [];
  for (const property of properties) {
    const entry = asArray(property);
    if (asString(entry?.[0]) === 'fn') return asString(entry?.[3]);
  }
  return null;
}

/**
 * Finds the registrar's IANA identifier, which survives name redaction.
 *
 * @param root The RDAP domain object.
 * @returns The identifier as a string, or `null`.
 * @throws Never.
 */
function registrarId(root: Record<string, unknown> | null): string | null {
  const entity = findRegistrar(root);
  for (const publicId of asArray(entity?.['publicIds']) ?? []) {
    const record = asRecord(publicId);
    if (asString(record?.['type'])?.toLowerCase().includes('iana registrar id') === true) {
      return asScalarString(record?.['identifier']);
    }
  }
  return null;
}

/**
 * Finds the entity holding the `registrar` role.
 *
 * @param root The RDAP domain object.
 * @returns The entity, or `null`. Roles is an array and may hold several values,
 *   so membership is what matters, not equality.
 * @throws Never.
 */
function findRegistrar(root: Record<string, unknown> | null): Record<string, unknown> | null {
  for (const entity of asArray(root?.['entities']) ?? []) {
    const record = asRecord(entity);
    const roles = (asArray(record?.['roles']) ?? []).map((role) => asString(role)?.toLowerCase());
    if (roles.includes('registrar')) return record;
  }
  return null;
}

/**
 * Reads whether the parent zone publishes a DS record.
 *
 * Keyed only off `delegationSigned`: RFC 9083 §5.3 makes every member of
 * `secureDNS` optional, and registries return different subsets of it.
 *
 * @param root The RDAP domain object.
 * @returns `true`, `false`, or `null` when the registry does not say.
 * @throws Never.
 */
function delegationSigned(root: Record<string, unknown> | null): boolean | null {
  const value = asRecord(root?.['secureDNS'])?.['delegationSigned'];
  return typeof value === 'boolean' ? value : null;
}

/** An RDAP lookup: the registration, plus what the registry said about DNSSEC. */
export interface RdapLookup {
  /** Registration facts, or an explained gap. */
  registration: RdapRegistration;
  /**
   * `secureDNS.delegationSigned` as published by the registry, or `null` when it
   * did not say. This is the authoritative source for DNSSEC delegation — it is
   * the parent's own view — so it is preferred over any DNS query.
   */
  delegationSigned: boolean | null;
}

/**
 * Looks up a domain's registration over RDAP.
 *
 * @param registrable The registrable domain, in A-label form.
 * @param now The moment to compute days-until-expiry against.
 * @param timeoutMs Deadline for the RDAP request.
 * @returns The registration, with `source: 'unavailable'` and an explanation
 *   when the registry publishes no usable data. A registry that has no expiry
 *   date is a successful check with a gap, not a failure.
 * @throws {CheckError} `not_found` when the registry says the domain does not
 *   exist, `network` or `timeout` when it cannot be reached.
 */
export async function lookupDomain(
  registrable: string,
  now: Date,
  timeoutMs: number = TIMEOUTS.rdapMs,
): Promise<RdapLookup> {
  const tld = registrable.split('.').pop() ?? '';
  const { services } = await loadBootstrap();
  const base = serverFor(registrable, services);

  if (base === null) {
    return {
      registration: unavailable(null, `no RDAP service is published for .${tld}`),
      delegationSigned: null,
    };
  }

  const url = `${base}domain/${encodeURIComponent(registrable)}`;
  const { status, body } = await getJson(url, timeoutMs, 'application/rdap+json, application/json');

  if (status === 404) {
    throw new CheckError(
      'not_found',
      `${registrable} is not registered, according to the .${tld} registry`,
    );
  }
  if (status !== 200) {
    // Trust the status, not the body: registries disagree wildly on error shapes
    // and at least one returns an empty body with a 404.
    throw new CheckError('network', `the .${tld} RDAP service returned HTTP ${String(status)}`);
  }

  const facts = parseRdapDomain(body);
  if (facts.expiresAt === null) {
    const reason = NO_EXPIRY_PUBLISHED.has(tld)
      ? `the .${tld} registry does not publish expiry dates`
      : `the .${tld} registry published no expiry date for this domain`;
    return {
      registration: { ...unavailable(base, reason), ...withoutExpiry(facts) },
      delegationSigned: facts.delegationSigned,
    };
  }

  return {
    registration: {
      source: 'rdap',
      rdapServer: base,
      registrar: facts.registrar,
      ianaRegistrarId: facts.ianaRegistrarId,
      statuses: facts.statuses,
      registeredAt: facts.registeredAt,
      expiresAt: facts.expiresAt,
      daysUntilExpiry: daysUntil(facts.expiresAt, now),
      unavailableReason: null,
    },
    delegationSigned: facts.delegationSigned,
  };
}

/**
 * Builds a registration result for a domain whose expiry could not be obtained.
 *
 * @param rdapServer The service that answered, if any.
 * @param reason Plain-words explanation.
 * @returns An `unavailable` registration.
 * @throws Never.
 */
function unavailable(rdapServer: string | null, reason: string): RdapRegistration {
  return {
    source: 'unavailable',
    rdapServer,
    registrar: null,
    ianaRegistrarId: null,
    statuses: [],
    registeredAt: null,
    expiresAt: null,
    daysUntilExpiry: null,
    unavailableReason: reason,
  };
}

/**
 * Keeps the facts a registry did publish, even when the expiry date is missing.
 *
 * @param facts Parsed RDAP facts.
 * @returns The subset worth reporting alongside an `unavailable` expiry.
 * @throws Never.
 */
function withoutExpiry(facts: RdapDomainFacts): Partial<RdapRegistration> {
  return {
    registrar: facts.registrar,
    ianaRegistrarId: facts.ianaRegistrarId,
    statuses: facts.statuses,
    registeredAt: facts.registeredAt,
  };
}
