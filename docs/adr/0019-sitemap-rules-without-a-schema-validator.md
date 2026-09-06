# 19. Check the sitemap's rules without an XML schema validator

Status: accepted (2026-09-07)

## Context

`seo_audit` established that a sitemap exists, declares `<urlset>` or
`<sitemapindex>`, and holds some number of `<loc>` entries. That is enough to
tell a site with no sitemap from a site with one, and not enough to tell a
sitemap that works from a sitemap that is quietly ignored.

The gap is not theoretical. A file that answers `200`, parses, and lists every
page of the site is still dropped whole by a consumer if the root element
declares no `http://www.sitemaps.org/schemas/sitemap/0.9` namespace; entries on
another host are discarded; an unescaped `&` makes the document ill-formed XML
and costs every entry after it. All three read as a perfectly healthy sitemap to
a check that only counts `<loc>` elements, and all three are what a maintenance
retainer is supposed to catch.

The obvious implementation is to validate against the protocol's XSD, which
means an XML parser and a schema validator — two dependencies, in the part of
this project that reads bytes chosen by somebody else's server.

## Decision

Check the rules, not the schema. The protocol's constraints are a short list, so
they are written out as a list: the namespace, `<loc>` present and absolute and
escaped and within 2048 characters and on the sitemap's own host, `<lastmod>` a
W3C Datetime, `<changefreq>` from its seven values, `<priority>` within 0.0 to
1.0, at most 50,000 entries, and no `<url>`-only element inside an index entry.

Each is reported as a defect carrying a severity: `warning` when a consumer
drops the entry or the file, `info` when the value is ignored and the page is
still crawled. Defects are aggregated by rule, with a count and one example.

## Consequences

- The commonest ways a sitemap silently fails are now findings, with the reason
  and the size of the problem, rather than a green line in a report.
- A rule is graded by what it costs in practice, not by how the specification
  reads. Declaring the namespace as `https://www.sitemaps.org/...` is strictly a
  different namespace, and cloudflare.com does it; the large consumers accept
  it, so it is reported as `info` with the explanation instead of as a file
  nobody reads. The `www` sibling of the sitemap's own host is graded the same
  way. Both were found by running the checks against real sitemaps rather than
  against fixtures, which is the only way this kind of false alarm surfaces.
- Aggregation is what keeps this usable in `portfolio_report`. One mistake in a
  template breaks one rule in fifty thousand entries; the report says so once.
- No XML parser and no schema validator, so no dependency reads a stranger's
  bytes. The scan is regex over the document, as the reader already was.
- **Rules deliberately not checked**, because none of them can be established
  from one document without another request or another mechanism: the 50 MB
  uncompressed size limit, which the read cap makes unmeasurable; a
  `<sitemapindex>` that lists another index, which needs the child fetched;
  duplicate `<loc>` values, which the protocol permits; and whether a `<lastmod>`
  is truthful.
- A rule is checked only against the part of a document that arrived. A
  truncated read cuts an entry in half, and half an entry is not a defect.
- This is not XSD validation and the README says so. A document could satisfy
  every rule here and still fail a validator on something structural — nested
  elements in the wrong order, say — which no consumer enforces either.
