# Prior art

Researched 2026-09-01, as section 11 of the project brief asks. The question is
not whether to build this — it is what already exists, what it does well, and
where the gap actually is. A portfolio piece that cannot say why it exists
alongside the alternatives is not finished.

## What exists

Searched GitHub and the MCP directories for `mcp ssl`, `mcp domain`,
`mcp uptime`, `mcp accessibility`. The closest neighbours:

| Server                                                                                                                                                                 | What it does                                                                                                          | Shape                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| [`firesh/sslmon-mcp`](https://github.com/firesh/sslmon-mcp)                                                                                                            | `get_domain_info` and `get_ssl_cert_info` — registration dates, registrar, certificate validity, days to expiry       | Two tools, one domain per call       |
| [`malaya-zemlya/tls-mcp`](https://github.com/malaya-zemlya/tls-mcp)                                                                                                    | `fetch_certificate` — subject, issuer, SANs, extensions, cipher suites, an A+ to F grade, optional `zlint` compliance | One tool, one host per call          |
| [`simplebytes-com/domaindetails-mcp`](https://github.com/simplebytes-com/domaindetails-mcp)                                                                            | `domain_lookup` — RDAP with a WHOIS fallback, 50+ TLDs                                                                | One tool, one domain per call        |
| [`kolontsov/domain-mcp`](https://github.com/kolontsov/domain-mcp)                                                                                                      | Domain availability over WHOIS/RDAP, across common TLDs                                                               | Availability, not maintenance        |
| [`danielsogl/lighthouse-mcp-server`](https://github.com/danielsogl/lighthouse-mcp-server)                                                                              | 13+ tools over Google Lighthouse: performance, accessibility, SEO, Core Web Vitals, security                          | One URL per call, needs Chrome       |
| [`priyankark/a11y-mcp`](https://github.com/priyankark/a11y-mcp), [`JustasMonkev/mcp-accessibility-scanner`](https://github.com/JustasMonkev/mcp-accessibility-scanner) | axe-core over Playwright, WCAG violations with selectors                                                              | One page per call, needs a browser   |
| [`DavidFuchs/mcp-uptime-kuma`](https://github.com/DavidFuchs/mcp-uptime-kuma)                                                                                          | Talks to an existing Uptime Kuma instance                                                                             | Needs infrastructure and credentials |

## What they do well

Some of these do their own job better than this project does, and the honest
thing is to say so.

`tls-mcp` goes further on TLS than `ssl_check`: cipher suite enumeration, a
letter grade, and `zlint` compliance checking, with 34 tests behind it. If the
question is "how good is this TLS configuration?", it is the better tool.

`lighthouse-mcp-server` covers what `seo_audit` deliberately does not — rendered
performance, Core Web Vitals, and the accessibility and best-practice audits
that need a real browser. If the question is "how does this page perform?", the
answer is Lighthouse, here or anywhere else.

`domaindetails-mcp` keeps the WHOIS fallback this project dropped
([ADR 0004](adr/0004-rdap-without-whois.md)), which for a handful of registries
recovers data RDAP does not carry.

## What none of them do

Every server above answers a question about **one target**. Domain, host, page:
one per call, one answer, no ranking.

That is the right shape for the question "is this certificate valid?" and the
wrong shape for the question this project exists to answer: **"across the forty
sites I look after, what needs attention this week?"** Asking that of the tools
above means four calls per site, a spreadsheet, and a person to do the sorting —
which is the work, not the answer.

Two consequences follow, and neither is available anywhere else found:

- **Nothing aggregates.** No server takes a list of sites, runs the checks with
  bounded concurrency, and returns one list ordered by what expires soonest and
  what is down. `portfolio_report` is that tool, and it is the reason the rest of
  this repository exists.
- **Nothing remembers.** No server reports what changed since the last run. A
  retainer is judged on "what moved this quarter", and answering it from
  scratch every time is how the quarterly report takes an afternoon.

The split also runs along the wrong axis. Certificate tools know nothing about
registration; Lighthouse-based tools know nothing about certificates or
registration. Someone maintaining client sites needs both halves and the
ranking, and today they get neither together.

## What this changed in the design

- The centrepiece is `portfolio_report`, not the individual checks. The checks
  exist to feed it — which is why each tool exposes a second entry point
  returning its report rather than only an MCP result.
- Depth is spent where it is not already covered. `ssl_check` reports SAN
  coverage of the apex and `www` — the misconfiguration that actually bites a
  small business — rather than competing with `tls-mcp` on cipher grading.
- `seo_audit` reads markup and never opens a browser, so a portfolio run stays
  seconds rather than minutes. Rendered performance is left to Lighthouse.
- `accessibility_audit` is scheduled last, and the honest reason is that
  `a11y-mcp` and friends already do it well over a browser this project would
  otherwise not need.

## Method, and what this does not claim

Searches were run on 2026-09-01 against GitHub and the MCP server directories;
each project listed was read from its own README. Star counts, last-commit dates
and test coverage were not consistently available and are not reported here,
because a stale number is worse than none.

This is a snapshot of a fast-moving ecosystem, not a survey. Something matching
the portfolio shape may already exist and not surface for these search terms; if
you know of one, [open an issue](https://github.com/tiagocalado86/upkeep-mcp/issues)
and this page will say so.
