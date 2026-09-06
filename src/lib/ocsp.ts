import { createHash, createPublicKey, verify, X509Certificate } from 'node:crypto';
import {
  childrenOf,
  contentOf,
  encode,
  encodeSequence,
  readBitString,
  readGeneralizedTime,
  readNode,
  readOid,
  readUnsignedHex,
  tripleOf,
  DerError,
  TAG,
  type DerNode,
} from './der.js';
import { CheckError } from './errors.js';

/**
 * Asking a certificate's own issuer whether it has been revoked, over OCSP
 * (RFC 6960).
 *
 * This is the one question a TLS handshake cannot answer. Node performs no
 * revocation check of its own, so a certificate revoked an hour ago still
 * completes a handshake and still reports `authorized: true` — which is exactly
 * the certificate a maintenance check exists to find.
 *
 * Two things make this safe to do from a server that talks to strangers. The
 * responder URL comes out of the certificate being inspected, so it is chosen by
 * whoever runs the target and goes through the same target guard as every other
 * outbound request. And the answer is only believed once its signature verifies
 * against the issuing CA: an OCSP response travels over plain HTTP by design,
 * because the signature — not the transport — is what makes it evidence.
 */

/** What the issuer said about one certificate. */
export interface OcspAnswer {
  /** The responder's verdict. */
  status: 'good' | 'revoked' | 'unknown';
  /**
   * Whether the response's signature verified against the issuing CA.
   *
   * `false` is not a rejection — the answer is still reported — but it is the
   * difference between evidence and hearsay, and the caller grades it as such.
   */
  signatureVerified: boolean;
  /** When the responder produced this answer, ISO 8601 UTC. */
  producedAt: string | null;
  /** When the status it reports was known to be correct, ISO 8601 UTC. */
  thisUpdate: string | null;
  /** When a newer answer will be available, ISO 8601 UTC, or `null` if unstated. */
  nextUpdate: string | null;
  /** When the certificate was revoked, ISO 8601 UTC. `null` unless revoked. */
  revokedAt: string | null;
  /** Why it was revoked, e.g. `keyCompromise`. `null` when unstated or not revoked. */
  reason: string | null;
}

/** `id-pkix-ocsp-basic`, the only response type RFC 6960 defines. */
const BASIC_RESPONSE_OID = '1.3.6.1.5.5.7.48.1.1';

/** `id-kp-OCSPSigning`, which a delegated responder must carry to be believed. */
const OCSP_SIGNING_EKU = '1.3.6.1.5.5.7.3.9';

/** `id-sha1`, the digest every CertID in the wild is built with. */
const SHA1_OID = '1.3.14.3.2.26';

/** Digest algorithms a CertID may name, by OID. */
const CERT_ID_DIGESTS: Record<string, string> = {
  [SHA1_OID]: 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};

/**
 * Signature algorithms this project will verify, by OID.
 *
 * An algorithm that is absent is not treated as a failure of the certificate:
 * the answer is reported with `signatureVerified: false`, because "this tool
 * cannot check that signature" and "that signature is wrong" are different
 * statements and only one of them is about the site being checked.
 *
 * RSASSA-PSS (`1.2.840.113549.1.1.10`) is deliberately absent. Its parameters
 * live in the algorithm identifier rather than in the OID, so verifying it means
 * parsing salt length and mask function out of the response and handing them
 * back to `crypto.verify` — a second parser for an algorithm no public responder
 * has been observed to use.
 */
const SIGNATURE_DIGESTS: Record<string, string | null> = {
  '1.2.840.113549.1.1.5': 'sha1',
  '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512',
  '1.2.840.10045.4.1': 'sha1',
  '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384',
  '1.2.840.10045.4.3.4': 'sha512',
  // Ed25519 hashes internally; `crypto.verify` wants no algorithm named.
  '1.3.101.112': null,
};

/** `OCSPResponseStatus`, RFC 6960 section 4.2.1, worded for a maintenance report. */
const RESPONSE_STATUS: Record<number, string> = {
  1: 'the responder rejected the request as malformed',
  2: 'the responder reported an internal error',
  3: 'the responder asked to be tried later',
  5: 'the responder requires signed requests',
  6: 'the responder is not authorised to answer for this certificate',
};

/** `CRLReason`, RFC 5280 section 5.3.1. */
const REVOCATION_REASONS: Record<number, string> = {
  0: 'unspecified',
  1: 'keyCompromise',
  2: 'cACompromise',
  3: 'affiliationChanged',
  4: 'superseded',
  5: 'cessationOfOperation',
  6: 'certificateHold',
  8: 'removeFromCRL',
  9: 'privilegeWithdrawn',
  10: 'aACompromise',
};

