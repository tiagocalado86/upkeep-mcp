import { randomInt } from 'node:crypto';
import { createConnection } from 'node:net';
import { categorise, CheckError } from './errors.js';

/**
 * Speaking DNS to one nameserver, over TCP.
 *
 * `node:dns`'s `Resolver` cannot do this. It sends UDP, which does not leave
 * every platform this server is deployed to — `docs/deploying.md` has the Cloud
 * Run case — and it exposes no `AA` bit, so there is no way to tell an answer a
 * server is authoritative for from one it merely repeated. Both of those are
 * exactly what "do this domain's own nameservers agree about it?" needs.
 *
 * So the message is built and read here. It is a small closed grammar: a header,
 * a question, and resource records whose names may be compressed. About the same
 * shape of decision as `der.ts` and taken for the same reason — this parses bytes
 * a stranger's server chose, and a dependency there is a dependency in the worst
 * possible place.
 *
 * @see https://www.rfc-editor.org/rfc/rfc1035 sections 4.1 and 4.2.2
 */

/** SOA is record type 6. */
export const RRTYPE_SOA = 6;

/** NS is record type 2. */
export const RRTYPE_NS = 2;

/** The internet class, which is the only one anything here asks about. */
const CLASS_IN = 1;

/** The DNS port. Fixed: nothing here takes a port from a caller. */
export const DNS_PORT = 53;

/**
 * A TCP DNS message may be 65535 bytes, and that is the whole of the bound.
 *
 * A server that keeps sending is cut off rather than allowed to fill memory.
 */
const MAX_MESSAGE_BYTES = 65_535;

/** How many compression pointers one name may follow before it is refused. */
const MAX_POINTER_JUMPS = 16;

/** Response codes worth naming, from the IANA registry. */
const RCODE_NAMES: Record<number, string> = {
  0: 'NOERROR',
  1: 'FORMERR',
  2: 'SERVFAIL',
  3: 'NXDOMAIN',
  4: 'NOTIMP',
  5: 'REFUSED',
};

/** One resource record, with its data left as bytes. */
export interface ResourceRecord {
  /** The owner name, lowercased and without a trailing dot. */
  name: string;
  /** The record type, as a number. */
  type: number;
  /** Seconds this record may be cached for. */
  ttl: number;
  /** The record's data, undecoded. Names inside it may be compressed. */
  data: Uint8Array;
  /** Where in the message the data began, which name decompression needs. */
  dataOffset: number;
}

/** A response, read far enough to answer what this project asks. */
export interface DnsMessage {
  /** Whether the server claims authority for the name it answered about. */
  authoritative: boolean;
  /** The response code. */
  rcode: number;
  /** The response code's name, or its number when it has none. */
  rcodeName: string;
  /** Records answering the question. */
  answers: ResourceRecord[];
  /** Records in the authority section, which carry a referral's nameservers. */
  authority: ResourceRecord[];
  /** The whole message, which decompressing a name inside a record needs. */
  bytes: Uint8Array;
}

/**
 * Asks one nameserver one question, over TCP.
 *
 * TCP rather than UDP for two reasons that happen to point the same way. UDP to
 * arbitrary hosts does not leave Cloud Run, which is where this server is
 * deployed; and a TCP answer is never truncated into a second round trip.
 *
 * Recursion is not requested. The point is what *this* server holds, so an
 * answer it had to go and fetch would be the wrong answer to the question.
 *
 * @param address The nameserver's IP address. An address, never a name: the
 *   caller resolves and guards the name first, and passing one here would mean
 *   a lookup this function cannot see or bound.
 * @param name The domain to ask about.
 * @param type The record type to ask for.
 * @param timeoutMs Whole-operation deadline, connection included.
 * @returns What the server answered.
 * @throws {CheckError} `timeout` when the deadline passes, `network` when the
 *   connection is refused or dropped, `unexpected` when the answer cannot be
 *   read as a DNS message.
 */
