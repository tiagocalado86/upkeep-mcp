import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Ports } from '../../src/lib/ports.js';
import { CheckError } from '../../src/lib/errors.js';
import { createMemoryHistory, type RunHistory } from '../../src/lib/history.js';
import type { RdapLookup } from '../../src/lib/rdap.js';
import type { AxeRun } from '../../src/lib/axe.js';
import { EMPTY_ROBOTS, parseRobots, type RobotsFetch } from '../../src/lib/robots.js';
import type { RevocationMaterials, TlsInspection } from '../../src/lib/tls.js';
import type {
  CertificateSummary,
  ChainSummary,
  DnsRecords,
  NameserverAnswer,
  NameserverCheck,
  RdapRegistration,
  RevocationReport,
} from '../../src/types.js';

/** The moment every tool test pretends it is. */
export const NOW = new Date('2026-08-31T12:00:00.000Z');

/**
 * A nameserver check where every published nameserver answered with authority
 * and they all hold the same version of the zone.
 *
 * @param answers Per-nameserver overrides, keyed by host.
 * @returns A check with nothing to report.
 */
export function agreeingNameservers(
  answers: Record<string, Partial<NameserverAnswer>> = {},
  hosts: readonly string[] = ['ns1.example.net', 'ns2.example.net'],
): NameserverCheck {
  const all = hosts.map((host): NameserverAnswer => ({
    host,
    address: '192.0.2.53',
    outcome: 'authoritative',
    serial: 2026090701,
    problem: null,
    ...answers[host],
  }));
  const serials = [
    ...new Set(all.map((answer) => answer.serial).filter((serial) => serial !== null)),
  ].sort((left, right) => left - right);

  return {
    checked: true,
    unavailableReason: null,
    answers: all,
    serials,
    agree: serials.length <= 1,
  };
}

/**
 * A nameserver check that did not run, which is the default for every tool test
 * that is not about one.
 *
 * @returns A check with nothing asked and nothing to disagree about.
 */
export function unaskedNameservers(): NameserverCheck {
  return {
    checked: false,
    unavailableReason: 'the domain publishes no NS records, so there was nothing to ask',
    answers: [],
    serials: [],
    agree: true,
  };
}

/**
 * DNS records with nothing in them, as a base for tests to override.
 *
 * @returns Empty records.
 */
export function emptyDns(): DnsRecords {
  return {
    apexResolves: false,
    wwwResolves: false,
    a: [],
    aaaa: [],
    ns: [],
    mx: [],
    txt: [],
    dmarcTxt: [],
    caa: [],
  };
}

/**
 * A domain that resolves normally.
 *
 * Publishes SPF and DMARC, because a domain that does not is a domain with
 * findings, and a fixture named "healthy" that produces findings makes every
 * test using it assert around them. Cases about email authentication override
 * `txt` and `dmarcTxt` explicitly.
 *
 * @param overrides Fields to change.
 * @returns Records for a healthy domain.
 */
export function healthyDns(overrides: Partial<DnsRecords> = {}): DnsRecords {
  return {
    ...emptyDns(),
    apexResolves: true,
    wwwResolves: true,
    a: ['192.0.2.1'],
    ns: ['ns1.example.net', 'ns2.example.net'],
    txt: ['v=spf1 include:_spf.example.net -all'],
    dmarcTxt: ['v=DMARC1; p=reject; rua=mailto:dmarc@example.com'],
    ...overrides,
  };
}

/**
 * A registration with a real expiry date.
 *
 * @param overrides Fields to change.
 * @returns A registration.
 */
export function registration(overrides: Partial<RdapRegistration> = {}): RdapRegistration {
  return {
    source: 'rdap',
    rdapServer: 'https://rdap.example.test/',
    registrar: 'Example Registrar',
    ianaRegistrarId: '376',
    statuses: ['client transfer prohibited'],
    registeredAt: '2010-01-01T00:00:00.000Z',
    expiresAt: '2027-08-13T04:00:00.000Z',
    daysUntilExpiry: 346,
    unavailableReason: null,
    ...overrides,
  };
}

/** Overrides accepted by {@link inspection}, with the certificate reachable directly. */
export interface InspectionOverrides extends Partial<Omit<TlsInspection, 'chain' | 'revocation'>> {
  /** Fields of the end-entity certificate to change. */
  leaf?: Partial<CertificateSummary>;
  /** Fields of the chain verdict to change. */
  chain?: Partial<Omit<ChainSummary, 'leaf'>>;
  /** Fields of the revocation materials to change. */
  revocation?: Partial<RevocationMaterials>;
}

