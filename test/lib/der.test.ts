import { describe, expect, it } from 'vitest';
import {
  childrenOf,
  concat,
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
} from '../../src/lib/der.js';

/**
 * The DER reader, tested on the input it actually meets.
 *
 * Every byte it parses was chosen by a stranger's web server or by that
 * server's certificate authority, so the cases that matter here are the
 * malformed ones. A parser that reads a well-formed OCSP response is table
 * stakes; one that refuses a length field claiming four gigabytes without
 * allocating anything is the point.
 */

describe('readNode', () => {
  it('reads a short-form length', () => {
    const node = readNode(Uint8Array.from([0x04, 0x03, 1, 2, 3]), 0);
    expect(node).toMatchObject({ tag: 0x04, contentStart: 2, contentEnd: 5, end: 5 });
  });

  it('reads a long-form length', () => {
    const bytes = concat([Uint8Array.from([0x04, 0x82, 0x01, 0x00]), new Uint8Array(256)]);
    expect(readNode(bytes, 0)).toMatchObject({ contentStart: 4, end: 260 });
  });

  it('refuses a length that runs past the buffer', () => {
    // The one that matters: without this check the offsets come back pointing
    // outside the buffer, and every read after it is silently empty rather than
    // wrong in a way anyone notices.
    expect(() => readNode(Uint8Array.from([0x04, 0x7f, 1, 2, 3]), 0)).toThrow(DerError);
  });

  it('refuses an indefinite length', () => {
    // BER, not DER. Accepting it would mean scanning forward for two zero bytes
    // through content that may legitimately contain them.
    expect(() => readNode(Uint8Array.from([0x30, 0x80, 0x00, 0x00]), 0)).toThrow(/indefinite/);
  });

  it('refuses an absurd length-of-length before assembling it', () => {
    expect(() => readNode(Uint8Array.from([0x04, 0x88, 1, 2, 3, 4, 5, 6, 7, 8]), 0)).toThrow(
      /8 octets/,
    );
  });

  it('refuses a header the buffer ends inside', () => {
    expect(() => readNode(Uint8Array.from([0x30]), 0)).toThrow(DerError);
    expect(() => readNode(new Uint8Array(0), 0)).toThrow(DerError);
  });
});

describe('childrenOf', () => {
  it('walks the members of a sequence', () => {
    const bytes = encodeSequence(
      encode(TAG.integer, Uint8Array.from([1])),
      encode(TAG.octetString, Uint8Array.from([2, 3])),
    );
    const children = childrenOf(bytes, readNode(bytes, 0));

    expect(children.map((child) => child.tag)).toEqual([TAG.integer, TAG.octetString]);
  });

  it('refuses a child that runs past its parent', () => {
    // A structure whose members overflow it is not the structure it claims to
    // be, and reading on would walk into whatever follows.
    const bytes = Uint8Array.from([0x30, 0x02, 0x04, 0x05, 0, 0, 0, 0, 0]);
    expect(() => childrenOf(bytes, readNode(bytes, 0))).toThrow(/past its parent/);
  });

  it('reads an empty sequence as no children', () => {
    const bytes = encodeSequence();
    expect(childrenOf(bytes, readNode(bytes, 0))).toEqual([]);
  });
});

describe('readOid', () => {
  it('reads the two arcs that share the first octet', () => {
    // `1.3.14.3.2.26` is id-sha1, the digest every OCSP CertID is built with.
    const bytes = encode(TAG.oid, Uint8Array.from([0x2b, 0x0e, 0x03, 0x02, 0x1a]));
    expect(readOid(bytes, readNode(bytes, 0))).toBe('1.3.14.3.2.26');
  });

  it('reads arcs that need more than one octet', () => {
    // `1.3.6.1.5.5.7.48.1.1` is id-pkix-ocsp-basic; the `48` arc is where a
    // naive reader that ignores the continuation bit starts going wrong.
    const bytes = encode(
      TAG.oid,
      Uint8Array.from([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x01, 0x01]),
    );
    expect(readOid(bytes, readNode(bytes, 0))).toBe('1.3.6.1.5.5.7.48.1.1');
  });

  it('reads an arc whose first octet is 80 or more', () => {
    // `2.100.3`: arc 1 is 2 and arc 2 is 100, which cannot be recovered by
    // dividing the first octet by 40.
    const bytes = encode(TAG.oid, Uint8Array.from([0x81, 0x34, 0x03]));
    expect(readOid(bytes, readNode(bytes, 0))).toBe('2.100.3');
  });

  it('refuses an identifier that ends mid-arc', () => {
    const bytes = encode(TAG.oid, Uint8Array.from([0x2b, 0x81]));
    expect(() => readOid(bytes, readNode(bytes, 0))).toThrow(/mid-arc/);
  });

  it('refuses a node that is not an identifier at all', () => {
    const bytes = encode(TAG.integer, Uint8Array.from([1]));
    expect(() => readOid(bytes, readNode(bytes, 0))).toThrow(/object identifier/);
  });
});