export async function queryOverTcp(
  address: string,
  name: string,
  type: number,
  timeoutMs: number,
): Promise<DnsMessage> {
  const id = randomInt(0, 65_536);
  const response = await exchange(address, framed(buildQuery(id, name, type)), timeoutMs);
  const message = readDnsMessage(response);

  // An answer to somebody else's question is not an answer. Over TCP this is
  // cheap to check and there is no reason not to.
  if (readUint16(response, 0) !== id) {
    throw new CheckError('unexpected', 'it answered with a different query id');
  }

  return message;
}

/**
 * Reads the serial from an SOA record.
 *
 * The serial is what makes two nameservers comparable: it is the version number
 * of the zone, and two servers reporting different ones are serving different
 * data whatever else they agree on.
 *
 * @param record An SOA record, with the message it came from for decompression.
 * @param message The whole message, because MNAME and RNAME may be compressed
 *   pointers into it and the five numbers sit after them.
 * @returns The serial, or `null` when the record is too short to hold one.
 * @throws Never.
 */
export function readSoaSerial(record: ResourceRecord, message: Uint8Array): number | null {
  try {
    // MNAME and RNAME come first and are variable-length, so the numbers can
    // only be found by walking past them.
    const afterMname = skipName(message, record.dataOffset);
    const afterRname = skipName(message, afterMname);
    if (afterRname + 4 > message.length) return null;
    return readUint32(message, afterRname);
  } catch {
    return null;
  }
}

/**
 * Reads a name out of a record's data, following compression pointers.
 *
 * @param record An NS record, or any whose data is a single name.
 * @param message The whole message, which a pointer may point anywhere into.
 * @returns The name, lowercased and without a trailing dot, or `null` when it
 *   cannot be read.
 * @throws Never.
 */
export function readNameRecord(record: ResourceRecord, message: Uint8Array): string | null {
  try {
    return readName(message, record.dataOffset).name;
  } catch {
    return null;
  }
}

/**
 * Builds a query message.
 *
 * Exported for its own test. A question encoded wrongly is answered with
 * `FORMERR` by every server at once, which looks exactly like a domain whose
 * every nameserver is broken.
 *
 * @param id The query id, echoed by the server.
 * @param name The domain to ask about.
 * @param type The record type.
 * @returns The message, without the TCP length prefix.
 * @throws {CheckError} `invalid_input` when a label is longer than DNS allows.
 */
export function buildQuery(id: number, name: string, type: number): Uint8Array {
  const labels = name.replace(/\.$/, '').split('.');
  const encoded: number[] = [];

  for (const label of labels) {
    const bytes = new TextEncoder().encode(label);
    if (bytes.length > 63) {
      throw new CheckError('invalid_input', `"${label}" is longer than a DNS label may be`);
    }
    encoded.push(bytes.length, ...bytes);
  }
  encoded.push(0);

  const message = new Uint8Array(12 + encoded.length + 4);
  const view = new DataView(message.buffer);

  view.setUint16(0, id);
  // Flags all zero: a standard query, and RD off. Asking a server to recurse
  // would let it answer from a cache filled by one of its siblings, which is
  // the disagreement this exists to find.
  view.setUint16(2, 0);
  view.setUint16(4, 1);
  message.set(encoded, 12);
  view.setUint16(12 + encoded.length, type);
  view.setUint16(14 + encoded.length, CLASS_IN);

  return message;
}

/**
 * @param message A DNS message.
 * @returns It, with the two-byte length prefix TCP requires.
 * @throws Never.
 */
function framed(message: Uint8Array): Uint8Array {
  const framedMessage = new Uint8Array(message.length + 2);
  new DataView(framedMessage.buffer).setUint16(0, message.length);
  framedMessage.set(message, 2);
  return framedMessage;
}

/**
 * Sends one message and reads one answer.
 *
 * @param address The nameserver's IP address.
 * @param request The framed query.
 * @param timeoutMs Whole-operation deadline.
 * @returns The answer, with its length prefix removed.
 * @throws {CheckError} `timeout` past the deadline, `network` when the
 *   connection is refused or the server closes before a whole message arrives.
 */