/**
 * A TLS inspection of a healthy certificate.
 *
 * @param overrides Fields to change. `leaf` reaches the certificate itself, so a
 *   test can change one date without restating the whole chain.
 * @returns An inspection.
 */
export function inspection(overrides: InspectionOverrides = {}): TlsInspection {
  const { leaf, chain, revocation, ...rest } = overrides;
  return {
    chain: {
      leaf: {
        subject: 'example.com',
        issuer: 'R11',
        serialNumber: 'ABCD',
        fingerprintSha256: 'AA:BB',
        validFrom: '2026-07-01T00:00:00.000Z',
        validTo: '2026-12-01T00:00:00.000Z',
        ...leaf,
      },
      issuers: ['R11', 'ISRG Root X1'],
      length: 3,
      valid: true,
      error: null,
      ...chain,
    },
    subjectAltName: 'DNS:example.com, DNS:www.example.com',
    hostMatches: {
      'example.com': 'example.com',
      'www.example.com': 'www.example.com',
    },
    protocol: 'TLSv1.3',
    cipher: 'TLS_AES_256_GCM_SHA384',
    alpn: 'h2',
    revocation: {
      leafDer: new Uint8Array([0x30]),
      issuerDer: new Uint8Array([0x30]),
      responderUrls: ['http://ocsp.example.net'],
      stapled: null,
      ...revocation,
    },
    ...rest,
  };
}

/**
 * A revocation report saying the certificate is fine.
 *
 * The default for every fake, because a certificate that could not be checked
 * produces a finding, and a fixture named "healthy" that produces findings makes
 * every test using it assert around one.
 *
 * @param overrides Fields to change.
 * @returns A report.
 */
export function goodRevocation(overrides: Partial<RevocationReport> = {}): RevocationReport {
  return {
    checked: true,
    status: 'good',
    source: 'responder',
    responder: 'http://ocsp.example.net',
    signatureVerified: true,
    revokedAt: null,
    reason: null,
    producedAt: '2026-08-31T06:00:00.000Z',
    nextUpdate: '2026-09-07T06:00:00.000Z',
    unavailableReason: null,
    ...overrides,
  };
}

/** Overridable slices of the I/O boundary. */
export interface FakeOptions {
  dnsRecords?: DnsRecords | Error;
  dsRecord?: boolean | null;
  /** What the zone's own nameservers answered. Defaults to a check that did not run. */
  nameservers?: NameserverCheck | Error;
  rdap?: RdapLookup | Error;
  tls?: TlsInspection | Error;
  /** What the OCSP check establishes. Defaults to a certificate that is not revoked. */
  revocation?: RevocationReport | Error;
  hops?: Record<
    string,
    { status: number; headers?: Record<string, string>; location?: string } | Error
  >;
  /**
   * Bodies returned by `http.text` and `http.bytes`, keyed by URL.
   *
   * `body` covers everything textual. `bytes` is for a document that is not
   * text as served — a gzipped sitemap — and wins over `body` on the `bytes`
   * port; without it the body is served as its UTF-8 encoding.
   */
  documents?: Record<
    string,
    | {
        status: number;
        body: string;
        bytes?: Uint8Array;
        contentType?: string;
        url?: string;
        truncated?: boolean;
      }
    | Error
  >;
  /**
   * A `robots.txt` body, as if served with a 200. The two literals `'absent'`
   * and `'unreachable'` stand for a host that publishes none and one that
   * cannot be asked at all. An `Error` stands for a fetch that never happened —
   * a target the guard refused, which is what a public instance does first.
   */
  robots?: string | Error;
  /** Local files the run may read, keyed by the path a caller would pass. */
  files?: Record<string, string>;
  /** What a browser audit returns, or an Error for a browser that will not start. */
  axe?: AxeRun | Error;
  /** Run history. Defaults to a fresh one, so nothing has been seen before. */
  history?: RunHistory;
  now?: Date;
}

/**
 * Builds ports that answer from fixtures instead of the network.
 *
 * Dependency injection rather than mocking a builtin: the test then depends on
 * this project's own contract, and "no tool performs I/O directly" stays a
 * structural fact.
 *
 * @param options What each port should answer.
 * @returns Ports usable by any tool.
 */
