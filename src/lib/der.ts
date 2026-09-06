/**
 * The slice of DER this project needs to read an OCSP response.
 *
 * Deliberately not a general ASN.1 library. OCSP is a closed grammar of about a
 * dozen structures (RFC 6960, appendix B) and the certificate fields it refers
 * to are three more, so the reader below understands tags, definite lengths and
 * nothing else — which is also what makes it safe to point at bytes a stranger's
 * web server chose. A general parser would have to survive far more input than
 * this ever sees.
 *
 * Every function here treats its input as hostile: lengths are checked against
 * the buffer before they are used, indefinite length is refused outright (it is
 * BER, not DER), and nothing recurses — callers walk the tree themselves, so a
 * document nested a thousand deep costs a thousand iterations rather than a
 * thousand stack frames.
 */

/** Bytes that are not valid DER, or not the DER that was expected. */
export class DerError extends Error {
  /**
   * @param message What was wrong, naming the offset where possible.
   */
  constructor(message: string) {
    super(message);
    this.name = 'DerError';
  }
}

/** One tag-length-value triple, located by offset inside the buffer it came from. */
export interface DerNode {
  /** The identifier octet, e.g. `0x30` for a SEQUENCE or `0xa0` for `[0]`. */
  tag: number;
  /** Offset of the identifier octet. */
  start: number;
  /** Offset of the first content byte. */
  contentStart: number;
  /** Offset one past the last content byte. */
  contentEnd: number;
  /** Offset one past the whole triple, i.e. where the next one begins. */
  end: number;
}

/** Universal tags this project names rather than spells. */
export const TAG = {
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  enumerated: 0x0a,
  sequence: 0x30,
} as const;

/**
 * Longest length-of-length this reader accepts.
 *
 * Four bytes is already a four-gibibyte structure, far past anything that could
 * arrive here; the point of the cap is that a length field is attacker-chosen
 * and a longer one would be assembled into a number before anyone checked it
 * against the buffer.
 */
const MAX_LENGTH_OCTETS = 4;

/**
 * Reads the triple that begins at an offset.
 *
 * @param bytes The buffer to read from.
 * @param offset Where the identifier octet is.
 * @returns The node, with every offset already bounded by the buffer.
 * @throws {DerError} When the buffer ends mid-header, when the length is
 *   indefinite or absurdly encoded, or when the content would run past the end
 *   of the buffer.
 */
export function readNode(bytes: Uint8Array, offset: number): DerNode {
  const tag = bytes[offset];
  if (tag === undefined) throw new DerError(`no value at offset ${String(offset)}`);

  const first = bytes[offset + 1];
  if (first === undefined) throw new DerError(`truncated length at offset ${String(offset)}`);

  let contentStart = offset + 2;
  let length = first;

  if ((first & 0x80) !== 0) {
    const octets = first & 0x7f;
    // 0x80 is BER's indefinite length, terminated by a sentinel rather than
    // counted. DER forbids it, and accepting it would mean scanning forward for
    // two zero bytes through content that may legitimately contain them.
    if (octets === 0) throw new DerError(`indefinite length at offset ${String(offset)}`);
    if (octets > MAX_LENGTH_OCTETS) {
      throw new DerError(`length of ${String(octets)} octets at offset ${String(offset)}`);
    }

    length = 0;
    for (let index = 0; index < octets; index += 1) {
      const octet = bytes[offset + 2 + index];
      if (octet === undefined) throw new DerError(`truncated length at offset ${String(offset)}`);
      length = length * 256 + octet;
    }
    contentStart = offset + 2 + octets;
  }

  const contentEnd = contentStart + length;
  if (contentEnd > bytes.length) {
    throw new DerError(
      `value at offset ${String(offset)} claims ${String(length)} bytes, ${String(bytes.length - contentStart)} remain`,
    );
  }

  return { tag, start: offset, contentStart, contentEnd, end: contentEnd };
}

/**
 * Reads the triples directly inside a constructed one.
 *
 * @param bytes The buffer the node came from.
 * @param node A constructed node, e.g. a SEQUENCE.
 * @returns Its immediate children, in order. Empty for an empty value.
 * @throws {DerError} When a child is malformed, or when the children do not
 *   exactly fill the parent — trailing bytes inside a SEQUENCE mean the
 *   structure is not what it claims to be.
 */
export function childrenOf(bytes: Uint8Array, node: DerNode): DerNode[] {
  const children: DerNode[] = [];
  let offset = node.contentStart;

  while (offset < node.contentEnd) {
    const child = readNode(bytes, offset);
    if (child.end > node.contentEnd) {
      throw new DerError(`child at offset ${String(offset)} runs past its parent`);
    }
    children.push(child);
    offset = child.end;
  }

  return children;
}

/**
 * @param bytes The buffer the node came from.
 * @param node The node to read.
 * @returns A view of the content, header excluded. Not a copy.
 * @throws Never.
 */
export function contentOf(bytes: Uint8Array, node: DerNode): Uint8Array {
  return bytes.subarray(node.contentStart, node.contentEnd);
}

/**
 * @param bytes The buffer the node came from.
 * @param node The node to read.
 * @returns A view of the whole triple, header included. Not a copy.
 * @throws Never.
 *
 * This is what a signature covers: a signature over `tbsResponseData` is over
 * its tag and length as well as its content, so verifying with
 * {@link contentOf} silently fails on every well-formed response.
 */
export function tripleOf(bytes: Uint8Array, node: DerNode): Uint8Array {
  return bytes.subarray(node.start, node.end);
}

