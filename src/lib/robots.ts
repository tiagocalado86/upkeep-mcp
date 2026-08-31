/**
 * `robots.txt` parsing and matching, per RFC 9309.
 *
 * Written here rather than taken from a package because respecting `robots.txt`
 * is one of this project's stated principles, and the rules are small enough to
 * own: a group is selected by product token, a path pattern supports `*` and a
 * trailing `$`, the longest match wins, and `allow` breaks a tie. Everything
 * below cites the section it implements, so the reasoning is checkable against
 * the RFC rather than against this file's author.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9309.html
 */

import { LIMITS, TIMEOUTS } from './defaults.js';
import { getText } from './http-client.js';

/** One `allow` or `disallow` rule. */
interface Rule {
  /** `true` for `allow`, `false` for `disallow`. */
  allow: boolean;
  /** The path pattern as written, e.g. `/private/*.pdf$`. */
  pattern: string;
  /**
   * Length in octets, which is what RFC 9309 §2.2.2 ranks specificity by.
   * Precomputed because every path match compares every rule.
   */
  length: number;
}

/** The rules that applied to one or more product tokens. */
interface Group {
  /** Product tokens this group was declared for, lowercased. `*` is the catch-all. */
  tokens: string[];
  /** The rules in the order they appeared. */
  rules: Rule[];
  /**
   * `Crawl-delay` in seconds, when the file carried one.
   *
   * Not part of RFC 9309 — it is a de facto extension — but widely used by
   * hosts that want slower crawling, and cheap to honour.
   */
  crawlDelaySeconds: number | null;
}

/** A parsed `robots.txt`. */
export interface RobotsTxt {
  /** Every group in the file. */
  groups: Group[];
  /** Absolute sitemap URLs, which RFC 9309 §2.2.3 defines as file-wide, not per group. */
  sitemaps: string[];
  /** Whether the file contained at least one directive this parser understood. */
  hasDirectives: boolean;
}

/**
 * How the fetch of a `robots.txt` turned out.
 *
 * The distinction matters: RFC 9309 §2.3.1 asks a crawler to treat an
 * unreachable file as "disallow everything" and an absent one as "allow
 * everything", which are opposite conclusions from a request that did not
 * return a document.
 */
export type RobotsAvailability =
  /** A document was fetched and parsed. */
  | 'fetched'
  /** The host answered 4xx: there are no rules, so nothing is disallowed. */
  | 'absent'
  /** The host answered 5xx or could not be reached: assume everything is disallowed. */
  | 'unreachable';

/** An empty rule set, for a host that published none. */
export const EMPTY_ROBOTS: RobotsTxt = { groups: [], sitemaps: [], hasDirectives: false };

/**
 * Parses a `robots.txt` document.
 *
 * Tolerant by design, as RFC 9309 §2.2 requires: unknown fields are skipped,
 * malformed lines are skipped rather than failing the file, and a rule that
 * appears before any `user-agent` line is attributed to the catch-all group so
 * that a common authoring mistake still restricts this crawler rather than
 * being silently ignored.
 *
 * @param text The document body, as served.
 * @returns The groups, sitemaps and whether anything was understood.
 * @throws Never.
 */
export function parseRobots(text: string): RobotsTxt {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  // A run of consecutive `user-agent` lines declares one group for all of them,
  // so tokens accumulate until the first rule closes the run.
  let startingGroup = false;
  let hasDirectives = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === '') continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (value === '') continue;
      if (!startingGroup || current === null) {
        current = { tokens: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
        startingGroup = true;
      }
      current.tokens.push(value.toLowerCase());
      hasDirectives = true;
      continue;
    }

    if (field === 'sitemap') {
      if (value !== '') sitemaps.push(value);
      hasDirectives = true;
      continue;
    }

    if (field !== 'allow' && field !== 'disallow' && field !== 'crawl-delay') continue;

    current ??= implicitGroup(groups);
    startingGroup = false;
    hasDirectives = true;

    if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
      continue;
    }

    // RFC 9309 §2.2.2: an empty `disallow` is how a file says "nothing is
    // disallowed". It is not a rule matching every path, which is what treating
    // the empty string as a prefix would make it.
    if (value === '') continue;

    current.rules.push({ allow: field === 'allow', pattern: value, length: value.length });
  }

  return { groups, sitemaps, hasDirectives };
}

