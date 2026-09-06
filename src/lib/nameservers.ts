import { LIMITS, TIMEOUTS } from './defaults.js';
import { readSoaSerial, RRTYPE_SOA, type DnsMessage } from './dns-wire.js';
import type { NameserverAnswer, NameserverCheck } from '../types.js';

/**
 * Asking a zone's own nameservers about the zone.
 *
 * Everything else in this project asks a recursive resolver, which answers with
 * whatever one nameserver told it and hides which one that was. Two questions a
 * maintenance report needs cannot be answered that way. Whether every server
 * listed for the domain actually serves it — a nameserver left in the
 * delegation after a migration answers `REFUSED`, and resolvers keep trying it
 * for as long as it is listed. And whether the servers agree: a zone edited on
 * one server and never transferred to the others resolves correctly for some
 * visitors and not for others, intermittently, which is the hardest kind of
 * outage to be told about by a client.
 *
 * The answer to both is the SOA serial, asked of each server directly, with
 * recursion off so that what comes back is what that server holds.
 */

/** How each nameserver is asked. Injected so the analysis can be tested offline. */
export interface NameserverProbe {
  /**
   * @param host A nameserver's hostname.
   * @returns Its addresses, already guarded. Empty when the name resolves to
   *   nothing.
   */
  resolveAddresses(host: string): Promise<string[]>;
  /**
   * @param address One of those addresses.
   * @param name The zone to ask about.
   * @param type The record type.
   * @param timeoutMs Deadline for this one exchange.
   * @returns What that server answered.
   */
  query(address: string, name: string, type: number, timeoutMs: number): Promise<DnsMessage>;
}

/**
 * Asks every nameserver the zone publishes what it holds for the zone.
 *
 * Each server is asked in parallel: they are different hosts, so the per-host
 * limiter is not the bound, and a zone with four nameservers must not cost four
 * deadlines in a row. Nothing here can fail the check — a server that will not
 * answer is the finding.
 *
 * @param zone The zone to ask about, which is the registrable domain.
 * @param nameservers The zone's NS set, as a recursive resolver reported it.
 * @param probe How to resolve and ask. The caller applies the target guard and
 *   the rate limiter, because those are deployment policy and this is not.
 * @returns What each nameserver said, and whether they agree.
 * @throws Never.
 */
export async function askNameservers(
  zone: string,
  nameservers: readonly string[],
  probe: NameserverProbe,
): Promise<NameserverCheck> {
  if (nameservers.length === 0) {
    return {
      checked: false,
      unavailableReason: 'the domain publishes no NS records, so there was nothing to ask',
      answers: [],
      serials: [],
      agree: true,
    };
  }

  // A zone may publish more nameservers than anyone needs to ask. The bound is
  // on the work, not on the answer: which ones were left out is reported.
  const asked = [...nameservers].slice(0, LIMITS.maxNameserversQueried);
  const answers = await Promise.all(asked.map((host) => ask(zone, host, probe)));

  const serials = [
    ...new Set(
      answers.map((answer) => answer.serial).filter((serial): serial is number => serial !== null),
    ),
  ].sort((left, right) => left - right);

  return {
    checked: true,
    unavailableReason:
      asked.length < nameservers.length
        ? `only the first ${String(asked.length)} of ${String(nameservers.length)} nameservers were asked`
        : null,
    answers,
    serials,
    // Two servers holding different versions of the zone is the finding. One
    // serial, or none at all to compare, is not a disagreement.
    agree: serials.length <= 1,
  };
}

/**
 * Asks one nameserver.
 *
 * @param zone The zone to ask about.
 * @param host The nameserver's hostname.
 * @param probe How to resolve and ask.
 * @returns What came of asking it.
 * @throws Never.
 */
async function ask(zone: string, host: string, probe: NameserverProbe): Promise<NameserverAnswer> {
  let address: string | null = null;

  try {
    const addresses = await probe.resolveAddresses(host);
    address = addresses[0] ?? null;

    if (address === null) {
      // A nameserver whose own name does not resolve is the commonest lame
      // delegation there is: the server was decommissioned and the NS record
      // was left behind. No resolver can use it either, so this one is a fault
      // of the delegation rather than a limit of this check.
      return {
        host,
        address: null,
        outcome: 'unresolvable',
        serial: null,
        problem: 'its hostname does not resolve to any address',
      };
    }

    const message = await probe.query(address, zone, RRTYPE_SOA, TIMEOUTS.nameserverMs);

    if (message.rcode !== 0) {
      return lame(host, address, `it answered ${message.rcodeName} for the zone`);
    }

    const soa = message.answers.find((record) => record.type === RRTYPE_SOA);

    if (soa === undefined) {
      return lame(host, address, 'it answered without an SOA record for the zone');
    }

    if (!message.authoritative) {
      return lame(
        host,
        address,
        'it answered without claiming authority for the zone, so it is not serving it',
      );
    }

    return {
      host,
      address,
      outcome: 'authoritative',
      serial: readSoaSerial(soa, message.bytes),
      problem: null,
    };
  } catch (cause) {
    // Everything that goes wrong on the wire lands here, and none of it is a
    // fault of the domain: a refused connection means this nameserver serves
    // UDP only, a timeout may as easily be this end's network as theirs.
    return {
      host,
      address,
      outcome: 'unreachable',
      serial: null,
      problem: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * @param host The nameserver's hostname.
 * @param address The address that answered.
 * @param problem What was wrong with the answer, in plain words.
 * @returns An answer recording a delegation that names a server not serving the
 *   zone.
 * @throws Never.
 */
function lame(host: string, address: string, problem: string): NameserverAnswer {
  return { host, address, outcome: 'lame', serial: null, problem };
}