/** The fields of a certificate an OCSP exchange refers to. */
interface CertificateFields {
  /** The serial number's whole triple, ready to be copied into a CertID. */
  serialTriple: Uint8Array;
  /** Serial number as unsigned hex, for comparing against a response. */
  serialHex: string;
  /** The subject `Name`, whole triple, which is what `issuerNameHash` digests. */
  subjectTriple: Uint8Array;
  /** The public key's bits, which is what `issuerKeyHash` digests. */
  publicKeyBits: Uint8Array;
}

/**
 * Builds the DER `OCSPRequest` that asks about one certificate.
 *
 * The request is unsigned and carries no nonce. Unsigned because RFC 6960 makes
 * signing optional and every public responder accepts anonymous requests —
 * signing one would mean holding a key, which principle 1 forbids outright. No
 * nonce because most large responders pre-sign their answers and serve them from
 * a CDN; a nonce makes those responders either ignore it or refuse, so asking
 * for one buys replay protection from nobody and costs answers from several.
 *
 * @param leafDer The certificate being asked about, DER encoded.
 * @param issuerDer The certificate that signed it, DER encoded.
 * @returns The DER request, ready to POST as `application/ocsp-request`.
 * @throws {CheckError} `unexpected` when either certificate cannot be parsed far
 *   enough to name the fields a CertID is built from.
 */
export function buildOcspRequest(leafDer: Uint8Array, issuerDer: Uint8Array): Uint8Array {
  const leaf = certificateFields(leafDer, 'the certificate');
  const issuer = certificateFields(issuerDer, 'its issuer');

  // SHA-1 here is not a security claim and is not negotiable: RFC 6960 fixes the
  // CertID digest, responders index their databases by it, and one built with
  // SHA-256 comes back `unknown` from responders that answer the SHA-1 form
  // perfectly well. It identifies a certificate; it does not protect anything.
  const certId = encodeSequence(
    encodeSequence(encodeOid(SHA1_OID), encode(TAG.null, new Uint8Array(0))),
    encode(TAG.octetString, digest('sha1', issuer.subjectTriple)),
    encode(TAG.octetString, digest('sha1', issuer.publicKeyBits)),
    leaf.serialTriple,
  );

  // OCSPRequest { tbsRequest { requestList { Request { reqCert } } } }, with
  // every optional field left out.
  return encodeSequence(encodeSequence(encodeSequence(encodeSequence(certId))));
}

/**
 * Reads a responder's answer about one certificate, and checks that it is
 * genuinely about that certificate.
 *
 * The CertID in the response is matched against the certificate that was asked
 * about rather than trusted. A stapled response arrives from the same server
 * that chose the certificate, so a server serving a revoked certificate
 * alongside a valid response for a different one is the obvious way to fake a
 * clean result — and it costs one hash to refuse.
 *
 * @param responseDer The DER `OCSPResponse`.
 * @param leafDer The certificate the answer should be about.
 * @param issuerDer The certificate that signed it, used to verify the signature.
 * @returns The verdict, with `signatureVerified` saying how much it is worth.
 * @throws {CheckError} `network` when the response is not successful, is not
 *   parseable as DER, carries no answer about this certificate, or is a
 *   response type this project does not implement.
 */
export function readOcspResponse(
  responseDer: Uint8Array,
  leafDer: Uint8Array,
  issuerDer: Uint8Array,
): OcspAnswer {
  try {
    return parseAndVerify(responseDer, leafDer, issuerDer);
  } catch (cause) {
    if (cause instanceof CheckError) throw cause;
    if (cause instanceof DerError) {
      throw new CheckError('network', `the responder's answer is not valid DER: ${cause.message}`, {
        cause,
      });
    }
    throw cause;
  }
}

/**
 * The body of {@link readOcspResponse}, separated so one `catch` covers every
 * DER read in it rather than each one carrying its own.
 *
 * @param responseDer The DER `OCSPResponse`.
 * @param leafDer The certificate the answer should be about.
 * @param issuerDer The certificate that signed it.
 * @returns The verdict.
 * @throws {CheckError} As {@link readOcspResponse}. {@link DerError} for
 *   malformed input, which the caller translates.
 */