/**
 * Decides whether a path may be requested.
 *
 * @param robots The parsed file.
 * @param token This crawler's product token, e.g. `upkeep-mcp`. Compared
 *   case-insensitively, as RFC 9309 §2.2.1 requires.
 * @param path The path and query to test, e.g. `/blog/post?draft=1`.
 * @returns `true` when no rule forbids it. A file with no applicable group
 *   allows everything, which is the RFC's default.
 * @throws Never.
 */
export function isAllowed(robots: RobotsTxt, token: string, path: string): boolean {
  const group = selectGroup(robots, token);
  if (group === null) return true;

  const target = normalisePath(path);
  let best: Rule | null = null;

  for (const rule of group.rules) {
    if (!matchesPattern(rule.pattern, target)) continue;
    // RFC 9309 §2.2.2: the most specific match wins, measured in octets, and
    // `allow` wins a tie. Iteration order is therefore irrelevant.
    if (best === null || rule.length > best.length || (rule.length === best.length && rule.allow)) {
      best = rule;
    }
  }

  return best === null ? true : best.allow;
}

/**
 * The group that applies to a crawler.
 *
 * @param robots The parsed file.
 * @param token This crawler's product token.
 * @returns The merged rules for the most specific matching token, the catch-all
 *   group when nothing matches, or `null` when neither exists.
 * @throws Never.
 */
export function selectGroup(robots: RobotsTxt, token: string): Group | null {
  const wanted = token.toLowerCase();

  // RFC 9309 §2.2.1: a crawler obeys the group whose token it matches, and only
  // falls back to `*` when no group names it. A token matches when it is a
  // prefix of ours, so a file addressing `upkeep` reaches `upkeep-mcp` too.
  const matchLength = (group: Group): number =>
    Math.max(
      0,
      ...group.tokens
        .filter((candidate) => candidate !== '*' && wanted.startsWith(candidate))
        .map((candidate) => candidate.length),
    );

  // Only the *most* specific token applies. A file carrying both `upkeep` and
  // `upkeep-mcp` blocks means the second one was written for us, and merging
  // both would hand us rules that were meant for a different crawler.
  const longest = Math.max(0, ...robots.groups.map(matchLength));
  const applicable =
    longest > 0
      ? robots.groups.filter((group) => matchLength(group) === longest)
      : robots.groups.filter((group) => group.tokens.includes('*'));

  if (applicable.length === 0) return null;

  // Groups naming the same token must be merged rather than the first one
  // winning, which is the difference between reading two blocks and ignoring
  // the second.
  return applicable.reduce<Group>(
    (merged, group) => ({
      tokens: [...merged.tokens, ...group.tokens],
      rules: [...merged.rules, ...group.rules],
      crawlDelaySeconds: maxDelay(merged.crawlDelaySeconds, group.crawlDelaySeconds),
    }),
    { tokens: [], rules: [], crawlDelaySeconds: null },
  );
}

/**
 * Matches a path against a `robots.txt` pattern.
 *
 * Patterns are prefix matches with two operators, per RFC 9309 §2.2.3: `*`
 * stands for any run of characters and a trailing `$` anchors the end.
 *
 * Deliberately not a regular expression. The pattern comes from a remote host,
 * and `/*a*a*a*a*a*a*a*b` compiled to `.*` alternations backtracks
 * exponentially — a hang a hostile site could trigger from a file we are
 * obliged to read. This is the standard two-pointer wildcard match instead:
 * greedy, with one backtrack point per `*`, so the worst case is quadratic in
 * the length of the path rather than exponential.
 *
 * @param pattern The rule's pattern, `$` included when it was written.
 * @param path The already-normalised path to test.
 * @returns Whether the rule applies to this path.
 * @throws Never.
 */
function matchesPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = normalisePath(anchored ? pattern.slice(0, -1) : pattern);

  let patternIndex = 0;
  let pathIndex = 0;
  let lastStar = -1;
  let resumeFrom = 0;

  while (pathIndex < path.length) {
    // A prefix rule is satisfied the moment its pattern runs out; only `$`
    // demands that the path run out at the same time.
    if (!anchored && patternIndex === body.length) return true;

    if (body[patternIndex] === '*') {
      lastStar = patternIndex;
      patternIndex += 1;
      resumeFrom = pathIndex;
    } else if (patternIndex < body.length && body[patternIndex] === path[pathIndex]) {
      patternIndex += 1;
      pathIndex += 1;
    } else if (lastStar !== -1) {
      // The last `*` consumed too little. Give it one more character and retry.
      patternIndex = lastStar + 1;
      resumeFrom += 1;
      pathIndex = resumeFrom;
    } else {
      return false;
    }
  }

  while (body[patternIndex] === '*') patternIndex += 1;
  return patternIndex === body.length;
}

/**
 * Puts a path and a pattern into the same alphabet before they are compared.
 *
 * RFC 9309 §2.2.2 asks that both sides be percent-encoded consistently. A rule
 * written `/café/` and a request for `/caf%C3%A9/` are the same resource, and
 * comparing them raw would miss it.
 *
 * @param value A path or a pattern fragment.
 * @returns The value with non-ASCII octets percent-encoded, existing escapes
 *   left alone, and the `robots.txt` operators preserved.
 * @throws Never.
 */
function normalisePath(value: string): string {
  return value.replace(/[^\x20-\x7E]+/gu, (chunk) => encodeURIComponent(chunk));
}

/**
 * @param line One line of the document.
 * @returns The line with any `#` comment removed.
 * @throws Never.
 */
function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

/**
 * Creates the group that rules appearing before any `user-agent` line belong to.
 *
 * @param groups The groups collected so far, appended to in place.
 * @returns A catch-all group.
 * @throws Never.
 */
function implicitGroup(groups: Group[]): Group {
  const group: Group = { tokens: ['*'], rules: [], crawlDelaySeconds: null };
  groups.push(group);
  return group;
}

/**
 * @param left One delay, or `null`.
 * @param right The other, or `null`.
 * @returns The slower of the two, because merging groups must not speed a
 *   crawler up.
 * @throws Never.
 */
function maxDelay(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

/** A `robots.txt` as it was found on a host. */
export interface RobotsFetch {
  /** The URL that was requested. */
  url: string;
  /** How the fetch turned out, which decides what silence means. */
  availability: RobotsAvailability;
  /** HTTP status, or `null` when the host could not be reached at all. */
  status: number | null;
  /** The parsed rules. Empty unless a document was fetched. */
  robots: RobotsTxt;
}

/**
 * Fetches and parses the `robots.txt` of an origin.
 *
 * RFC 9309 §2.3.1 is explicit about what each outcome means, and the three
 * cases lead to opposite conclusions, so they are kept apart rather than
 * collapsed into "no rules": 2xx is a document, 4xx means the host publishes no
 * rules and everything may be crawled, and 5xx or an unreachable host means a
 * crawler must assume it is disallowed everything.
 *
 * @param origin The scheme and host to ask, e.g. `https://example.com`.
 * @param timeoutMs Deadline for the request.
 * @returns What was found, always — an unreachable host is an answer here, not
 *   an exception.
 * @throws Never.
 */
export async function fetchRobots(
  origin: string,
  timeoutMs: number = TIMEOUTS.supportFileMs,
): Promise<RobotsFetch> {
  const url = new URL('/robots.txt', origin).toString();

  try {
    const response = await getText(url, timeoutMs, LIMITS.maxSupportFileBytes, 'text/plain,*/*');

    if (response.status >= 500) {
      return { url, availability: 'unreachable', status: response.status, robots: EMPTY_ROBOTS };
    }
    if (response.status >= 400) {
      return { url, availability: 'absent', status: response.status, robots: EMPTY_ROBOTS };
    }

    const parsed = parseRobots(response.body);
    // A host that answers 200 with its HTML error page has not published rules,
    // and reading that page as a rule set would produce nonsense either way.
    return parsed.hasDirectives
      ? { url, availability: 'fetched', status: response.status, robots: parsed }
      : { url, availability: 'absent', status: response.status, robots: EMPTY_ROBOTS };
  } catch {
    // A timeout or a refused connection is exactly the case RFC 9309 §2.3.1.3
    // says to read as "disallowed", so it is not re-thrown: the caller needs the
    // verdict, not the exception.
    return { url, availability: 'unreachable', status: null, robots: EMPTY_ROBOTS };
  }
}