function exchange(address: string, request: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let received = 0;
    let settled = false;

    const socket = createConnection({ host: address, port: DNS_PORT }, () => {
      socket.write(request);
    });

    // An explicit timer that destroys the socket, not `socket.setTimeout`: that
    // one emits an event and leaves the connection open, which is how a check
    // with a deadline comes to hold a socket open past it.
    const timer = setTimeout(() => {
      settle(() => {
        reject(
          new CheckError('timeout', `${address} did not answer within ${String(timeoutMs)}ms`),
        );
      });
    }, timeoutMs);

    /**
     * Finishes the exchange exactly once.
     *
     * Every path here ends in `close`, which would otherwise reject an exchange
     * that had already resolved a moment earlier.
     */
    function settle(finish: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      finish();
    }

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;

      if (received > MAX_MESSAGE_BYTES + 2) {
        settle(() => {
          reject(new CheckError('unexpected', 'it sent more than a DNS message may hold'));
        });
        return;
      }

      if (received < 2) return;
      const whole = concat(chunks, received);
      const expected = readUint16(whole, 0);
      if (received < expected + 2) return;

      settle(() => {
        resolve(whole.subarray(2, expected + 2));
      });
    });

    socket.on('error', (cause: Error) => {
      settle(() => {
        reject(
          new CheckError(
            // `network` for a refused connection, which is what a nameserver
            // that serves UDP only does, and which the caller has to be able to
            // tell apart from an answer.
            categorise((cause as NodeJS.ErrnoException).code),
            describeSocketError(cause),
          ),
        );
      });
    });

    socket.on('close', () => {
      settle(() => {
        reject(new CheckError('network', 'it closed the connection before answering'));
      });
    });
  });
}

/**
 * Names a connection failure without repeating who it was to.
 *
 * The caller knows which server it asked, and identical reasons then read as
 * identical strings — which is what lets a report say "these four refused"
 * once instead of four times with four addresses in it.
 *
 * @param cause The socket error.
 * @returns The reason, as a clause about the server.
 * @throws Never.
 */
function describeSocketError(cause: Error): string {
  switch ((cause as NodeJS.ErrnoException).code) {
    case 'ECONNREFUSED':
      // Common and not a fault: plenty of nameservers answer UDP and refuse TCP,
      // which RFC 7766 forbids and no resolver notices.
      return 'it refused a connection on TCP port 53';
    case 'ETIMEDOUT':
      return 'the connection to it on TCP port 53 timed out';
    case 'ECONNRESET':
      return 'it reset the connection on TCP port 53';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'there is no route to it';
    default:
      return `it could not be reached on TCP port 53: ${cause.message}`;
  }
}

/**
 * @param chunks Everything read so far.
 * @param length Their total length.
 * @returns One contiguous view of them.
 * @throws Never.
 */
