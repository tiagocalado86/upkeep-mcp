/**
 * Result shapes shared across tools.
 *
 * Every tool returns human-readable text *and* structured data. The structured
 * half is what a model or a downstream script consumes; the text half is what a
 * person reads in a chat transcript.
 *
 * The vocabulary here is deliberately shared: `portfolio_report` (Phase 3) has
 * to sort findings from every check into one list ordered by urgency, and it can
 * only do that if the checks already speak the same language about severity and
 * about how many days are left on the clock.
 */

/**
 * Machine-readable reason a tool could not produce a result.
 *
 * These are the failure modes callers can act on differently: a `timeout` is
 * worth retrying, an `invalid_input` never is.
 */
export type ToolErrorCode =
  /** The input was syntactically valid but unusable (e.g. a URL with no host). */
  | 'invalid_input'
  /** The target could not be reached: DNS failure, refused connection, TLS handshake failure. */
  | 'network'
  /** The operation exceeded its deadline. */
  | 'timeout'
  /** The target responded, but the thing being asked about does not exist. */
  | 'not_found'
  /** Anything unforeseen. A bug in this server until proven otherwise. */
  | 'unexpected';

/**
 * A tool failure carried across the MCP boundary as a normal result.
 *
 * No exception ever leaves a handler: an MCP server that crashes is a useless
 * MCP server, so failures are values, not throws.
 *
 * A *partial* answer is not a failure. A registry that publishes no expiry date
 * is a successful check with a null field and a finding explaining it; only a
 * target that could not be examined at all produces one of these.
 */
export interface ToolError {
  /** Category of failure, for callers that branch on it. */
  code: ToolErrorCode;
  /**
   * Actionable, human-readable explanation, in English.
   * Say what failed and against what, e.g. `TLS handshake with example.com:443
   * timed out after 10s`, not `request failed`.
   */
  message: string;
}

/**
 * How much attention something needs.
 *
 * Ordered: `ok` < `info` < `warning` < `critical`. `unknown` sits outside the
 * order — it means the check could not establish the fact, which is not the same
 * as establishing that the fact is fine.
 */
export type Severity = 'ok' | 'info' | 'warning' | 'critical' | 'unknown';

/**
 * One actionable observation about a target.
 *
 * Phase 3 concatenates these across a whole portfolio, which is why `code` is a
 * stable identifier rather than prose: it is what lets a report group "these six
 * sites have the same problem".
 */
export interface Finding {
  /** Stable machine identifier, e.g. `cert_expires_soon`, `apex_does_not_resolve`. */
  code: string;
  /** How much attention this observation needs. */
  severity: Severity;
  /** One sentence a client would understand, without jargon where jargon is avoidable. */
  message: string;
}

/**
 * One check's outcome, reduced to what a portfolio report aggregates.
 *
 * Deliberately narrow. A portfolio of twenty sites running four checks each
 * would carry four full reports per site if this were the whole thing, and a
 * report nobody can read is not a report. What ranks a portfolio is the
 * severity, the findings and how many days are left on the clock.
 */
export interface CheckSummary {
  /** The worst severity this check found. */
  severity: Severity;
  /** What the check wants attention for. */
  findings: Finding[];
  /**
   * Days until the thing this check watches expires, or `null` when it watches
   * nothing that expires — an uptime check has no clock.
   */
  daysUntilExpiry: number | null;
  /** The first line of the check's own summary, so the prose is written once. */
  headline: string;
}

/** A check that either produced a summary or failed outright. */
export type CheckOutcome = { ok: true; summary: CheckSummary } | { ok: false; error: ToolError };

/** Liveness report returned by the `health` tool. */
export interface HealthReport {
  /** Always `'ok'`. If the server can answer at all, it is healthy. */
  status: 'ok';
  /** Server name, matching the MCP handshake. */
  server: string;
  /** Server version, matching `package.json`. */
  version: string;
  /** Node.js version the server is running under, e.g. `'v22.18.0'`. */
  node: string;
  /** Whole seconds since this server process started. */
  uptimeSeconds: number;
  /** Moment the report was produced, ISO 8601 with timezone. */
  checkedAt: string;
}

