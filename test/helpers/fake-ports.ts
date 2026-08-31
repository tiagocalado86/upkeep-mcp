import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Ports } from '../../src/lib/ports.js';
import type { RdapLookup } from '../../src/lib/rdap.js';
import type { TlsInspection } from '../../src/lib/tls.js';
import type {
  CertificateSummary,
  ChainSummary,
  DnsRecords,
  RdapRegistration,
} from '../../src/types.js';

/** The moment every tool test pretends it is. */
export const NOW = new Date('2026-08-31T12:00:00.000Z');

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
    caa: [],
  };
}

/**
 * A domain that resolves normally.
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
export interface InspectionOverrides extends Partial<Omit<TlsInspection, 'chain'>> {
  /** Fields of the end-entity certificate to change. */
  leaf?: Partial<CertificateSummary>;
  /** Fields of the chain verdict to change. */
  chain?: Partial<Omit<ChainSummary, 'leaf'>>;
}

/**
 * A TLS inspection of a healthy certificate.
 *
 * @param overrides Fields to change. `leaf` reaches the certificate itself, so a
 *   test can change one date without restating the whole chain.
 * @returns An inspection.
 */
export function inspection(overrides: InspectionOverrides = {}): TlsInspection {
  const { leaf, chain, ...rest } = overrides;
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
    ...rest,
  };
}

/** Overridable slices of the I/O boundary. */
export interface FakeOptions {
  dnsRecords?: DnsRecords | Error;
  dsRecord?: boolean | null;
  rdap?: RdapLookup | Error;
  tls?: TlsInspection | Error;
  hops?: Record<
    string,
    { status: number; headers?: Record<string, string>; location?: string } | Error
  >;
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
    },
    now: () => options.now ?? NOW,
  };
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
