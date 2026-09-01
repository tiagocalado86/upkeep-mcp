import { isIP } from 'node:net';

/**
 * Deciding whether an address belongs to the public internet.
 *
 * A tool that fetches whatever URL it is handed is doing its job when the
 * person holding the keyboard asked for it. Exposed publicly it is something
 * else: an endpoint that will read `http://169.254.169.254/latest/meta-data/`
 * on a stranger's behalf, or map the ports of whatever network it runs in,
 * wearing this project's own `User-Agent`.
 *
 * The rule is therefore a property of the entrypoint rather than of the checks:
 * a local server keeps the operator's own authority over their own machine, and
 * a public one is restricted to targets that are, by definition, already public.
 *
 * @see https://www.rfc-editor.org/rfc/rfc5735 (IPv4 special-purpose addresses)
 * @see https://www.rfc-editor.org/rfc/rfc4193 (IPv6 unique local addresses)
 */

/** One IPv4 range that is not public unicast, as an address and a prefix length. */
interface Range {
  /** The network address, as four octets. */
  network: [number, number, number, number];
  /** How many leading bits are fixed. */
  bits: number;
  /** Why it is excluded, for the error a caller shows. */
  reason: string;
}

/**
 * IPv4 ranges that are not public unicast.
 *
 * Chosen for what they let an attacker reach rather than for completeness:
 * loopback and the private ranges are the internal network, and link-local is
 * where every cloud provider parks its instance metadata service.
 */
const IPV4_RANGES: Range[] = [
  { network: [0, 0, 0, 0], bits: 8, reason: 'the unspecified range' },
  { network: [10, 0, 0, 0], bits: 8, reason: 'a private network' },
  { network: [100, 64, 0, 0], bits: 10, reason: 'carrier-grade NAT space' },
  { network: [127, 0, 0, 0], bits: 8, reason: 'loopback' },
  { network: [169, 254, 0, 0], bits: 16, reason: 'link-local, where cloud metadata lives' },
  { network: [172, 16, 0, 0], bits: 12, reason: 'a private network' },
  { network: [192, 0, 0, 0], bits: 24, reason: 'IETF protocol assignments' },
  { network: [192, 168, 0, 0], bits: 16, reason: 'a private network' },
  { network: [198, 18, 0, 0], bits: 15, reason: 'benchmarking space' },
  { network: [224, 0, 0, 0], bits: 4, reason: 'multicast' },
  // 240.0.0.0/4 also covers 255.255.255.255, so the broadcast address needs no
  // rule of its own.
  { network: [240, 0, 0, 0], bits: 4, reason: 'reserved space' },
];

/** Why an address was rejected, or `null` when it is ordinary public space. */
export type AddressVerdict = string | null;

/**
 * Judges one IP address.
 *
 * @param address An IPv4 or IPv6 address, without brackets or a port.
 * @returns `null` when the address is public unicast, otherwise why it is not.
 *   An address that cannot be parsed is rejected: something unrecognised is not
 *   something to connect to.
 * @throws Never.
 */
export function rejectPrivateAddress(address: string): AddressVerdict {
  const family = isIP(address);
  if (family === 4) return rejectIpv4(address);
  if (family === 6) return rejectIpv6(address);
  return 'it is not a recognisable IP address';
}

/**
 * @param address A dotted-quad IPv4 address.
 * @returns Why it is not public, or `null`.
 * @throws Never.
 */
function rejectIpv4(address: string): AddressVerdict {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return 'it is not a recognisable IP address';
  }

  const value = octets.reduce((total, octet) => total * 256 + octet, 0);

  for (const range of IPV4_RANGES) {
    const base = range.network.reduce((total, octet) => total * 256 + octet, 0);
    // A prefix of n bits fixes the top n bits; shifting both sides down by the
    // remainder compares exactly those.
    const shift = 32 - range.bits;
    if (Math.floor(value / 2 ** shift) === Math.floor(base / 2 ** shift)) return range.reason;
  }

  return null;
}

/**
 * @param address An IPv6 address.
 * @returns Why it is not public, or `null`.
 * @throws Never.
 */
function rejectIpv6(address: string): AddressVerdict {
  const plain = address.toLowerCase().split('%')[0] ?? '';

  if (plain === '::1') return 'loopback';
  if (plain === '::') return 'the unspecified address';

  // An IPv4-mapped address reaches an IPv4 destination, so it is judged as one.
  // `::ffff:127.0.0.1` is loopback however it is spelled.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(plain);
  if (mapped?.[1] !== undefined) return rejectIpv4(mapped[1]);

  const head = plain.split(':')[0] ?? '';
  const leading = Number.parseInt(head.padStart(4, '0').slice(0, 4), 16);
  if (Number.isNaN(leading)) return 'it is not a recognisable IP address';

  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast.
  if ((leading & 0xfe00) === 0xfc00) return 'a unique local address';
  if ((leading & 0xffc0) === 0xfe80) return 'link-local';
  if ((leading & 0xff00) === 0xff00) return 'multicast';

  return null;
}
