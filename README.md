# upkeep-mcp

An MCP server for the recurring checks behind ongoing website maintenance:
domains, SSL certificates, uptime, technical SEO and accessibility — all from
publicly available information.

Built for people who look after a portfolio of client sites on a retainer, not
just a single domain. The goal is to answer one question quickly: **what needs
attention this week?**

## Status

Early development, built in public phase by phase. Everything that needs no
browser is implemented and useful today.

| Tool                  | Purpose                                                                     | Status    |
| --------------------- | --------------------------------------------------------------------------- | --------- |
| `domain_check`        | Registration expiry, registrar, nameservers, DNS records, DNSSEC delegation | Available |
| `ssl_check`           | Certificate expiry, issuer, chain validity, SAN coverage, TLS version       | Available |
| `uptime_check`        | HTTP status, response time, redirect chain, HTTPS upgrade, security headers | Available |
| `health`              | Server name, version, Node.js version, uptime                               | Available |
| `seo_audit`           | Title, meta, headings, canonical, robots.txt, sitemap, broken links         | Available |
| `accessibility_audit` | WCAG violations via axe-core                                                | Planned   |

It also exposes the `portfolio://sites` resource (the site list, for a client to
read without spending a tool call) and the `quarterly_report` prompt (turns a
portfolio run into the report a client actually reads).
| `portfolio_report` | All of the above across a portfolio, sorted by urgency | Available |

Not published to npm yet — install from source, as below.

## What it looks like

```
> Is example.com about to expire?

example.com expires 2027-08-13 (346 days).
Registrar: RESERVED-Internet Assigned Numbers Authority.
Nameservers: elliott.ns.cloudflare.com, hera.ns.cloudflare.com.
Resolves: apex yes, www yes. DNSSEC: delegation signed.
```

```
> Check the certificate on expired.badssl.com

expired.badssl.com:443 certificate expires 2015-04-12 (-4159 days).
Issued by COMODO RSA Domain Validation Secure Server CA.
Chain does not verify (CERT_HAS_EXPIRED). Negotiated TLSv1.2.
Host matched via *.badssl.com.
Revocation is not checked.

Needs attention:
- [critical] The certificate expired 4159 days ago.
- [critical] The certificate chain does not verify: CERT_HAS_EXPIRED.
```

Every tool also returns structured data alongside the text, so results can be
sorted, filtered and fed into a report. Full input and output for each tool is in
[`examples/`](examples/).

## The tools

### `domain_check`

Input: `domain` — a bare domain, a full URL, or an internationalised name. A
subdomain is reduced to its registrable domain, since that is what a registration
belongs to.

Returns the expiry date and days remaining, the registrar and its IANA ID,
registry statuses, A/AAAA/NS/MX/TXT/CAA records, whether the apex and `www`
resolve, and whether the delegation is signed with DNSSEC.

### `ssl_check`

Input: `domain`, optional `port` (443 by default).

Returns expiry and days remaining, issuer, whether the chain verifies and why not
when it does not, which hostnames the certificate covers and via which SAN entry,
and the negotiated TLS version and cipher. Expired, self-signed and untrusted
certificates are inspected and reported rather than refused — those are the ones
worth finding.

### `uptime_check`

Input: `url` — a full URL, or a bare domain, which is tried over HTTPS.

Returns the status code, response time, every hop of the redirect chain, whether
plain HTTP is upgraded to HTTPS, the HSTS policy, and the security headers worth
reporting on.

### `seo_audit`

Input: `url` — the page to audit, plus optional `checkLinks` (true by default)
and `maxLinks` (25 by default).

Returns title and meta description with their lengths, the heading structure,
canonical, `lang`, viewport, Open Graph, `hreflang` alternates, the images with
no `alt` attribute, the state of `robots.txt` and the sitemap, and which
internal links are broken.

`robots.txt` is read **before** anything else is requested and is obeyed — for
the page itself and for every internal link. A page this crawler is not allowed
to read is reported as such and is never fetched, and an unreadable `robots.txt`
is treated as forbidding everything, as RFC 9309 requires.

```
> Audit the homepage of example.com

https://example.com/ answered 200. Title: "Example Domain".
1 h1, 0 images without alt, 0 internal links (0 checked, 0 broken).
Sitemap: the sitemap URL answered 404.

Needs attention:
- [warning] The page has no meta description, so search engines will write their own summary of it.
- [info] The page declares no canonical URL, which is how duplicate addresses for the same page get separated.
- [info] The page has no og:title or no og:image, so it will share poorly on social networks and in messaging apps.
- [info] There is no sitemap at https://example.com/sitemap.xml: the sitemap URL answered 404.
- [info] The site publishes no robots.txt. Nothing is blocked, but the sitemap cannot be declared there either.
```

### `portfolio_report`

Input: `sites` inline, or `file` (defaults to `sites.json`), plus optional
`checks` and `tags`.