function parseAndVerify(
  responseDer: Uint8Array,
  leafDer: Uint8Array,
  issuerDer: Uint8Array,
): OcspAnswer {
  const response = childrenOf(responseDer, readNode(responseDer, 0));

  const statusNode = response[0];
  if (statusNode === undefined) throw new CheckError('network', 'the responder sent no status');
  const status = contentOf(responseDer, statusNode)[0] ?? -1;
  if (status !== 0) {
    throw new CheckError(
      'network',
      RESPONSE_STATUS[status] ?? `the responder sent an unknown status (${String(status)})`,
    );
  }

  // `responseBytes` is optional in the grammar and absent on every unsuccessful
  // status — which the check above has already ruled out, so its absence here
  // means a responder that claimed success and sent nothing.
  const responseBytes = expect(response[1], 'a successful response with no body');
  const bytes = childrenOf(responseDer, expect(childrenOf(responseDer, responseBytes)[0], 'body'));

  const typeOid = readOid(responseDer, expect(bytes[0], 'a response with no type'));
  if (typeOid !== BASIC_RESPONSE_OID) {
    throw new CheckError('network', `the responder sent an unsupported response type (${typeOid})`);
  }

  // The basic response is wrapped in an OCTET STRING, so it is read from the
  // start of that string's content rather than from a child of it.
  const wrapper = expect(bytes[1], 'a response with no body');
  const basic = childrenOf(responseDer, readNode(responseDer, wrapper.contentStart));

  const tbs = expect(basic[0], 'a response with no data');
  const single = findSingleResponse(responseDer, tbs, leafDer, issuerDer);

  return {
    ...readCertStatus(responseDer, single),
    signatureVerified: verifySignature(responseDer, basic, tbs, issuerDer),
    producedAt: readProducedAt(responseDer, tbs),
  };
}

/**
 * Finds the answer that is about the certificate we asked about.
 *
 * @param bytes The response buffer.
 * @param tbs The `tbsResponseData` node.
 * @param leafDer The certificate the answer should be about.
 * @param issuerDer Its issuer.
 * @returns The matching `SingleResponse`.
 * @throws {CheckError} `network` when none of the answers is about this
 *   certificate.
 */
function findSingleResponse(
  bytes: Uint8Array,
  tbs: DerNode,
  leafDer: Uint8Array,
  issuerDer: Uint8Array,
): DerNode {
  const fields = childrenOf(bytes, tbs);
  // `version` is `[0] EXPLICIT` with a default, so it is usually absent;
  // `responderID` is `[1]` or `[2]`. Skipping the one and stepping over the
  // other is what puts `responses` at a known place.
  let index = fields[0]?.tag === 0xa0 ? 1 : 0;
  index += 1;
  index += 1;

  const responses = childrenOf(bytes, expect(fields[index], 'a response with no answers'));
  const leaf = certificateFields(leafDer, 'the certificate');
  const issuer = certificateFields(issuerDer, 'its issuer');

  for (const single of responses) {
    const certId = childrenOf(bytes, expect(childrenOf(bytes, single)[0], 'an answer with no id'));
    const algorithm = readOid(bytes, expect(childrenOf(bytes, expect(certId[0], 'id'))[0], 'id'));
    const digestName = CERT_ID_DIGESTS[algorithm];
    if (digestName === undefined) continue;

    const nameHash = contentOf(bytes, expect(certId[1], 'id'));
    const keyHash = contentOf(bytes, expect(certId[2], 'id'));
    const serial = readUnsignedHex(bytes, expect(certId[3], 'id'));

    if (
      serial === leaf.serialHex &&
      equal(nameHash, digest(digestName, issuer.subjectTriple)) &&
      equal(keyHash, digest(digestName, issuer.publicKeyBits))
    ) {
      return single;
    }
  }

  throw new CheckError(
    'network',
    'the responder answered about a different certificate than the one served',
  );
}

/**
 * Reads a `SingleResponse`'s verdict and dates.
 *
 * @param bytes The response buffer.
 * @param single The `SingleResponse` node.
 * @returns The verdict, dates included, without the signature verdict.
 * @throws {CheckError} `network` when the status is a CHOICE alternative RFC
 *   6960 does not define.
 */
