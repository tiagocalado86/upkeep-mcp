import { isIP } from 'node:net';
import { rejectPrivateAddress } from './address.js';
import { CheckError } from './errors.js';

/**
 * Refusing to contact anything that is not on the public internet.
 *
 * Switched on for a public deployment and off for a local one, because the two
 * cases have opposite defaults. Someone running this on their own machine may
 * legitimately point it at `192.168.1.10` — a staging box is exactly the thing
 * a maintenance tool should check. A public endpoint pointed at the same
 * address is reading somebody else's network, and pointed at
 * `169.254.169.254` it is reading the host's own credentials.
 *
 * @see `docs/adr/0012-public-target-guard.md`
 */

/** Checks a target before anything connects to it. */
export interface TargetGuard {
  /**
   * @throws {CheckError} `invalid_input` when the host is not public.
   */
  assertPublic(host: string): Promise<void>;
  /**
   * @param port The port the request would actually reach.
   * @param protocol The scheme it would use, which decides the port allowed.
   * @throws {CheckError} `invalid_input` when the port may not be contacted.
   */
  assertPort(port: number, protocol: WebProtocol): void;
}

/**
 * The ports a public deployment will open, one per scheme.
 *
 * Not a nicety: a public endpoint that connects to any port on any host is a
 * port scanner with someone else's name on it, and every hosting provider's
 * acceptable use policy forbids running one.
 *
 * Port 80 is here because `uptime_check` answers "does plain HTTP still work,
 * and does it upgrade?" — a question that cannot be asked over 443. Two web
 * ports is not a port scanner; it is the web.
 */
const PUBLIC_PORTS = { 'https:': 443, 'http:': 80 } as const;

/** The schemes a public deployment will contact. */
export type WebProtocol = keyof typeof PUBLIC_PORTS;

/**
 * A guard that allows everything.
 *
 * @returns A guard for a local server, where the operator's own authority over
 *   their own network is the right default.
 * @throws Never.
 */
export function allowAnyTarget(): TargetGuard {
  return {
    assertPublic: () => Promise.resolve(),
    assertPort: () => undefined,
  };
}

/**
 * A guard that allows only public unicast destinations, on the web ports.
 *
 * @param resolve How to find a hostname's addresses. Injected so the policy can
 *   be tested without a resolver, and so the caller decides the deadline.
 * @returns A guard for a publicly reachable server.
 * @throws Never.
 */
export function allowOnlyPublicTargets(
  resolve: (hostname: string) => Promise<string[]>,
): TargetGuard {
  return {
    assertPublic: async (host: string): Promise<void> => {
      const bare = host.replace(/^\[|\]$/g, '');

      // A literal address needs no lookup, and must not get one: resolving
      // `127.0.0.1` would fail rather than answer, and the failure would read
      // as an unreachable host instead of a refused one.
      if (isIP(bare) !== 0) {
        const reason = rejectPrivateAddress(bare);
        if (reason !== null) throw refusal(host, reason);
        return;
      }

      const addresses = await resolve(bare);
      if (addresses.length === 0) {
        throw new CheckError('not_found', `${host} does not resolve to any address`);
      }

      for (const address of addresses) {
        const reason = rejectPrivateAddress(address);
        // Every address, not just the first: a name that resolves to both a
        // public and a private address is the standard way around a check that
        // only looks at one.
        if (reason !== null) throw refusal(host, `${address} is ${reason}`);
      }
    },

    assertPort: (port: number, protocol: WebProtocol): void => {
      const allowed = PUBLIC_PORTS[protocol];
      if (port !== allowed) {
        throw new CheckError(
          'invalid_input',
          `this server only contacts port ${String(allowed)} over ${protocol.replace(':', '')}; a public instance that connects to arbitrary ports is a port scanner`,
        );
      }
    },
  };
}

/**
 * @param host The host that was asked for.
 * @param reason Why it was refused.
 * @returns The error to throw, worded so the caller knows it is a policy and
 *   not a failure.
 * @throws Never.
 */
function refusal(host: string, reason: string): CheckError {
  return new CheckError(
    'invalid_input',
    `this server only contacts the public internet, and ${host} is not on it (${reason})`,
  );
}
