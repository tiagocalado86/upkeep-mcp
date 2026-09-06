import { describe, expect, it } from 'vitest';
import { CheckError } from '../../src/lib/errors.js';
import {
  buildQuery,
  readDnsMessage,
  readNameRecord,
  readSoaSerial,
  RRTYPE_NS,
  RRTYPE_SOA,
} from '../../src/lib/dns-wire.js';

/**
 * A DNS message assembled byte by byte.
 *
 * Fixtures rather than a live server: every conclusion this module reaches
 * rests on reading these bytes, and the interesting cases — a compression
 * pointer that loops, a record claiming more data than it has — are ones no
 * real server sends and only a hostile one would.
 */
function message(options: {
  id?: number;
  flags?: number;
  questions?: number;
  answers?: Uint8Array[];
  authority?: Uint8Array[];
}): Uint8Array {
  const answers = options.answers ?? [];
  const authority = options.authority ?? [];
  const question = options.questions === 0 ? new Uint8Array(0) : encodeQuestion('example.com');
  const body = [...answers, ...authority];
  const length = 12 + question.length + body.reduce((total, part) => total + part.length, 0);

  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, options.id ?? 0x1234);
  view.setUint16(2, options.flags ?? 0x8400);
  view.setUint16(4, options.questions ?? 1);
  view.setUint16(6, answers.length);
  view.setUint16(8, authority.length);

  let offset = 12;
  bytes.set(question, offset);
  offset += question.length;
  for (const part of body) {
    bytes.set(part, offset);
    offset += part.length;
  }

  return bytes;
}

/**
 * @param name A domain name.
 * @returns Its question section: the encoded name, then type SOA and class IN.
 */
function encodeQuestion(name: string): Uint8Array {
  return concat([encodeName(name), Uint8Array.from([0, RRTYPE_SOA, 0, 1])]);
}

/**
 * @param name A domain name.
 * @returns It in DNS label form, root label included.
 */
function encodeName(name: string): Uint8Array {
  const bytes: number[] = [];
  for (const label of name.split('.')) {
    bytes.push(label.length, ...new TextEncoder().encode(label));
  }
  bytes.push(0);
  return Uint8Array.from(bytes);
}

/**
 * @param name The owner name.
 * @param type The record type.
 * @param data The record's data.
 * @returns One resource record.
 */
function record(name: Uint8Array, type: number, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(10);
  const view = new DataView(header.buffer);
  view.setUint16(0, type);
  view.setUint16(2, 1);
  view.setUint32(4, 300);
  view.setUint16(8, data.length);
  return concat([name, header, data]);
}

/**
 * @param serial The zone serial to encode.
 * @returns SOA record data: two names and the five numbers after them.
 */
function soaData(serial: number): Uint8Array {
  const numbers = new Uint8Array(20);
  new DataView(numbers.buffer).setUint32(0, serial);
  return concat([encodeName('ns1.example.com'), encodeName('hostmaster.example.com'), numbers]);
}

/**
 * @param parts Any buffers.
 * @returns Them, end to end.
 */