/** A mail exchanger. An `exchange` of `''` with priority 0 is RFC 7505's "null MX". */
export interface MxRecord {
  exchange: string;
  priority: number;
}

/**
 * One CAA record.
 *
 * Note the shape: the CAA *tag* is the property name, not a field. Node returns
 * `{ critical: 0, issue: 'letsencrypt.org' }`, never `{ tag: 'issue', value: … }`.
 * Exactly one of the tag properties is present per record.
 */
export interface CaaRecord {
  /** The critical flag, as a number (0 or 128). */
  critical: number;
  /** Certificate authority authorised to issue for this domain. */
  issue?: string;
  /** Certificate authority authorised to issue wildcards for this domain. */
  issuewild?: string;
  /** Where to report certificate issuance violations. */
  iodef?: string;
  /** Contact address, per RFC 8659's contact extensions. */
  contactemail?: string;
  /** Contact phone, per RFC 8659's contact extensions. */
  contactphone?: string;
}

/** The DNS records a maintenance check cares about. */
export interface DnsRecords {
  /** Whether the apex (the domain itself) has any address record. */
  apexResolves: boolean;
  /** Whether `www.<domain>` has any address record. */
  wwwResolves: boolean;
  /** IPv4 addresses. */
  a: string[];
  /** IPv6 addresses. */
  aaaa: string[];
  /** Nameserver hostnames, lowercased and without a trailing dot. */
  ns: string[];
  /** Mail exchangers, lowest priority first. */
  mx: MxRecord[];
  /** TXT records, each already joined from its 255-byte chunks. */
  txt: string[];
  /**
   * TXT records at `_dmarc.<domain>`, where a DMARC policy is published.
   *
   * A separate field rather than a merged one: DMARC lives at its own label, and
   * folding it into `txt` would report the domain as publishing a record it does
   * not.
   */
  dmarcTxt: string[];
  /** CAA records. */
  caa: CaaRecord[];
}

/**
 * What came of asking one nameserver about the zone it is listed for.
 *
 * The distinction that matters is between a fault of the delegation and a fact
 * about this one query. A resolver reaches a nameserver over UDP and falls back
 * to TCP; this server can only use TCP, because UDP to arbitrary hosts does not
 * leave every platform it is deployed to. So a nameserver that refuses TCP is
 * not a broken nameserver — plenty serve UDP only, in defiance of RFC 7766 and
 * with no visible consequence — while one whose name does not resolve, or that
 * answers without authority, is broken for everybody.
 */
export type NameserverOutcome =
  /** It answered with authority for the zone, which is what should happen. */
  | 'authoritative'
  /** It answered, but not with authority for the zone: a lame delegation. */
  | 'lame'
  /** Its hostname does not resolve, so no resolver can reach it either. */
  | 'unresolvable'
  /** It could not be asked over TCP port 53, which says nothing about UDP. */
  | 'unreachable';

/** What one authoritative nameserver said when asked about the zone directly. */
export interface NameserverAnswer {
  /** The nameserver's hostname, as the zone publishes it. */
  host: string;
  /** The address that was asked, or `null` when the name resolved to none. */
  address: string | null;
  /** What came of asking it. */
  outcome: NameserverOutcome;
  /** The zone's serial as this server holds it, or `null` when it did not say. */
  serial: number | null;
  /** Why it did not answer usefully, in plain words, or `null` when it did. */
  problem: string | null;
}

