import * as z from 'zod/v4';
import { DOMAIN_EXPIRY_WARNING_DAYS, LIMITS } from './defaults.js';
import { parseTarget } from './domain-name.js';
import { normaliseUrl } from './url.js';

/**
 * The portfolio file: what a person maintaining client sites keeps their list
 * in, and the only place a site's own thresholds are configured.
 *
 * The file holds names, URLs and notes — no credentials, and nothing that is
 * not already public. It is read, never written: this server does not manage
 * the list, it reads the one its user keeps.
 */

/** Every check a portfolio entry may ask for. */
export const CHECK_NAMES = ['domain', 'ssl', 'uptime', 'seo', 'accessibility'] as const;

/** One check, by name. */
export type CheckName = (typeof CHECK_NAMES)[number];

/** Checks that exist today. `accessibility` is Phase 4 and is accepted but not run. */
export const IMPLEMENTED_CHECKS: readonly CheckName[] = ['domain', 'ssl', 'uptime', 'seo'];

/** The default set for a file that does not say. */
const DEFAULT_CHECKS: readonly CheckName[] = ['domain', 'ssl', 'uptime'];

const checkSchema = z.enum(CHECK_NAMES);

const siteSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  domain: z.string().min(1).optional(),
  checks: z.array(checkSchema).optional(),
  expiryWarningDays: z.int().min(1).max(3650).optional(),
  maxLinks: z.int().min(0).max(50).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

const fileSchema = z.object({
  version: z.literal(1),
  defaults: z
    .object({
      checks: z.array(checkSchema).optional(),
      expiryWarningDays: z.int().min(1).max(3650).optional(),
      maxLinks: z.int().min(0).max(50).optional(),
    })
    .optional(),
  sites: z.array(siteSchema).min(1),
});

/** One site, with every default already applied. */
export interface Site {
  /** Human label used in reports. */
  name: string;
  /** The address a visitor would use. */
  url: string;
  /** Registrable domain for registration and DNS checks. */
  domain: string;
  /** Which checks to run for this site. */
  checks: CheckName[];
  /** Days before expiry at which this site's owner wants warning. */
  expiryWarningDays: number;
  /**
   * Internal links `seo_audit` may request for this site. `0` switches link
   * checking off.
   *
   * The setting that decides what a portfolio run costs. Link checking is one
   * request per link, paced at half a second per host, so twenty-five links is
   * twelve seconds a site — measured, a portfolio of twenty takes eight seconds
   * without it and around forty with it. Sites where broken links matter keep
   * the default; the rest can drop it.
   */
  maxLinks: number;
  /** Free-form labels, for filtering a report. */
  tags: string[];
  /** Context carried through into the report. */
  notes: string | null;
}

/** What a portfolio file turned into. */
export type PortfolioResult = { ok: true; sites: Site[] } | { ok: false; reason: string };

/**
 * Validates a parsed portfolio file and applies its defaults.
 *
 * Rejecting a whole file for one bad entry is deliberate. A portfolio report
 * quietly missing a site is worse than one that does not run: the reader has no
 * way to notice the absence, and the whole point of the tool is that nothing
 * gets forgotten.
 *
 * @param raw The parsed JSON, from a file or from tool input.
 * @returns The sites with defaults applied, or why the file cannot be used.
 * @throws Never.
 */
export function readPortfolio(raw: unknown): PortfolioResult {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? 'the file' : `\`${first.path.join('.') || 'the file'}\``;
    return {
      ok: false,
      reason: `${where} is not valid: ${first?.message ?? 'unknown reason'}`,
    };
  }

  const defaults = parsed.data.defaults ?? {};
  const sites: Site[] = [];

  for (const entry of parsed.data.sites) {
    const site = normaliseSite(entry, defaults);
    if (!site.ok) return site;
    sites.push(site.site);
  }

  return { ok: true, sites };
}

/**
 * Applies the file's defaults to one entry and derives what it left out.
 *
 * @param entry The entry as written.
 * @param defaults The file-level defaults.
 * @returns The complete site, or why this entry is unusable.
 * @throws Never.
 */
function normaliseSite(
  entry: z.infer<typeof siteSchema>,
  defaults: {
    checks?: CheckName[] | undefined;
    expiryWarningDays?: number | undefined;
    maxLinks?: number | undefined;
  },
): { ok: true; site: Site } | { ok: false; reason: string } {
  const url = normaliseUrl(entry.url);
  if (url === null) {
    return { ok: false, reason: `"${entry.name}" has an unusable url: ${entry.url}` };
  }

  // A site on a subdomain has its registration on the parent, so the domain is
  // derived rather than assumed to equal the host — and an entry may override it.
  let domain = entry.domain;
  if (domain === undefined) {
    const target = parseTarget(url.hostname);
    if (!target.ok || target.isIp) {
      return {
        ok: false,
        reason: `"${entry.name}" has no registrable domain; set "domain" explicitly for ${entry.url}`,
      };
    }
    domain = target.registrable ?? target.ascii;
  }

  return {
    ok: true,
    site: {
      name: entry.name,
      url: url.toString(),
      domain,
      checks: [...(entry.checks ?? defaults.checks ?? DEFAULT_CHECKS)],
      expiryWarningDays:
        entry.expiryWarningDays ?? defaults.expiryWarningDays ?? DOMAIN_EXPIRY_WARNING_DAYS,
      maxLinks: entry.maxLinks ?? defaults.maxLinks ?? LIMITS.maxLinksChecked,
      tags: entry.tags ?? [],
      notes: entry.notes ?? null,
    },
  };
}

/**
 * Parses portfolio JSON text.
 *
 * @param text The file contents.
 * @returns The sites, or why the text cannot be used. A JSON syntax error is
 *   reported as one, with the parser's own message, because "unexpected token
 *   at position 412" is what actually helps someone fix a hand-edited file.
 * @throws Never.
 */
export function readPortfolioText(text: string): PortfolioResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return {
      ok: false,
      reason: `the file is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  return readPortfolio(raw);
}

/**
 * Filters a portfolio by tag.
 *
 * @param sites The portfolio.
 * @param tags Tags to keep. An empty list keeps everything.
 * @returns Sites carrying at least one of the tags.
 * @throws Never.
 */
export function filterByTags(sites: readonly Site[], tags: readonly string[]): Site[] {
  if (tags.length === 0) return [...sites];
  const wanted = new Set(tags.map((tag) => tag.toLowerCase()));
  return sites.filter((site) => site.tags.some((tag) => wanted.has(tag.toLowerCase())));
}
