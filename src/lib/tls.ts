import { isIP } from 'node:net';
import { connect, type DetailedPeerCertificate } from 'node:tls';
import type { CertificateSummary, ChainSummary } from '../types.js';
import { LIMITS, TIMEOUTS } from './defaults.js';
import { CheckError, categorise } from './errors.js';

/** Everything one TLS handshake revealed. */
export interface TlsInspection {
  /** The certificate chain, and whether it verified. */
  chain: ChainSummary;
  /**
   * The raw `subjectAltName` extension, for display only.
   *
   * Never split this string to decide whether a host is covered: SAN entries can
   * be quoted JSON string literals, and splitting on `', '` is CVE-2021-44532.
   * Coverage comes from {@link TlsInspection.hostMatches}.
   */
  subjectAltName: string | null;
  /** For each hostname asked about, the SAN pattern that matched, or `null`. */
  hostMatches: Record<string, string | null>;
  /** Negotiated TLS version, e.g. `TLSv1.3`. */
  protocol: string | null;
  /** Negotiated cipher suite name. */
  cipher: string | null;
  /** Negotiated ALPN protocol, or `null` when none was agreed. */
  alpn: string | null;
}

/**
 * Opens a TLS connection and reports on the certificate it is served.
 *
 * Connects with `rejectUnauthorized: false` because the whole point is to
 * inspect certificates that are expired, self-signed or otherwise broken — the
 * ones a maintenance check exists to find. Validity is still reported
 * faithfully: `secureConnect` fires either way, and the socket carries the
 * verdict.
 *
 * @param host Hostname or IP in A-label form.
 * @param port TCP port.
 * @param names Hostnames to test for coverage, e.g. the apex and its `www`.
 * @param timeoutMs Handshake deadline.
 * @returns What the handshake revealed.
 * @throws {CheckError} `timeout` when the handshake does not complete in time,
 *   `network` when the connection fails.
 */
export function inspectTls(
  host: string,
  port: number,
  names: readonly string[],
  timeoutMs: number = TIMEOUTS.tlsMs,
): Promise<TlsInspection> {
  return new Promise<TlsInspection>((resolve, reject) => {
    const socket = connect({
      host,
      port,
      // `tls.connect` does not enable SNI on its own, unlike `https`. Without
      // this, a multi-homed host serves whichever certificate is its default.
      // It must be a name, never an IP.
      ...(isIP(host) === 0 ? { servername: host } : {}),
      rejectUnauthorized: false,
      ALPNProtocols: ['h2', 'http/1.1'],
    });

    // The `timeout` option would emit an event and leave the socket open, so the
    // deadline is enforced here instead.
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new CheckError(
          'timeout',
          `TLS handshake with ${host}:${String(port)} timed out after ${(timeoutMs / 1000).toFixed(0)}s`,
        ),
      );
    }, timeoutMs);

    socket.once('secureConnect', () => {
      clearTimeout(timer);
      try {
        // Everything must be read before the socket is destroyed:
        // getPeerCertificate returns null afterwards.
        const detailed = socket.getPeerCertificate(true);
        const x509 = socket.getPeerX509Certificate();
        const certificates = walkChain(detailed);

        const hostMatches: Record<string, string | null> = {};
        for (const name of names) {
          // A trailing dot makes checkHost return undefined, and partial
          // wildcards (`w*.example.com`) are accepted by default even though
          // browsers reject them — hence the explicit option.
          const matched = x509?.checkHost(name.replace(/\.$/, ''), { partialWildcards: false });
          hostMatches[name] = matched ?? null;
        }

        resolve({
          chain: {
            leaf: certificates[0] ?? null,
            issuers: certificates
              .map((certificate) => certificate.issuer ?? '')
              .filter((cn) => cn !== ''),
            length: certificates.length,
            valid: socket.authorized,
            error: socket.authorized
              ? null
              : ((socket.authorizationError as unknown as string | null) ?? null),
          },
          subjectAltName: x509?.subjectAltName ?? null,
          hostMatches,
          protocol: socket.getProtocol(),
          // getCipher().version is the cipher suite's *minimum* TLS version, not
          // the one negotiated. getProtocol() is the negotiated one.
          cipher: socket.getCipher().name,
          // alpnProtocol is three-valued: null before the handshake, false when
          // no protocol was agreed, otherwise the name.
          alpn: typeof socket.alpnProtocol === 'string' ? socket.alpnProtocol : null,
        });
      } catch (cause) {
        reject(
          new CheckError('unexpected', `could not read the certificate served by ${host}`, {
            cause,
          }),
        );
      } finally {
        socket.destroy();
      }
    });

    socket.once('error', (cause: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      reject(
        new CheckError(
          categorise(cause.code),
          `could not complete a TLS handshake with ${host}:${String(port)}: ${cause.message}`,
          { cause },
        ),
      );
    });
  });
}

