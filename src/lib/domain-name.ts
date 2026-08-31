import { isIP } from 'node:net';
import { domainToASCII, domainToUnicode } from 'node:url';
import { getDomain } from 'tldts';

/** A hostname accepted and normalised for use in DNS, TLS and RDAP queries. */
export interface ParsedTarget {
  ok: true;
  /**
   * The hostname in A-label (punycode) form, lowercased and without a trailing
   * dot. This is the only form that should be used downstream.
   */
  ascii: string;
  /** The Unicode form, when the input was an internationalised name; otherwise `null`. */
  unicode: string | null;
  /**
   * The registrable domain — what registration is actually a property of, so
   * `www.example.co.uk` reduces to `example.co.uk`. `null` when the input is an
   * IP address or a bare public suffix.
   */
  registrable: string | null;
  /** Whether the input was an IP literal rather than a name. */
  isIp: boolean;
}

/** Why an input could not be used as a hostname. */
export interface ParseFailure {
  ok: false;
  /** Actionable explanation, suitable for a tool error message. */
  reason: string;
}

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/;

/**
 * Normalises whatever the caller passed into a hostname usable everywhere.
 *
 * Accepts a bare hostname or a full URL, because the portfolio file stores URLs
 * and a model will pass one to a tool that documents a domain.
 *
 * Internationalised names are converted to A-labels **here and only here**.
 * `node:dns` accepts Unicode and converts on its own, but `tls.connect`'s
 * `servername` does not — passing `bücher.de` there fails the handshake with
 * `ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE` while `xn--bcher-kva.de` connects. A
 * domain that resolves and then mysteriously fails TLS is exactly the bug this
 * prevents.
 *
 * @param input A hostname (`example.com`) or a URL (`https://example.com/path`).
 * @returns The normalised target, or a failure carrying an explanation.
 * @throws Never.
 */
export function parseTarget(input: string): ParsedTarget | ParseFailure {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'no domain was given' };

  const host = extractHost(trimmed);
  if (host === null) {
    return { ok: false, reason: `"${trimmed}" is not a domain or a URL` };
  }

  const ipVersion = isIP(host);
  if (ipVersion !== 0) {
    return { ok: true, ascii: host, unicode: null, registrable: null, isIp: true };
  }

  // domainToASCII implements UTS-46, which raw punycode does not. It returns ''
  // for some invalid input but not all — 'a..b' comes back unchanged — so the
  // label check below is the real validation, not the empty-string test.
  const ascii = domainToASCII(host).toLowerCase();
  if (ascii === '') {
    return { ok: false, reason: `"${trimmed}" is not a valid domain name` };
  }

  const labels = ascii.split('.');
  if (labels.length < 2) {
    return { ok: false, reason: `"${trimmed}" is not a fully qualified domain name` };
  }
  for (const label of labels) {
    if (label.length === 0 || label.length > 63 || !LABEL.test(label)) {
      return { ok: false, reason: `"${trimmed}" is not a valid domain name` };
    }
  }
  if (ascii.length > 253) {
    return { ok: false, reason: `"${trimmed}" is longer than the 253-character limit` };
  }

  const unicode = domainToUnicode(ascii);

  return {
    ok: true,
    ascii,
    unicode: unicode === ascii ? null : unicode,
    registrable: getDomain(ascii) ?? null,
    isIp: false,
  };
}

/**
 * Reduces an input to its host part, stripping a scheme, a path, a port, userinfo
 * and any trailing dot.
 *
 * @param input A trimmed hostname or URL.
 * @returns The host, or `null` if nothing host-shaped could be found.
 * @throws Never.
 */
function extractHost(input: string): string | null {
  let candidate = input;

  if (candidate.includes('://')) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return null;
    }
    // `hostname` strips userinfo and the port, but keeps the brackets around an
    // IPv6 literal — and `isIP` does not accept the bracketed form.
    candidate = parsed.hostname.replace(/^\[|\]$/g, '');
  } else {
    // A bare `example.com/path` or `example.com:443` never reaches the URL parser,
    // so trim those by hand rather than guessing a scheme.
    candidate = candidate.split('/')[0] ?? '';
    const colon = candidate.lastIndexOf(':');
    if (colon !== -1 && !candidate.includes(']')) candidate = candidate.slice(0, colon);
  }

  candidate = candidate.replace(/\.$/, '');
  return candidate === '' ? null : candidate;
}