function concat(parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

describe('buildQuery', () => {
  it('asks the question it was given, without recursion', () => {
    const query = buildQuery(0xabcd, 'example.com', RRTYPE_SOA);
    const view = new DataView(query.buffer);

    expect(view.getUint16(0)).toBe(0xabcd);
    // Every flag off. RD in particular: a server allowed to recurse can answer
    // from a cache one of its siblings filled, which is the disagreement this
    // whole check exists to find.
    expect(view.getUint16(2)).toBe(0);
    expect(view.getUint16(4)).toBe(1);
    expect([...query.subarray(12, 25)]).toEqual([
      7, 101, 120, 97, 109, 112, 108, 101, 3, 99, 111, 109, 0,
    ]);
    expect(view.getUint16(25)).toBe(RRTYPE_SOA);
    expect(view.getUint16(27)).toBe(1);
  });

  it('drops a trailing dot rather than encoding an empty label', () => {
    expect([...buildQuery(1, 'example.com.', RRTYPE_SOA)]).toEqual([
      ...buildQuery(1, 'example.com', RRTYPE_SOA),
    ]);
  });

  it('refuses a label longer than DNS allows', () => {
    expect(() => buildQuery(1, `${'a'.repeat(64)}.com`, RRTYPE_SOA)).toThrow(CheckError);
  });
});

describe('readDnsMessage', () => {
  it('reads the authority bit, which is the reason this module exists', () => {
    // `node:dns` does not expose it, so there is no way through the platform
    // resolver to tell a server that serves the zone from one repeating it.
    expect(readDnsMessage(message({ flags: 0x8400 })).authoritative).toBe(true);
    expect(readDnsMessage(message({ flags: 0x8000 })).authoritative).toBe(false);
  });

  it('names the response code', () => {
    expect(readDnsMessage(message({ flags: 0x8405 })).rcodeName).toBe('REFUSED');
    expect(readDnsMessage(message({ flags: 0x8402 })).rcodeName).toBe('SERVFAIL');
    expect(readDnsMessage(message({ flags: 0x840b })).rcodeName).toBe('rcode 11');
  });

  it('reads a serial out of an SOA answer', () => {
    const answer = readDnsMessage(
      message({ answers: [record(encodeName('example.com'), RRTYPE_SOA, soaData(2026090701))] }),
    );
    const soa = answer.answers[0];

    expect(soa?.type).toBe(RRTYPE_SOA);
    expect(soa && readSoaSerial(soa, answer.bytes)).toBe(2026090701);
  });

  it('reads a serial with the top bit set as a positive number', () => {
    // Serials are unsigned 32-bit and the date-based ones are not near this,
    // but a counter that has been incrementing since 2003 can be — and a signed
    // shift would report it as negative.
    const answer = readDnsMessage(
      message({ answers: [record(encodeName('example.com'), RRTYPE_SOA, soaData(0xf0000001))] }),
    );

    expect(answer.answers[0] && readSoaSerial(answer.answers[0], answer.bytes)).toBe(4026531841);
  });

  it('follows a compression pointer', () => {
    // The owner name of an answer is nearly always a pointer back to the
    // question, so a reader that cannot follow one reads almost nothing.
    const pointer = Uint8Array.from([0xc0, 0x0c]);
    const answer = readDnsMessage(message({ answers: [record(pointer, RRTYPE_SOA, soaData(7))] }));

    expect(answer.answers[0]?.name).toBe('example.com');
  });

  it('reads a name record, pointer and all', () => {
    const answer = readDnsMessage(
      message({
        answers: [record(Uint8Array.from([0xc0, 0x0c]), RRTYPE_NS, encodeName('ns1.example.com'))],
      }),
    );

    expect(answer.answers[0] && readNameRecord(answer.answers[0], answer.bytes)).toBe(
      'ns1.example.com',
    );
  });

  it('refuses a pointer that goes forwards, which is how a loop is built', () => {
    const forwards = Uint8Array.from([0xc0, 0xff]);

    expect(() =>
      readDnsMessage(message({ answers: [record(forwards, RRTYPE_SOA, soaData(1))] })),
    ).toThrow(/points forwards/);
  });

  it('refuses a record claiming more data than the message holds', () => {
    const bytes = message({ answers: [record(encodeName('example.com'), RRTYPE_SOA, soaData(1))] });
    // The record's own length field, made larger than what follows it: twelve
    // bytes of header, then a question of a thirteen-byte name and four bytes
    // of type and class, then the record's own thirteen-byte name, then eight
    // bytes of type, class and TTL.
    new DataView(bytes.buffer).setUint16(12 + 17 + 13 + 8, 4096);

    expect(() => readDnsMessage(bytes)).toThrow(/more data than it has/);
  });

  it('refuses a message too short to be one', () => {
    expect(() => readDnsMessage(Uint8Array.from([0, 1, 2]))).toThrow(/too short/);
  });

  it('skips the question section, however many questions there are', () => {
    const answer = readDnsMessage(
      message({ questions: 1, answers: [record(encodeName('a.test'), RRTYPE_SOA, soaData(5))] }),
    );

    expect(answer.answers[0]?.name).toBe('a.test');
  });

  it('reads the authority section, where a referral puts its nameservers', () => {
    const answer = readDnsMessage(
      message({
        flags: 0x8000,
        authority: [record(encodeName('example.com'), RRTYPE_NS, encodeName('ns1.example.com'))],
      }),
    );

    expect(answer.answers).toHaveLength(0);
    expect(answer.authority[0]?.type).toBe(RRTYPE_NS);
  });
});
