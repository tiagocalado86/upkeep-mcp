# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A Streamable HTTP entrypoint, `src/http.ts`, for a public demo instance: the
  SDK's own handler behind a hand-written `node:http` adapter, so no HTTP
  framework joins the dependency list. It builds its tools on guarded ports,
  admits callers through a token bucket (60 a minute, burst of 20, 8 in flight
  across everyone), caps request bodies, answers a browser with a plain-text
  page, and shuts down cleanly on SIGTERM. The port comes from `--port`, never
  from the environment.
- A Dockerfile and `docs/deploying.md` for Google Cloud Run, chosen because it
  runs an ordinary container: edge runtimes cannot read a peer certificate, so
  `ssl_check` would be dead there while everything else looked fine.
- A target guard for public deployments: `createDefaultPorts({ publicTargetsOnly:
true })` refuses any host resolving outside public unicast space — loopback,
  private ranges, and the link-local address where cloud metadata lives — and
  opens no port but 443. Off by default, because a local operator pointing the
  tool at their own staging box is the tool working as intended. See
  `docs/adr/0012-public-target-guard.md`, which also states the gap it leaves.
- `docs/prior-art.md`: the MCP servers that already check certificates, domains,
  uptime and accessibility, what several of them do better than this one, and
  the gap none of them fills — every one answers about a single target, and
  nothing aggregates a portfolio or reports what changed since the last run.

## [0.2.0] - 2026-09-01

### Added

- `seo_audit`: title and meta description with their lengths, heading structure,
  canonical, `lang`, viewport, Open Graph, `hreflang` alternates, images with no
  `alt` attribute, the state of `robots.txt` and the sitemap, and which internal
  links are broken. It audits one page and checks that page's internal links; it
  does not crawl. See `docs/adr/0010-one-page-audit-instead-of-crawl-depth.md`.
- `robots.txt` parsing and matching to RFC 9309, written here rather than taken
  from an unmaintained package, with path matching that cannot be made to
  backtrack by a hostile file. See
  `docs/adr/0009-own-robots-txt-implementation.md`.
- HTML parsing with `parse5`, so pages are read the way a browser reads them,
  broken markup included. See `docs/adr/0008-parse5-with-own-extraction.md`.
- A structural sitemap check that recognises the commonest failure: an HTML 404
  page served at the sitemap URL with a 200 status.
- `getText`, which reads a response body up to a byte limit and reports whether
  it was cut off, so no remote host decides how much this process allocates.
- `portfolio_report`: every check across a whole portfolio, with bounded
  concurrency, returned as one report ordered by what needs action first. Reads
  the portfolio inline or from a local JSON file, filters by tag, and reports
  what regressed since the previous run. A site that cannot be checked is a
  finding, not a failed report.
- The `portfolio://sites` resource, exposing the site list to a client without
  spending a tool call, and the `quarterly_report` prompt, which turns a
  portfolio run into the report a client reads.
- Comparison with the previous run, held in memory for the life of the server
  process and never written to disk. Only sites that both runs measured the same
  way are compared, and the report says how many that was: comparing a quick
  `checks: ["uptime"]` pass against a full run would otherwise report every
  certificate and registration finding as newly appeared — or, in the other
  order, announce that a site with a certificate expiring in three days had
  improved. See `docs/adr/0011-in-memory-run-history.md`.
- A site whose requested checks cannot all run reports them anyway, with
  `ran: false`; one whose checks can none of them run is `unknown`, never `ok`.
  A portfolio must not read as healthy having checked nothing.
- `maxLinks` per site in the portfolio file, and inline in `portfolio_report`:
  how many internal links the `seo` check may request, `0` for none. Measured
  over twenty public domains, a portfolio takes about eight seconds without
  `seo` and around forty with it, because link checking is one request per link
  paced at half a second per host — so the budget belongs to whoever owns the
  portfolio, not to a constant in the code.
- `npm run coverage`, and tests for the pieces that had none: the DNS record
  mapping, the certificate chain walk, error categorisation, the RDAP lookup
  path and the portfolio machinery.

### Fixed

