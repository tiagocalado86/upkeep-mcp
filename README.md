# upkeep-mcp

An MCP server for the recurring checks behind ongoing website maintenance:
domains, SSL certificates, uptime, technical SEO and accessibility — all from
publicly available information.

Built for people who look after a portfolio of client sites on a retainer, not
just a single domain. The goal is to answer one question quickly: **what needs
attention this week?**

## Status

Early development. Nothing is implemented yet — this repository is being built
in public, phase by phase.

Planned tools:

| Tool | Purpose |
| --- | --- |
| `domain_check` | Registration expiry, registrar, nameservers, DNS records, DNSSEC |
| `ssl_check` | Certificate expiry, issuer, chain validity, SAN coverage, TLS version |
| `uptime_check` | HTTP status, response time, redirect chain, security headers |
| `seo_audit` | Title, meta, headings, canonical, robots.txt, sitemap, broken links |
| `accessibility_audit` | WCAG violations via axe-core |
| `portfolio_report` | All of the above across a portfolio, sorted by urgency |

## Security & privacy

This server never asks for, accepts or stores credentials. It reads only
information that any person with a browser or a DNS resolver could read.

- No API keys, tokens or passwords — for any service, ever.
- No intrusive behaviour: no port scanning, no subdomain brute-forcing, no
  vulnerability probing. It inspects public configuration; it is not an
  offensive tool.
- `robots.txt` is respected on any page crawl, with per-host rate limiting and
  an identifiable `User-Agent`.
- No persistent sensitive state. Caching is in memory or in a local file, with
  a TTL.

## Requirements

- Node.js 20 or newer

## License

MIT — see [LICENSE](LICENSE).