/**
 * Walks a certificate chain from the leaf upwards.
 *
 * Exported so the termination guards can be tested without a TLS server: the
 * three ways a chain ends are the whole difficulty here, and two of them only
 * occur on certificates that are broken in a specific way.
 *
 * Termination needs all three guards. `issuerCertificate` is a circular
 * reference on every *successfully verified* chain, because the terminal root is
 * self-signed and points at itself; a self-signed leaf loops immediately at
 * depth zero; and a chain missing its intermediate simply has no
 * `issuerCertificate` at all.
 *
 * @param leaf The detailed peer certificate.
 * @returns One summary per certificate, leaf first. Empty when no certificate
 *   was presented.
 * @throws Never.
 */
export function walkChain(leaf: DetailedPeerCertificate): CertificateSummary[] {
  const summaries: CertificateSummary[] = [];
  const seen = new Set<string>();

  let current: DetailedPeerCertificate | undefined = leaf;
  for (let depth = 0; depth < LIMITS.maxChainDepth; depth += 1) {
    // An absent peer certificate comes back as an empty object, not as null.
    if (current === undefined || Object.keys(current).length === 0) break;
    if (seen.has(current.fingerprint256)) break;
    seen.add(current.fingerprint256);

    summaries.push({
      subject: subjectOf(current),
      issuer: commonName(current.issuer),
      serialNumber: current.serialNumber,
      fingerprintSha256: current.fingerprint256,
      validFrom: toIso(current.valid_from),
      validTo: toIso(current.valid_to),
    });

    const issuer = issuerOf(current);
    if (issuer === current) break;
    current = issuer;
  }

  return summaries;
}

/**
 * Reads a certificate's issuer link.
 *
 * Node types `issuerCertificate` as always present, but it genuinely is not: a
 * server that omits its intermediate serves a chain that simply stops. The
 * assertion here narrows the declared type to the truth rather than widening it.
 *
 * @param certificate The certificate to read.
 * @returns The issuer, or `undefined` when the chain ends here.
 * @throws Never.
 */
function issuerOf(certificate: DetailedPeerCertificate): DetailedPeerCertificate | undefined {
  const { issuerCertificate } = certificate as { issuerCertificate?: DetailedPeerCertificate };
  return issuerCertificate;
}

/**
 * Names a certificate.
 *
 * The common name is preferred, but it is no longer required: the CA/Browser
 * Forum deprecated it in favour of subject alternative names, and certificates
 * that omit it exist in the wild. Reporting `null` for those would show a
 * maintenance report a certificate with no name, so the first DNS name it
 * covers is used instead.
 *
 * @param certificate The certificate to name.
 * @returns Its common name, its first DNS SAN, or `null` when it has neither.
 * @throws Never.
 */
function subjectOf(certificate: DetailedPeerCertificate): string | null {
  const cn = commonName(certificate.subject);
  if (cn !== null) return cn;

  const firstDnsName = (certificate.subjectaltname ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('DNS:'));

  return firstDnsName === undefined ? null : firstDnsName.slice('DNS:'.length);
}

/**
 * Extracts the common name from a certificate's subject or issuer.
 *
 * A distinguished name may repeat an attribute, so Node types each field as a
 * string or an array of them. A certificate with two CNs is malformed; the first
 * is the one anything else would use.
 *
 * @param name The `subject` or `issuer` object, which may be absent.
 * @returns The common name, or `null`.
 * @throws Never.
 */
function commonName(name: { CN?: string | string[] } | undefined): string | null {
  const cn = name?.CN;
  if (typeof cn === 'string') return cn;
  if (Array.isArray(cn)) return cn[0] ?? null;
  return null;
}

/**
 * Converts a certificate date into ISO 8601 UTC.
 *
 * @param value A date string such as `Apr  9 00:00:00 2015 GMT` — note the
 *   double space for single-digit days.
 * @returns The ISO form, or `null` when unparseable.
 * @throws Never.
 */
function toIso(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