- `uptime_check` reported a site as healthy when its redirect pointed at a host
  that could not be reached: the failed hop was swallowed and the result read
  `severity: ok`, `reachable: true`, no findings. A chain that stops dead is now
  a critical finding naming the URL that refused.
- `domain_check` reported "The domain does not resolve at all" — critical — when
  the DNS lookup had merely timed out, directly above the warning saying so. The
  empty records that stand in for a failed lookup are no longer read as fact,
  and `dnsResolved` says which happened.
- `ssl_check` read an unanswered DNS lookup as "www does not resolve", which
  switched off the www coverage check and passed a certificate that does not
  cover it. `wwwResolves` is now null when nothing was established, and the gap
  is reported.
- `seo_audit` never fetched a sitemap declared with a relative path, reporting
  "Invalid URL" instead; a sitemap on another host is now checked against that
  host's `robots.txt` before it is requested; a sitemap cut off at the read
  limit says so instead of reporting a partial count as the total; and switching
  link checking off no longer blames a limit of zero.
- `seo_audit` refuses a document nested thousands of levels deep instead of
  parsing it. HTML tree construction costs roughly the square of the nesting
  depth, so two mebibytes of `<div>` would have blocked the event loop for
  minutes — a hang any hostile page could trigger.
- A certificate with no common name is now named by its first subject
  alternative name, as `CertificateSummary` always claimed. The CA/Browser
  Forum deprecated the common name, so certificates that omit it exist, and they
  were being reported with no subject at all.

## [0.1.0] - 2026-08-31

### Added

- `domain_check`: registration expiry and registrar over RDAP, DNS records, and
  whether the delegation is signed with DNSSEC. Registries that publish no expiry
  date are named as such rather than reported as unknown.
- `ssl_check`: certificate expiry, issuer, chain validity, which hostnames the
  certificate covers and via which SAN entry, and the negotiated TLS version.
  Expired, self-signed and untrusted certificates are inspected, not refused. A
  certificate becomes a warning inside 14 days rather than 30, because ACME
  clients renew with 30 days left and the wider window would fire on healthy
  sites. A certificate whose dates cannot be read is reported as `unknown`, never
  as nothing wrong.
- `uptime_check`: status, response time, the full redirect chain, whether plain
  HTTP is upgraded to HTTPS, the HSTS policy and the security headers worth
  reporting on. Status codes are graded rather than lumped together: 5xx, 404 and
  410 are critical, 401 and 403 are a warning because they are normal for a
  staging site, and 429 is `unknown` because a throttled check establishes
  nothing.
- In-memory TTL caching that collapses concurrent lookups, and per-host rate
  limiting keyed by the host actually contacted. A DNS lookup that found nothing
  is held for a minute rather than five, so a delegation that has just been fixed
  is not reported as broken for the rest of the TTL.
- Every check returns its findings ordered worst first, so the order is a
  contract the aggregation in `portfolio_report` can rely on rather than an
  accident of the order things were detected in.
- `examples/` with real captured output from each tool, and
  `docs/architecture.md`.
- Project scaffolding: TypeScript in `strict` mode, ESM, ESLint, Prettier and
  Vitest, with a `npm run check` gate that runs all four.
- An MCP server over the stdio transport, built on the MCP TypeScript SDK v2.
- A `health` tool reporting the server name, version, Node.js version and
  uptime — enough to confirm a client is talking to the server.
- `guard`, a wrapper applied to every tool handler so that no exception can
  cross the MCP boundary.
- GitHub Actions CI running format, lint, typecheck, tests and build on
  Node.js 22 and 24.
- `CLAUDE.md` recording the project principles and conventions.
- `docs/adr/` recording the structural decisions, including the choice to ship
  without a WHOIS fallback and the move to a Node.js 22 baseline.

### Changed

- The minimum supported Node.js version is 22, not the 20 originally planned.
  Node 20 reached end of life on 2026-04-30, and every certificate and DNS API
  this release needs sits on that boundary. See
  `docs/adr/0003-node-22-baseline.md`.

[Unreleased]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tiagocalado86/upkeep-mcp/releases/tag/v0.1.0