/**
 * Reads an OBJECT IDENTIFIER into its dotted form.
 *
 * @param bytes The buffer the node came from.
 * @param node The OID node.
 * @returns The dotted decimal form, e.g. `1.3.6.1.5.5.7.48.1.1`.
 * @throws {DerError} When the node is not an OID, is empty, or ends mid-arc.
 */
export function readOid(bytes: Uint8Array, node: DerNode): string {
  if (node.tag !== TAG.oid) {
    throw new DerError(`expected an object identifier, found tag 0x${node.tag.toString(16)}`);
  }

  // Every sub-identifier is base 128 with the high bit as a continuation flag,
  // the first one included. That first one is not one octet: it holds
  // `40 * arc1 + arc2`, and for `2.100.3` that is 180, which needs two.
  const values: number[] = [];
  let value = 0;
  let pending = false;
  for (const octet of contentOf(bytes, node)) {
    value = value * 128 + (octet & 0x7f);
    pending = (octet & 0x80) !== 0;
    if (!pending) {
      values.push(value);
      value = 0;
    }
  }
  if (pending) throw new DerError('object identifier ends mid-arc');

  const first = values.shift();
  if (first === undefined) throw new DerError('empty object identifier');

  // arc1 is 0, 1 or 2, and only the first two ranges are 40 wide, so a combined
  // value of 80 or more means arc1 is 2 and division would give the wrong answer.
  const leading = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];

  return [...leading, ...values].join('.');
}

/**
 * Reads a GeneralizedTime as an ISO 8601 instant in UTC.
 *
 * Only the `YYYYMMDDHHMMSSZ` form is accepted, which is the only one DER
 * permits and the only one RFC 6960 allows in an OCSP response: no local time,
 * no offset, no fractional seconds. A responder that sends something else is
 * reporting a time this tool would have to guess at, and a guessed timestamp in
 * a client report is worse than an absent one.
 *
 * @param bytes The buffer the node came from.
 * @param node The GeneralizedTime node.
 * @returns The instant in ISO 8601, or `null` when the form is not the one
 *   above or the date does not exist.
 * @throws Never.
 */
export function readGeneralizedTime(bytes: Uint8Array, node: DerNode): string | null {
  const text = new TextDecoder('latin1').decode(contentOf(bytes, node));
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (match === null) return null;

  const [, year, month, day, hour, minute, second] = match;
  const stamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (Number.isNaN(stamp)) return null;

  // `Date.UTC` rolls a 32nd of January over into February rather than
  // rejecting it, so the result is compared back against what was asked for.
  const date = new Date(stamp);
  if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;

  return date.toISOString();
}

/**
 * Reads an INTEGER's content as unsigned hexadecimal.
 *
 * DER prefixes a leading zero octet whenever the high bit of the first content
 * byte is set, so the same serial number is `A4A3…` on a certificate and
 * `00A4A3…` in an OCSP response. The zero is stripped here, which is what makes
 * the two comparable.
 *
 * @param bytes The buffer the node came from.
 * @param node The INTEGER node.
 * @returns Uppercase hexadecimal with no sign padding, e.g. `A4A3B5`. `00` for
 *   an integer whose value is zero.
 * @throws Never.
 */
export function readUnsignedHex(bytes: Uint8Array, node: DerNode): string {
  let content = contentOf(bytes, node);
  let offset = 0;
  while (offset + 1 < content.length && content[offset] === 0) offset += 1;
  content = content.subarray(offset);

  let hex = '';
  for (const octet of content) hex += octet.toString(16).padStart(2, '0');
  return hex === '' ? '00' : hex.toUpperCase();
}

/**
 * Reads a BIT STRING's bits, dropping the unused-bits count.
 *
 * @param bytes The buffer the node came from.
 * @param node The BIT STRING node.
 * @returns A view of the bits themselves.
 * @throws {DerError} When the node is not a BIT STRING or carries no
 *   unused-bits octet.
 */
export function readBitString(bytes: Uint8Array, node: DerNode): Uint8Array {
  if (node.tag !== TAG.bitString) {
    throw new DerError(`expected a bit string, found tag 0x${node.tag.toString(16)}`);
  }
  if (node.contentEnd === node.contentStart) throw new DerError('empty bit string');
  return bytes.subarray(node.contentStart + 1, node.contentEnd);
}

/**
 * Encodes one triple.
 *
 * @param tag The identifier octet.
 * @param content The content, already encoded.
 * @returns The complete triple.
 * @throws Never.
 */
export function encode(tag: number, content: Uint8Array): Uint8Array {
  const header = encodeHeader(tag, content.length);
  const out = new Uint8Array(header.length + content.length);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
}

/**
 * Encodes a SEQUENCE around some already-encoded triples.
 *
 * @param parts The members, in order.
 * @returns The SEQUENCE.
 * @throws Never.
 */
export function encodeSequence(...parts: readonly Uint8Array[]): Uint8Array {
  return encode(TAG.sequence, concat(parts));
}

/**
 * @param parts Buffers to join.
 * @returns One buffer holding them end to end.
 * @throws Never.
 */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Encodes an identifier octet and a definite length.
 *
 * @param tag The identifier octet.
 * @param length Content length in bytes.
 * @returns The header.
 * @throws Never.
 */
function encodeHeader(tag: number, length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.from([tag, length]);

  const octets: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) octets.unshift(rest % 256);
  return Uint8Array.from([tag, 0x80 | octets.length, ...octets]);
}