function readCertStatus(
  bytes: Uint8Array,
  single: DerNode,
): Omit<OcspAnswer, 'signatureVerified' | 'producedAt'> {
  const parts = childrenOf(bytes, single);
  const certStatus = expect(parts[1], 'an answer with no status');
  const thisUpdate = readGeneralizedTime(bytes, expect(parts[2], 'an answer with no date'));

  // `[0] nextUpdate` is EXPLICIT and `[1] singleExtensions` is not the same
  // thing, so the tag is what distinguishes them rather than the position.
  const nextUpdateNode = parts.slice(3).find((part) => part.tag === 0xa0);
  const nextUpdate =
    nextUpdateNode === undefined
      ? null
      : readGeneralizedTime(bytes, expect(childrenOf(bytes, nextUpdateNode)[0], 'nextUpdate'));

  // `good` is `[0] IMPLICIT NULL` and `unknown` is `[2] IMPLICIT UnknownInfo`,
  // both primitive; `revoked` is `[1] IMPLICIT RevokedInfo`, a SEQUENCE, hence
  // the constructed bit.
  if (certStatus.tag === 0x80) {
    return { status: 'good', thisUpdate, nextUpdate, revokedAt: null, reason: null };
  }
  if (certStatus.tag === 0x82) {
    return { status: 'unknown', thisUpdate, nextUpdate, revokedAt: null, reason: null };
  }
  if (certStatus.tag !== 0xa1) {
    throw new CheckError(
      'network',
      `the responder sent an unrecognised certificate status (tag 0x${certStatus.tag.toString(16)})`,
    );
  }

  const revoked = childrenOf(bytes, certStatus);
  const revokedAt = readGeneralizedTime(bytes, expect(revoked[0], 'a revocation with no date'));
  const reasonNode = revoked[1];
  const code =
    reasonNode === undefined
      ? null
      : (contentOf(bytes, expect(childrenOf(bytes, reasonNode)[0], 'reason'))[0] ?? null);

  return {
    status: 'revoked',
    thisUpdate,
    nextUpdate,
    revokedAt,
    reason: code === null ? null : (REVOCATION_REASONS[code] ?? `reason ${String(code)}`),
  };
}

/**
 * @param bytes The response buffer.
 * @param tbs The `tbsResponseData` node.
 * @returns `producedAt` in ISO 8601, or `null` when it is absent or malformed.
 * @throws {DerError} When the structure cannot be walked.
 */
function readProducedAt(bytes: Uint8Array, tbs: DerNode): string | null {
  const fields = childrenOf(bytes, tbs);
  const index = (fields[0]?.tag === 0xa0 ? 1 : 0) + 1;
  const node = fields[index];
  return node === undefined ? null : readGeneralizedTime(bytes, node);
}

/**
 * Verifies a basic response's signature against the issuing CA.
 *
 * Two shapes exist. Usually the issuing CA signs its own OCSP responses and the
 * response carries no certificates, so the issuer's key verifies it directly.
 * Otherwise the CA has delegated to a responder whose certificate travels inside
 * the response — and that certificate is only believed once it is shown to have
 * been issued by the same CA and to carry the OCSP-signing extended key usage.
 * Without that second condition any certificate the CA ever issued, including
 * one for an ordinary website, could sign revocation answers for the whole CA.
 *
 * @param bytes The response buffer.
 * @param basic The `BasicOCSPResponse` members.
 * @param tbs The `tbsResponseData` node, which is what the signature covers.
 * @param issuerDer The issuing CA's certificate.
 * @returns Whether the signature verified. `false` for anything unverifiable —
 *   an algorithm not implemented here, a delegation that does not hold up, a
 *   certificate that will not parse — never a throw, because "not verified" is
 *   a fact about the answer that the caller reports rather than a failure of the
 *   check.
 * @throws Never.
 */
function verifySignature(
  bytes: Uint8Array,
  basic: readonly DerNode[],
  tbs: DerNode,
  issuerDer: Uint8Array,
): boolean {
  try {
    const algorithmNode = basic[1];
    const signatureNode = basic[2];
    if (algorithmNode === undefined || signatureNode === undefined) return false;

    const algorithm = readOid(bytes, expect(childrenOf(bytes, algorithmNode)[0], 'algorithm'));
    if (!(algorithm in SIGNATURE_DIGESTS)) return false;
    const digestName = SIGNATURE_DIGESTS[algorithm] ?? null;

    const issuer = new X509Certificate(issuerDer);
    const signer = signingKey(bytes, basic, issuer);
    if (signer === null) return false;

    return verify(digestName, tripleOf(bytes, tbs), signer, readBitString(bytes, signatureNode));
  } catch {
    return false;
  }
}

/**
 * Decides whose key signed a response, and whether that key may.
 *
 * @param bytes The response buffer.
 * @param basic The `BasicOCSPResponse` members.
 * @param issuer The issuing CA.
 * @returns The public key to verify with, or `null` when the response names a
 *   delegate this project will not accept.
 * @throws Whatever `X509Certificate` throws for unparseable DER; the caller
 *   treats that as unverified.
 */
