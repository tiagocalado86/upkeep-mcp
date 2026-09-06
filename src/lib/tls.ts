import { isIP } from 'node:net';
import { connect, type DetailedPeerCertificate } from 'node:tls';
import type { CertificateSummary, ChainSummary } from '../types.js';
import { LIMITS, TIMEOUTS } from './defaults.js';
import { CheckError, categorise } from './errors.js';

/**
 * What is needed to ask a certificate's issuer whether it has been revoked.
 *
 * Carried out of the handshake rather than acted on here, because asking costs a
 * request to a third party and this module opens sockets rather than deciding
 * policy. `ports.ts` composes the two.
 */
export interface RevocationMaterials {
  /** The end-entity certificate, DER encoded. `null` when none was served. */
  leafDer: Uint8Array | null;
  /**
   * The certificate that signed it, DER encoded.
   *
   * `null` when the server omitted its intermediate — the same
   * misconfiguration that shows up as `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. An
   * OCSP request identifies a certificate by hashes of its issuer's name and
   * key, so without the issuer there is no question to ask.
   */
  issuerDer: Uint8Array | null;
  /** OCSP responder URLs the certificate publishes, in the order it lists them. */
  responderUrls: string[];
  /**
   * A response the server stapled to this handshake, DER encoded.
   *
   * The free answer: the server has already asked the responder on the client's
   * behalf and included the signed reply, so a staple settles the question
   * without this project contacting the certificate authority at all.
   */
  stapled: Uint8Array | null;
}

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
  /** What this handshake yielded towards a revocation check. */
  revocation: RevocationMaterials;
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
      // Asks the server to include the issuer's signed revocation answer in the
      // handshake. Costs one TLS extension and no request: a server that
      // staples has already asked the certificate authority, so this is the
      // only way to check revocation without contacting a third party at all.
      requestOCSP: true,
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

    // Emitted during the handshake, before `secureConnect`. A server that
    // declines to staple does not stay quiet: Node emits the event anyway and
    // hands over `null`, which `new Uint8Array` turns into an empty array rather
    // than refusing. Without this guard every certificate with no staple and no
    // responder — every Let's Encrypt certificate, which is most of the web —
    // reports as one whose staple was examined and refused.
    let stapled: Uint8Array | null = null;
    socket.once('OCSPResponse', (response: Buffer | null) => {
      stapled = response === null || response.length === 0 ? null : new Uint8Array(response);
    });

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
          revocation: {
            leafDer: rawOf(detailed),
            issuerDer: rawOf(issuerOf(detailed)),
            responderUrls: detailed.infoAccess?.['OCSP - URI'] ?? [],
            stapled,
          },
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
 * Reads a certificate's DER, tolerating the absence of the certificate itself.
 *
 * @param certificate The certificate, or `undefined` when the chain ended.
 * @returns Its DER encoding, or `null` when there is no certificate to read.
 * @throws Never.
 */
function rawOf(certificate: DetailedPeerCertificate | undefined): Uint8Array | null {
  // Node types `raw` as always present, and it is not: an absent peer
  // certificate comes back as an empty object, the same truth `walkChain`
  // relies on. The assertion narrows the declared type rather than widening it.
  const raw = (certificate as { raw?: Buffer } | undefined)?.raw;
  return raw === undefined ? null : new Uint8Array(raw);
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