export function fakePorts(options: FakeOptions = {}): Ports {
  const settle = <T>(value: T | Error | undefined, fallback: T): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? fallback);

  return {
    dns: {
      resolveRecords: () => settle(options.dnsRecords, emptyDns()),
      hasDsRecord: () => Promise.resolve(options.dsRecord ?? null),
      nameservers: () => settle(options.nameservers, unaskedNameservers()),
    },
    rdap: {
      lookupDomain: () =>
        settle(options.rdap, {
          registration: registration({
            source: 'unavailable',
            expiresAt: null,
            daysUntilExpiry: null,
          }),
          delegationSigned: null,
        }),
    },
    tls: {
      inspect: () => settle(options.tls, inspection()),
      revocation: () => settle(options.revocation, goodRevocation()),
    },
    http: {
      hop: (url) => {
        const reply = options.hops?.[url];
        if (reply === undefined) {
          return Promise.reject(new Error(`no fixture for ${url}`));
        }
        if (reply instanceof Error) return Promise.reject(reply);
        const headers = new Headers(reply.headers ?? {});
        if (reply.location !== undefined) headers.set('location', reply.location);
        return Promise.resolve({
          url,
          status: reply.status,
          headers,
          location: reply.location ?? null,
          elapsedMs: 12,
        });
      },
      text: (url) => {
        const reply = options.documents?.[url];
        if (reply === undefined) return Promise.reject(new Error(`no fixture for ${url}`));
        if (reply instanceof Error) return Promise.reject(reply);
        const contentType = reply.contentType ?? 'text/html';
        return Promise.resolve({
          url: reply.url ?? url,
          status: reply.status,
          headers: new Headers({ 'content-type': contentType }),
          contentType,
          body: reply.body,
          truncated: reply.truncated ?? false,
        });
      },
      bytes: (url) => {
        const reply = options.documents?.[url];
        if (reply === undefined) return Promise.reject(new Error(`no fixture for ${url}`));
        if (reply instanceof Error) return Promise.reject(reply);
        const contentType = reply.contentType ?? 'text/html';
        return Promise.resolve({
          url: reply.url ?? url,
          status: reply.status,
          contentType,
          body: reply.bytes ?? new TextEncoder().encode(reply.body),
          truncated: reply.truncated ?? false,
        });
      },
    },
    robots: {
      forOrigin: (origin) =>
        options.robots instanceof Error
          ? Promise.reject(options.robots)
          : Promise.resolve(fakeRobots(origin, options.robots)),
    },
    browser: {
      audit: () =>
        settle(options.axe, axeRun({ violations: [], passCount: 40, incompleteCount: 0 })),
    },
    files: {
      readText: (path) => {
        const contents = options.files?.[path];
        return contents === undefined
          ? Promise.reject(new CheckError('not_found', `there is no file at ${path}`))
          : Promise.resolve(contents);
      },
    },
    history: options.history ?? createMemoryHistory(),
    now: () => options.now ?? NOW,
  };
}

/**
 * A browser audit that found nothing, as a base for tests to override.
 *
 * @param overrides Fields to change.
 * @returns An axe run.
 */
export function axeRun(overrides: Partial<AxeRun> = {}): AxeRun {
  return {
    url: 'https://example.com/',
    title: 'Example',
    violations: [],
    passCount: 40,
    incompleteCount: 0,
    axeVersion: '4.13.0',
    ...overrides,
  };
}

/**
 * Builds the `robots.txt` answer a test asked for.
 *
 * @param origin The origin being asked about.
 * @param wanted The test's `robots` option. Undefined means the host publishes
 *   none, which is the case most tests want.
 * @returns A fetch result.
 */
function fakeRobots(origin: string, wanted: string | undefined): RobotsFetch {
  const url = new URL('/robots.txt', origin).toString();
  if (wanted === undefined || wanted === 'absent') {
    return { url, availability: 'absent', status: 404, robots: EMPTY_ROBOTS };
  }
  if (wanted === 'unreachable') {
    return { url, availability: 'unreachable', status: null, robots: EMPTY_ROBOTS };
  }
  return { url, availability: 'fetched', status: 200, robots: parseRobots(wanted) };
}

/**
 * Reads the structured half of a tool result.
 *
 * @param result The result returned by a tool.
 * @returns Its structured content.
 */
export function structured(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

/**
 * Reads the codes of the findings a tool reported.
 *
 * @param result The result returned by a tool.
 * @returns Finding codes, in order.
 */
export function findingCodes(result: CallToolResult): string[] {
  const findings = structured(result)['findings'];
  return Array.isArray(findings) ? findings.map((item) => (item as { code: string }).code) : [];
}

/**
 * Reads the text half of a tool result.
 *
 * @param result The result returned by a tool.
 * @returns The joined text blocks.
 */
export function text(result: CallToolResult): string {
  return result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
}