describe('readGeneralizedTime', () => {
  it('reads the form RFC 6960 requires', () => {
    const bytes = encode(0x18, new TextEncoder().encode('20260609143738Z'));
    expect(readGeneralizedTime(bytes, readNode(bytes, 0))).toBe('2026-06-09T14:37:38.000Z');
  });

  it('refuses a local time, rather than guessing at an offset', () => {
    // A guessed timestamp in a client report is worse than an absent one: it
    // would be off by hours and look exactly as authoritative.
    const bytes = encode(0x18, new TextEncoder().encode('20260609143738'));
    expect(readGeneralizedTime(bytes, readNode(bytes, 0))).toBeNull();
  });

  it('refuses a date that does not exist', () => {
    // `Date.UTC` rolls the 31st of February into March rather than rejecting it.
    const bytes = encode(0x18, new TextEncoder().encode('20260231000000Z'));
    expect(readGeneralizedTime(bytes, readNode(bytes, 0))).toBeNull();
  });
});

describe('readUnsignedHex', () => {
  it('strips the zero DER adds to keep an integer positive', () => {
    // The same serial number is `A4A3…` on a certificate and `00A4A3…` in an
    // OCSP response. Stripping is what makes the two comparable, which is what
    // decides whether an answer is about the certificate that was served.
    const padded = encode(TAG.integer, Uint8Array.from([0x00, 0xa4, 0xa3]));
    const bare = encode(TAG.integer, Uint8Array.from([0x1b, 0x11]));

    expect(readUnsignedHex(padded, readNode(padded, 0))).toBe('A4A3');
    expect(readUnsignedHex(bare, readNode(bare, 0))).toBe('1B11');
  });

  it('keeps a single zero as a value rather than stripping it away', () => {
    const bytes = encode(TAG.integer, Uint8Array.from([0x00]));
    expect(readUnsignedHex(bytes, readNode(bytes, 0))).toBe('00');
  });
});

describe('readBitString', () => {
  it('drops the unused-bits octet', () => {
    // That octet is a count, not data. Digesting it would produce an
    // `issuerKeyHash` no responder recognises.
    const bytes = encode(TAG.bitString, Uint8Array.from([0x00, 0xde, 0xad]));
    expect([...readBitString(bytes, readNode(bytes, 0))]).toEqual([0xde, 0xad]);
  });

  it('refuses a bit string with no unused-bits octet', () => {
    const bytes = encode(TAG.bitString, new Uint8Array(0));
    expect(() => readBitString(bytes, readNode(bytes, 0))).toThrow(/empty bit string/);
  });
});

describe('encode', () => {
  it('round-trips through the reader', () => {
    const content = new Uint8Array(300).fill(7);
    const bytes = encode(TAG.octetString, content);
    const node = readNode(bytes, 0);

    expect(node.contentEnd - node.contentStart).toBe(300);
    expect(tripleOf(bytes, node)).toHaveLength(bytes.length);
  });

  it('uses the short form below 128 bytes and the long form at or above it', () => {
    // DER admits exactly one encoding per value, and a responder that receives
    // the other one answers `malformedRequest`.
    expect(encode(TAG.octetString, new Uint8Array(127))[1]).toBe(127);
    expect(encode(TAG.octetString, new Uint8Array(128))[1]).toBe(0x81);
  });
});