/** What the zone's own nameservers said when each was asked directly. */
export interface NameserverCheck {
  /** Whether the nameservers were asked at all. */
  checked: boolean;
  /**
   * Why they were not asked, or which of them were left out, in plain words.
   * `null` when every published nameserver was asked.
   */
  unavailableReason: string | null;
  /** One entry per nameserver asked, in the order the zone publishes them. */
  answers: NameserverAnswer[];
  /** The distinct serials seen, ascending. More than one means disagreement. */
  serials: number[];
  /**
   * Whether every nameserver that answered holds the same version of the zone.
   *
   * `true` when nothing answered, because nothing was compared. Disagreement is
   * not by itself a fault: a domain served by two providers that do not
   * transfer between them has two independent serials by design.
   */
  agree: boolean;
}

/**
 * What a domain's SPF record says.
 *
 * SPF names the servers allowed to send mail as this domain. Absent, anyone may;
 * present but permissive, the same, stated explicitly.
 */
export interface SpfPolicy {
  /** Whether any `v=spf1` record is published. */
  present: boolean;
  /** The record as published, or null when there is none. */
  record: string | null;
  /**
   * How many `v=spf1` records exist. More than one is invalid — RFC 7208 §4.5
   * makes a receiver seeing two return `permerror`, so SPF stops working
   * entirely rather than one of the two winning.
   */
  recordCount: number;
  /**
   * What the `all` mechanism tells receivers to do with senders the record does
   * not list: `fail` is `-all`, `softfail` is `~all`, `neutral` is `?all` and
   * `pass` is `+all` — or a bare `all`, whose default qualifier is `+`. Null
   * when the record names no `all` at all.
   */
  all: 'fail' | 'softfail' | 'neutral' | 'pass' | null;
  /**
   * Terms in this record that each cost a DNS lookup.
   *
   * A **lower bound**, not the count a receiver computes: the real total
   * includes everything reached through `include:` and `redirect=`, and
   * following those means resolving other people's zones. Over the limit here
   * is therefore proof of a broken record; under it proves nothing.
   */
  directLookups: number;
}

/**
 * What a domain's DMARC record says.
 *
 * DMARC tells receivers what to do when SPF and DKIM do not line up, and where
 * to report it. Without it, a receiver decides for itself.
 */
export interface DmarcPolicy {
  /** Whether a `v=DMARC1` record is published at `_dmarc.<domain>`. */
  present: boolean;
  /** The record as published, or null when there is none. */
  record: string | null;
  /** How many `v=DMARC1` records exist. More than one is invalid. */
  recordCount: number;
  /**
   * The `p=` tag: `none` monitors without acting, `quarantine` sends failures to
   * spam, `reject` refuses them. Null when the record names no valid policy,
   * which receivers treat as if it were not published.
   */
  policy: 'none' | 'quarantine' | 'reject' | null;
  /** The `rua=` addresses aggregate reports are sent to, as published. */
  reportingAddresses: string[];
}

/** A domain's email authentication, as its own DNS states it. */
export interface EmailAuth {
  spf: SpfPolicy;
  dmarc: DmarcPolicy;
}

/**
 * Whether the parent zone has a signed delegation.
 *
 * This is deliberately *not* a claim that a DNSSEC chain was validated — nothing
 * here validates one. `node:dns` cannot query DS, DNSKEY or RRSIG at all and
 * exposes no AD flag, so the answer comes from the registry (via RDAP) or from a
 * single DNS-over-HTTPS query, and says so.
 */
export interface DnssecStatus {
  /** `true` if the parent publishes a DS record; `null` if it could not be established. */
  delegationSigned: boolean | null;
  /** Where the answer came from. */
  source: 'rdap' | 'doh' | 'unknown';
}