function signingKey(
  bytes: Uint8Array,
  basic: readonly DerNode[],
  issuer: X509Certificate,
): ReturnType<typeof createPublicKey> | null {
  // `certs` is `[0] EXPLICIT SEQUENCE OF Certificate`, the fourth member and
  // the only optional one, so its presence is what says the CA delegated.
  const certs = basic[3];
  if (certs === undefined) return issuer.publicKey;

  const first = childrenOf(bytes, expect(childrenOf(bytes, certs)[0], 'certs'))[0];
  if (first === undefined) return issuer.publicKey;

  const responder = new X509Certificate(tripleOf(bytes, first));
  if (!responder.checkIssued(issuer)) return null;
  if (!responder.verify(issuer.publicKey)) return null;
  if (!extendedKeyUsagesOf(responder).includes(OCSP_SIGNING_EKU)) return null;

  return responder.publicKey;
}

/**
 * Reads a certificate's extended key usages.
 *
 * Despite the name, Node's `keyUsage` is the *extended* key usage list, and it
 * types it as always present. It is not: a certificate carrying no such
 * extension has none, and a delegated responder without one is precisely the
 * case {@link signingKey} exists to reject.
 *
 * @param certificate The certificate to read.
 * @returns Its extended key usage OIDs, or an empty list when it declares none.
 * @throws Never.
 */
function extendedKeyUsagesOf(certificate: X509Certificate): string[] {
  const { keyUsage } = certificate as { keyUsage?: string[] };
  return keyUsage ?? [];
}

/**
 * Reads the certificate fields an OCSP exchange is built from.
 *
 * Node's `X509Certificate` exposes the subject as a formatted string and the key
 * as a `KeyObject`, and an OCSP CertID digests neither of those — it digests the
 * DER of the subject `Name` and the raw bits of the `subjectPublicKey`. Both are
 * only reachable by walking the certificate, which is why this exists rather
 * than calling into `node:crypto`.
 *
 * @param der The certificate, DER encoded.
 * @param label What the certificate is, for the error message.
 * @returns The fields.
 * @throws {CheckError} `unexpected` when the certificate cannot be walked as
 *   far as its `subjectPublicKeyInfo`.
 */
function certificateFields(der: Uint8Array, label: string): CertificateFields {
  try {
    const tbs = expect(childrenOf(der, readNode(der, 0))[0], 'tbsCertificate');
    const fields = childrenOf(der, tbs);

    // `version` is `[0] EXPLICIT` and defaults to v1, so it is absent on a v1
    // certificate and every field after it shifts by one.
    const base = fields[0]?.tag === 0xa0 ? 1 : 0;
    const serial = expect(fields[base], 'serialNumber');
    const subject = expect(fields[base + 4], 'subject');
    const spki = expect(fields[base + 5], 'subjectPublicKeyInfo');

    return {
      serialTriple: tripleOf(der, serial),
      serialHex: readUnsignedHex(der, serial),
      subjectTriple: tripleOf(der, subject),
      publicKeyBits: readBitString(der, expect(childrenOf(der, spki)[1], 'subjectPublicKey')),
    };
  } catch (cause) {
    throw new CheckError('unexpected', `could not read ${label} as X.509`, { cause });
  }
}

/**
 * @param oid A dotted object identifier.
 * @returns Its DER encoding.
 * @throws Never. Only this module's own constants are passed here.
 */
function encodeOid(oid: string): Uint8Array {
  const arcs = oid.split('.').map(Number);
  const octets: number[] = [(arcs[0] ?? 0) * 40 + (arcs[1] ?? 0)];

  for (const arc of arcs.slice(2)) {
    const base128: number[] = [arc % 128];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) {
      base128.unshift((rest % 128) | 0x80);
    }
    octets.push(...base128);
  }

  return encode(TAG.oid, Uint8Array.from(octets));
}

/**
 * @param algorithm A digest name `node:crypto` knows.
 * @param data What to digest.
 * @returns The digest.
 * @throws Never for the algorithms named in this module.
 */
function digest(algorithm: string, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash(algorithm).update(data).digest());
}

/**
 * @param left One buffer.
 * @param right Another.
 * @returns Whether they hold the same bytes.
 * @throws Never.
 */
function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

/**
 * Narrows an optional structure member to a present one.
 *
 * The grammar says how many members each structure has; a response with fewer is
 * malformed, and every one of these would otherwise be an `undefined` check that
 * reads as if the member were optional.
 *
 * @param node The member, which the type system cannot know is present.
 * @param what What was expected, for the message.
 * @returns The member.
 * @throws {CheckError} `network` when it is absent.
 */
function expect(node: DerNode | undefined, what: string): DerNode {
  if (node === undefined) throw new CheckError('network', `the responder sent ${what}`);
  return node;
}
