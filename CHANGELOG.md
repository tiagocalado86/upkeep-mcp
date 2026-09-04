# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A portfolio run with `seo_audit` enabled was roughly four times slower than
  the pacing it advertises. The per-host limiter woke one waiter per freed slot,
  from the front of the queue — and because a page's whole link list is
  dispatched at once, the front of the queue is almost always another request to
  a host that is already busy. The wake-up was spent on a waiter that could not
  move, and the slot idled until something else finished. It now wakes every
  waiter and lets the same admission check decide, which changes no limit: still
  one request in flight per host, half a second apart, five across all hosts.
  Twenty sites with every check but accessibility went from 6.5 minutes to
  1 minute; the offline reproduction went from 3.7x the ideal wall clock to 1.0x.

### Changed

- The documented Cloud Run deployment moves to a European region, pins the
  execution environment and names its request timeout. The old command chose a
  US region to keep a free gibibyte of North American egress; priced out, that
  allowance is worth about half a cent a month to a server that pulls pages
  (ingress, free) and returns 5.6 KB reports, while the latency it cost applied
  to every outbound check. `docs/deploying.md` also gained the two things that
  bite on a first deploy — the `roles/run.builder` grant, whose absence reports
  itself as an internal platform error, and a logs exclusion, which is the one
  runaway cost that neither `--max-instances` nor a spend cap contains.

- Why the deployment target is Cloud Run is now written down in
  [ADR 0015](docs/adr/0015-cloud-run-as-the-deployment-target.md), along with
  what would reopen the question. It records one constraint found while
  checking: outbound UDP to arbitrary internet hosts does not leave Cloud Run,
  so the day `dns.ts` queries authoritative nameservers directly, every such
  query fails there — and `optional()` would report the failure as "no such
  record" rather than as an error.

## [0.3.2] - 2026-09-02

### Added

- The first version to actually reach npm, so `npx -y upkeep-mcp` works. 0.3.1
  described that install and could not deliver it: npm had begun requiring 2FA
  to publish, and had stopped enrolling authenticator apps, so the account
  needed a passkey and the first publish a browser challenge.

### Changed

- Releases publish over **OIDC trusted publishing** instead of an npm token in
  a repository secret. npm now requires 2FA to publish, and the one form of that
  a workflow could use — a granular token with 2FA bypass — loses the ability to
  publish in January 2027, so the documented setup shipped in 0.3.1 had an
  expiry date and a secret that had never been created. There is now no
  long-lived publish credential at all, and provenance is attached by npm rather
  than asked for with a flag. See
  [ADR 0014](docs/adr/0014-trusted-publishing-over-a-token.md).

- `portfolio_report` now says _why_ it could not compare part of a run, not only
  how much of it: `1 of 5 sites comparable; 4 of them measured different checks
last time — run two full reports back to back to compare them`. The count on its
  own reads as a fault and leaves the reader to guess; the reason, and the fix,
  do not. Sites the previous run did not check at all are counted separately,
  and both counts are in the structured output.

## [0.3.1] - 2026-09-01

### Added

- Everything needed to publish, so that installation becomes `npx -y upkeep-mcp`
  rather than four steps — the brief's first definition-of-done line, and the
  last one open.
  `playwright-core` downloads no browser on install, so that stays a small
  fetch. A second binary, `upkeep-mcp-http`, starts the Streamable HTTP
  entrypoint, which an installed package previously had no way to reach.
- `server.json` and the matching `mcpName`, for the official MCP registry, and
  `.github/workflows/release.yml`, which publishes on a version tag with npm
  provenance so the tarball is tied to the commit it was built from. The
  workflow re-runs the whole gate and refuses a tag whose version does not match
  `package.json`. Tests keep `server.json`, `package.json` and `SERVER_VERSION`
  from drifting apart.

### Changed

- `exports` no longer publishes the stdio entrypoint as the package's API:
  `import 'upkeep-mcp'` started a server. `.` is now the server factory and
  `./http` the HTTP entrypoint.
- The message for a missing portfolio file said "copy sites.example.json to
  sites.json", which is unactionable for anyone whose client started the server
  somewhere else — Claude Desktop starts them in `/`, so `sites.json` was looked
  for at `/sites.json`. Both the tool and the `portfolio://sites` resource now
  say where the path is resolved from, and `file` asks for a full path.

### Fixed

- The HTTP entrypoint answered _every_ path with the landing page and a 200,
  so a crawler, a browser asking for a favicon and a person with a typo were all
  told they had found something. Only `/` serves the page now; anything but
  `/mcp` is a 404 naming the endpoint.
- The public-target guard checked the port on the TLS path and nowhere else, so
  a public instance would have fetched `https://any-host:22/` and reported back
  whether the connection was refused — a port scan run from the deployment's
  address, wearing this project's `User-Agent`, needing no DNS trickery at all.
  Three documents claimed "only public addresses, only on port 443" while this
  was true. Every outbound path — `hop`, `text`, `robots`, `browser` and `tls` —
  now goes through one helper that checks host and port together, and
  `test/lib/ports.test.ts` asserts it for each of them. The rule is per scheme:
  443 over HTTPS, 80 over plain HTTP, because `uptime_check` exists partly to
  answer whether plain HTTP still answers and upgrades, and 443 cannot answer
  that. See `docs/adr/0012-public-target-guard.md`, which also records why the
  DNS-rebinding gap is accepted on Cloud Run specifically and what would change
  that.
- `SECURITY.md` still named `0.1.x` as the supported release.

## [0.3.0] - 2026-09-01

### Added

- `accessibility_audit`: axe-core over a headless browser, reporting the WCAG
  rules a page fails, how many elements fail each, and where they are. The
  browser is optional — `playwright-core` downloads nothing on install — so a
  machine without one gets an actionable message naming the single command that
  fixes it, and every other check keeps working. Browsers get their own
  concurrency pool: an audit holds a slot for seconds while the browser makes
  requests the limiter never sees, so sharing one starved every other check
  without pacing any browser traffic. See
  `docs/adr/0013-playwright-core-and-an-optional-browser.md`.
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

- `examples/conversation.md`: one portfolio session end to end — the Monday
  triage across five sites, a drill-down into the certificate that caused it, a
  quick uptime-only pass, and a second full run — with every tool output
  verbatim. `examples/accessibility-audit.md` joins it, captured against the
  W3C's own "before" demonstration page, which is built to fail.

### Fixed

- `portfolio_report` said nothing at all when it had compared this run against
  the previous one and found that nothing had moved. Silence was
  indistinguishable from a comparison that never happened, in the one tool whose
  reason to exist is answering "what changed since last time". It now always
  states the outcome, with how many sites were comparable: `No change since
2026-09-01T09:49:19.079Z (1 of 5 sites comparable)`.
- A finding that appeared on a site whose severity did not move was computed,
  put in the structured output, and never mentioned in the text — so a site that
  was a warning for an expiring registration and picked up an expiring
  certificate read as unchanged.
- `accessibility_audit` counted everything in the plural: "1 rules could not be
  decided automatically and need a person to look".

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

[Unreleased]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.3.1...HEAD
[0.3.2]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.3.1...2767d10
[0.3.1]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tiagocalado86/upkeep-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tiagocalado86/upkeep-mcp/releases/tag/v0.1.0
