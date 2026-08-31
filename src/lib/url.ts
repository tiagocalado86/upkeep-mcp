/**
 * Turning what a caller typed into a URL this project can request.
 *
 * Shared by `uptime_check` and `seo_audit`, which both accept "example.com" as
 * readily as "https://example.com/pricing" because that is how a person names a
 * site out loud.
 */

/**
 * Accepts a URL or a bare hostname.
 *
 * A bare hostname is tried over HTTPS: defaulting to plain HTTP would make
 * every such check report an upgrade redirect as though it were the site's real
 * behaviour.
 *
 * @param input Whatever the caller passed.
 * @returns The URL, or `null` when nothing usable could be made of it.
 * @throws Never.
 */
export function normaliseUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.hostname === '' ? null : url;
  } catch {
    return null;
  }
}