Runs every check across the whole portfolio with bounded concurrency and returns
one report ordered by what needs action first: what is down, what expires
soonest, what regressed since the last run. A site that cannot be checked
becomes a finding, never a failure of the whole report.

```
> What needs attention across my sites this week?

3 sites checked: 0 critical, 2 warning, 0 unknown, 1 fine.

Needs action:
- [warning] Example Ltd: Plain HTTP does not redirect to HTTPS.
- [warning] Example Ltd: No Strict-Transport-Security header is sent.
- [warning] Example Net: Plain HTTP does not redirect to HTTPS.
- [warning] Example Net: No Strict-Transport-Security header is sent.

First run in this session, so there is nothing to compare against yet.

Nothing to do: Example Foundation.
```

The portfolio file format is documented in
[`sites.example.json`](sites.example.json). Copy it to `sites.json` — which is
gitignored, so a real client list never gets committed.

## Installation

Requires **Node.js 22 or newer**.

```bash
git clone https://github.com/tiagocalado86/upkeep-mcp.git
cd upkeep-mcp
npm install
npm run build
```

### Claude Code

```bash
claude mcp add upkeep -- node /absolute/path/to/upkeep-mcp/dist/index.js
```

### Claude Desktop

Add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "upkeep": {
      "command": "node",
      "args": ["/absolute/path/to/upkeep-mcp/dist/index.js"]
    }
  }
}
```

Restart the client and ask it to run the `health` tool. It answers with the
server version, the Node.js version and how long the process has been up.

## Security & privacy

This server never asks for, accepts or stores credentials. It reads only
information that any person with a browser or a DNS resolver could read.

- No API keys, tokens or passwords — for any service, ever.
- No intrusive behaviour: no port scanning, no subdomain brute-forcing, no
  vulnerability probing. It inspects public configuration; it is not an
  offensive tool.
- `robots.txt` is respected on any page crawl, with per-host rate limiting and
  an identifiable `User-Agent` carrying a contact URL.
- No persistent sensitive state. Caching is in memory only, with a TTL. There is
  no database and nothing is written to disk.
- The only third parties contacted are the ones that hold the answer: the
  registry's own RDAP server, IANA's RDAP bootstrap file, and
  `cloudflare-dns.com` for the one question `node:dns` cannot ask (whether a
  DNSSEC delegation is signed). [`SECURITY.md`](SECURITY.md) lists them and what
  each one learns.

## Limitations

Stated plainly, because a tool that hides what it cannot do is worse than one
that does less.

- **Certificate revocation is not checked.** Node performs no CRL or OCSP lookup,
  so a revoked certificate is reported as a valid chain. The output says
  `revocationChecked: false` rather than implying otherwise.
- **Some registries publish no expiry date.** `.de`, `.nl`, `.no`, `.au` and
  `.fi` do not publish one over any protocol. The result names the registry and
  says so, instead of showing an indefinite "unknown". Registration data comes
  from RDAP only; there is no WHOIS fallback, and
  [`docs/adr/0004`](docs/adr/0004-rdap-without-whois.md) explains why.
- **DNSSEC is not validated.** The tool reports whether a delegation is signed
  and where it learned that. It never claims to have validated a chain.
- **Response time includes connection setup.** It is wall clock to the first
  response headers, covering DNS, TCP and TLS, so it is not a measure of server
  processing time.
- **`seo_audit` audits one page, not a site.** It requests the page's internal
  links to find broken ones, but it does not crawl: there is no second level.
  Auditing a site means calling it for the pages that matter.
- **The sitemap check is structural, not a schema validation.** It establishes
  that the document exists, declares `<urlset>` or `<sitemapindex>`, and how
  many `<loc>` entries it holds. It does not validate against the sitemaps.org
  schema, and it does not open a gzipped sitemap.
- **Nothing here judges how a page ranks.** `seo_audit` reports what is in the
  HTML. Rankings depend on things no public endpoint exposes.
- **"What changed since last time" lasts as long as the server process.** The
  previous run is held in memory and never written to disk, so a restarted
  server has nothing to compare against — and says so, rather than implying
  nothing changed. Only sites both runs measured the same way are compared, so a
  quick uptime-only pass never invents regressions in the run after it.
  [`docs/adr/0011`](docs/adr/0011-in-memory-run-history.md) explains the trade.
- **Certificates and domains are judged on different clocks.** A registration is
  a warning inside 30 days; a certificate only inside 14. ACME clients renew with
  30 days left, so warning that early would fire on nearly every healthy site.

## Documentation

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development setup, and how to add a tool
- [`docs/architecture.md`](docs/architecture.md) — how a request flows, and how it
  is tested without a network
- [`docs/adr/`](docs/adr/) — one short record per structural decision
- [`SECURITY.md`](SECURITY.md) — threat model and reporting policy
- [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT — see [LICENSE](LICENSE).