/** Domain registration data, as published by the registry over RDAP. */
export interface RdapRegistration {
  /** `'unavailable'` when the registry publishes no usable registration data. */
  source: 'rdap' | 'unavailable';
  /** The RDAP base URL that answered, for traceability. */
  rdapServer: string | null;
  /** Registrar name, or `null` when redacted or absent. */
  registrar: string | null;
  /** IANA registrar ID, useful for identifying a registrar whose name is redacted. */
  ianaRegistrarId: string | null;
  /** EPP statuses, lowercased, e.g. `client transfer prohibited`. */
  statuses: string[];
  /** When the domain was first registered, ISO 8601 UTC. */
  registeredAt: string | null;
  /** When the registration expires, ISO 8601 UTC. */
  expiresAt: string | null;
  /** Whole days until `expiresAt`, negative if already past. `null` when unknown. */
  daysUntilExpiry: number | null;
  /**
   * Why there is no expiry date, in plain words, e.g.
   * `the .de registry does not publish expiry dates`. `null` when there is one.
   */
  unavailableReason: string | null;
}

/** One certificate in a chain, reduced to what a maintenance report needs. */
export interface CertificateSummary {
  /** Subject common name, or the first SAN when there is no CN. */
  subject: string | null;
  /** Issuer common name. */
  issuer: string | null;
  /** Serial number, as hexadecimal. */
  serialNumber: string | null;
  /** SHA-256 fingerprint. */
  fingerprintSha256: string | null;
  /** Start of validity, ISO 8601 UTC. */
  validFrom: string | null;
  /** End of validity, ISO 8601 UTC. */
  validTo: string | null;
}

/** What a TLS handshake revealed about the server's certificate chain. */
export interface ChainSummary {
  /** The end-entity certificate. */
  leaf: CertificateSummary | null;
  /** Issuer common names from the leaf upwards. */
  issuers: string[];
  /** Number of certificates in the chain, including the trust-store root when verified. */
  length: number;
  /** Whether Node considered the chain valid for this host. */
  valid: boolean;
  /**
   * OpenSSL's reason when it is not, e.g. `CERT_HAS_EXPIRED`,
   * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Only ever one reason, even when several
   * things are wrong.
   */
  error: string | null;
}

/**
 * Whether a certificate has been revoked, and how confidently that was
 * established.
 *
 * Shaped like {@link RdapRegistration}, and for the same reason: several
 * perfectly healthy certificates cannot be checked at all — since 2025 the two
 * largest issuers publish no OCSP responder — so "not established" needs to be a
 * reported state with a reason attached rather than a silent `false`.
 */
export interface RevocationReport {
  /**
   * Whether a signed answer from the issuing CA was obtained and verified.
   *
   * The one field to branch on. `status` may be set while this is `false`, which
   * means an answer arrived but could not be shown to have come from the CA.
   */
  checked: boolean;
  /** What the responder said, or `null` when none was reached. */
  status: 'good' | 'revoked' | 'unknown' | null;
  /** Where the answer came from: stapled to the handshake, or fetched. */
  source: 'stapled' | 'responder' | null;
  /**
   * The responder that was contacted, or `null` when none was — because the
   * answer came stapled, or because the certificate names none.
   *
   * Set even when the query failed, which is what distinguishes a responder that
   * would not answer from a certificate authority that runs none at all. Only
   * the first is worth anyone's attention.
   */
  responder: string | null;
  /** Whether the answer's signature verified against the issuing CA. */
  signatureVerified: boolean;
  /** When the certificate was revoked, ISO 8601 UTC. `null` unless revoked. */
  revokedAt: string | null;
  /** Why it was revoked, e.g. `keyCompromise`. `null` when unstated or not revoked. */
  reason: string | null;
  /** When the responder produced the answer, ISO 8601 UTC. */
  producedAt: string | null;
  /** When a fresher answer will be published, ISO 8601 UTC. */
  nextUpdate: string | null;
  /**
   * Why no verified answer was obtained, in a form that can be read aloud —
   * `the certificate names no OCSP responder`. `null` when one was.
   */
  unavailableReason: string | null;
}

/** One hop in a redirect chain. */
export interface HttpHop {
  /** The URL requested at this hop. */
  url: string;
  /** HTTP status returned. */
  status: number;
  /** Raw `Location` header, or `null` when this hop was the destination. */
  location: string | null;
  /** Wall-clock milliseconds for this hop alone. */
  elapsedMs: number;
}
