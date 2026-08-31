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
  /** CAA records. */
  caa: CaaRecord[];
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