function concat(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array(0);

  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/**
 * Reads a response far enough to answer what this project asks of it.
 *
 * Exported for its own test: everything this module concludes rests on reading
 * these bytes correctly, and a socket is not needed to check that.
 *
 * The additional section is skipped rather than parsed: nothing here asks a
 * question whose answer lives in it, and parsing bytes nobody reads is how a
 * parser acquires a bug that only a hostile server can reach.
 *
 * @param bytes One DNS message.
 * @returns The header flags and the answer and authority sections.
 * @throws {CheckError} `unexpected` when the message is malformed.
 */
export function readDnsMessage(bytes: Uint8Array): DnsMessage {
  if (bytes.length < 12) throw new CheckError('unexpected', 'the DNS answer is too short to read');

  const flags = readUint16(bytes, 2);
  const rcode = flags & 0x0f;
  const counts = {
    questions: readUint16(bytes, 4),
    answers: readUint16(bytes, 6),
    authority: readUint16(bytes, 8),
  };

  let offset = 12;
  for (let index = 0; index < counts.questions; index += 1) {
    offset = skipName(bytes, offset) + 4;
  }

  const answers: ResourceRecord[] = [];
  for (let index = 0; index < counts.answers; index += 1) {
    const record = readRecord(bytes, offset);
    answers.push(record.record);
    offset = record.next;
  }

  const authority: ResourceRecord[] = [];
  for (let index = 0; index < counts.authority; index += 1) {
    const record = readRecord(bytes, offset);
    authority.push(record.record);
    offset = record.next;
  }

  return {
    // Bit 5 of the flags word: the server is authoritative for the name it
    // answered about. This is the whole reason for speaking DNS by hand.
    authoritative: (flags & 0x0400) !== 0,
    rcode,
    rcodeName: RCODE_NAMES[rcode] ?? `rcode ${String(rcode)}`,
    answers,
    authority,
    bytes,
  };
}

/**
 * @param bytes The whole message.
 * @param offset Where the record starts.
 * @returns The record, and where the next one starts.
 * @throws {CheckError} `unexpected` when the record runs past the message.
 */
function readRecord(bytes: Uint8Array, offset: number): { record: ResourceRecord; next: number } {
  const name = readName(bytes, offset);
  const header = name.next;

  if (header + 10 > bytes.length) {
    throw new CheckError('unexpected', 'a record in the DNS answer runs past the end of it');
  }

  const dataLength = readUint16(bytes, header + 8);
  const dataOffset = header + 10;

  if (dataOffset + dataLength > bytes.length) {
    throw new CheckError('unexpected', 'a record in the DNS answer claims more data than it has');
  }

  return {
    record: {
      name: name.name,
      type: readUint16(bytes, header),
      ttl: readUint32(bytes, header + 4),
      data: bytes.subarray(dataOffset, dataOffset + dataLength),
      dataOffset,
    },
    next: dataOffset + dataLength,
  };
}

/**
 * Reads a name, following compression pointers.
 *
 * @param bytes The whole message.
 * @param offset Where the name starts.
 * @returns The name, lowercased and without a trailing dot, and the offset just
 *   past it — which for a compressed name is past the pointer, not past what it
 *   points at.
 * @throws {CheckError} `unexpected` on a name that runs past the message or
 *   whose pointers do not terminate.
 */
function readName(bytes: Uint8Array, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let cursor = offset;
  let next: number | null = null;
  let jumps = 0;

  for (;;) {
    if (cursor >= bytes.length) {
      throw new CheckError('unexpected', 'a name in the DNS answer runs past the end of it');
    }

    const length = bytes[cursor] ?? 0;

    if (length === 0) {
      return { name: labels.join('.').toLowerCase(), next: next ?? cursor + 1 };
    }

    // The top two bits set mark a pointer to somewhere earlier in the message.
    if ((length & 0xc0) === 0xc0) {
      jumps += 1;
      // A pointer chain that does not shrink is a loop, and a message built to
      // contain one is the classic way to hang a resolver.
      if (jumps > MAX_POINTER_JUMPS) {
        throw new CheckError('unexpected', 'a name in the DNS answer points at itself');
      }
      const target = readUint16(bytes, cursor) & 0x3fff;
      next ??= cursor + 2;
      if (target >= cursor) {
        throw new CheckError('unexpected', 'a name in the DNS answer points forwards');
      }
      cursor = target;
      continue;
    }

    if (cursor + 1 + length > bytes.length) {
      throw new CheckError('unexpected', 'a label in the DNS answer runs past the end of it');
    }

    labels.push(new TextDecoder().decode(bytes.subarray(cursor + 1, cursor + 1 + length)));
    cursor += 1 + length;
  }
}

/**
 * @param bytes The whole message.
 * @param offset Where the name starts.
 * @returns The offset just past it.
 * @throws {CheckError} `unexpected` on a malformed name.
 */
function skipName(bytes: Uint8Array, offset: number): number {
  return readName(bytes, offset).next;
}

/**
 * @param bytes Any buffer.
 * @param offset Where to read.
 * @returns The unsigned 16-bit big-endian value there.
 * @throws {CheckError} `unexpected` when it would read past the end.
 */
function readUint16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) {
    throw new CheckError('unexpected', 'the DNS answer ends mid-number');
  }
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

/**
 * @param bytes Any buffer.
 * @param offset Where to read.
 * @returns The unsigned 32-bit big-endian value there.
 * @throws {CheckError} `unexpected` when it would read past the end.
 */
function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) {
    throw new CheckError('unexpected', 'the DNS answer ends mid-number');
  }
  // `>>> 0` because a serial with the top bit set is a positive number, and the
  // shift operators produce a signed one.
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}
