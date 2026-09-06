import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CheckError } from '../../src/lib/errors.js';
import { buildOcspRequest, readOcspResponse } from '../../src/lib/ocsp.js';

/**
 * OCSP, against responses recorded from real certificate authorities.
 *
 * Both fixtures are public test hosts run by the authorities themselves —
 * `digicert.com` for a certificate in good standing and `revoked-rsa-dv.ssl.com`
 * for one SSL.com revoked on purpose so that clients have something to test
 * against. No client data is involved.
 *
 * They are recorded rather than synthesised because the thing worth testing is
 * that this code reads what responders actually send, signatures included. A
 * response this project generated itself would only prove that it agrees with
 * its own encoder.
 */

/** A recorded exchange: the certificate, its issuer and the authority's answer. */
interface Recorded {
  leafDer: Uint8Array;
  issuerDer: Uint8Array;
  responseDer: Uint8Array;
}

/**
 * @param name Which fixture to load.
 * @returns The DER of each part.
 */
function recorded(name: 'good' | 'revoked'): Recorded {
  const raw = JSON.parse(readFileSync(`test/fixtures/ocsp-${name}.json`, 'utf8')) as Record<
    string,
    string
  >;
  const decode = (field: string): Uint8Array =>
    new Uint8Array(Buffer.from(raw[field] ?? '', 'base64'));

  return {
    leafDer: decode('leafDerBase64'),
    issuerDer: decode('issuerDerBase64'),
    responseDer: decode('responseDerBase64'),
  };
}

describe('buildOcspRequest', () => {
  it('produces a request a responder will accept', () => {
    // The shape is fixed: one CertID, no optional fields, no signature and no
    // nonce, which is what every public responder answers.
    const { leafDer, issuerDer } = recorded('good');
    const request = buildOcspRequest(leafDer, issuerDer);

    expect(request[0]).toBe(0x30);
    expect(request.length).toBeGreaterThan(70);
    expect(request.length).toBeLessThan(120);
  });

  it('asks a different question about a different certificate', () => {
    const good = recorded('good');
    const revoked = recorded('revoked');

    expect(buildOcspRequest(good.leafDer, good.issuerDer)).not.toEqual(
      buildOcspRequest(revoked.leafDer, revoked.issuerDer),
    );
  });

  it('refuses bytes that are not a certificate', () => {
    expect(() =>
      buildOcspRequest(Uint8Array.from([0x30, 0x00]), Uint8Array.from([0x30, 0x00])),
    ).toThrow(CheckError);
  });
});

describe('readOcspResponse', () => {
  it('reads a certificate in good standing, and verifies the signature', () => {
    const { leafDer, issuerDer, responseDer } = recorded('good');

    expect(readOcspResponse(responseDer, leafDer, issuerDer)).toMatchObject({
      status: 'good',
      signatureVerified: true,
      revokedAt: null,
    });
  });

  it('reads a revoked certificate, with the date it was revoked', () => {
    const { leafDer, issuerDer, responseDer } = recorded('revoked');
    const answer = readOcspResponse(responseDer, leafDer, issuerDer);

    expect(answer.status).toBe('revoked');
    expect(answer.signatureVerified).toBe(true);
    expect(answer.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(answer.reason).toBe('unspecified');
  });

  it('dates every answer it reads', () => {
    const { leafDer, issuerDer, responseDer } = recorded('good');
    const answer = readOcspResponse(responseDer, leafDer, issuerDer);

    expect(answer.producedAt).toMatch(/Z$/);
    expect(answer.thisUpdate).toMatch(/Z$/);
    // Responders pre-sign about a week ahead, which is why the answer is worth
    // caching for an hour without going stale.
    expect(Date.parse(answer.nextUpdate ?? '')).toBeGreaterThan(
      Date.parse(answer.thisUpdate ?? ''),
    );
  });

  it('refuses an answer about a different certificate', () => {
    // The attack this closes: a server serving a revoked certificate staples a
    // perfectly valid, perfectly signed response for some other certificate.
    // Without matching the CertID, that reads as "not revoked".
    const good = recorded('good');
    const revoked = recorded('revoked');

    expect(() => readOcspResponse(good.responseDer, revoked.leafDer, revoked.issuerDer)).toThrow(
      /different certificate/,
    );
  });

  it('reports a tampered answer as unverified rather than refusing it', () => {
    // One flipped bit in the signature. The status still parses — the answer is
    // still what somebody said — but nothing traces it to the authority that
    // issued the certificate, and the caller grades it accordingly rather than
    // treating it as a failed check.
    const { leafDer, issuerDer, responseDer } = recorded('good');
    const tampered = Uint8Array.from(responseDer);
    tampered[tampered.length - 1] = (responseDer.at(-1) ?? 0) ^ 0xff;

    expect(readOcspResponse(tampered, leafDer, issuerDer)).toMatchObject({
      status: 'good',
      signatureVerified: false,
    });
  });

  it('reports an unsuccessful response status in words', () => {
    // `tryLater` is `[3]`, wrapped in the one-member OCSPResponse a responder
    // sends when it is overloaded. It is the single most common non-answer.
    const tryLater = Uint8Array.from([0x30, 0x03, 0x0a, 0x01, 0x03]);
    const { leafDer, issuerDer } = recorded('good');

    expect(() => readOcspResponse(tryLater, leafDer, issuerDer)).toThrow(/tried later/);
  });

  it('refuses bytes that are not DER at all', () => {
    const { leafDer, issuerDer } = recorded('good');
    const noise = new Uint8Array(64).fill(0xff);

    expect(() => readOcspResponse(noise, leafDer, issuerDer)).toThrow(CheckError);
  });

  it('refuses a truncated response rather than reading past the end', () => {
    const { leafDer, issuerDer, responseDer } = recorded('good');

    expect(() => readOcspResponse(responseDer.subarray(0, 60), leafDer, issuerDer)).toThrow(
      CheckError,
    );
  });
});
