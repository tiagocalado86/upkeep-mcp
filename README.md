# upkeep-mcp

An MCP server for the recurring checks behind ongoing website maintenance:
domains, SSL certificates, uptime, technical SEO and accessibility — all from
publicly available information.

Built for people who look after a portfolio of client sites on a retainer, not
just a single domain. The goal is to answer one question quickly: **what needs
attention this week?**

## Status

Early development, built in public phase by phase. The three checks that need no
browser are implemented and useful today.

| Tool                  | Purpose                                                                     | Status    |
| --------------------- | --------------------------------------------------------------------------- | --------- |
| `domain_check`        | Registration expiry, registrar, nameservers, DNS records, DNSSEC delegation | Available |
| `ssl_check`           | Certificate expiry, issuer, chain validity, SAN coverage, TLS version       | Available |
| `uptime_check`        | HTTP status, response time, redirect chain, HTTPS upgrade, security headers | Available |
| `health`              | Server name, version, Node.js version, uptime                               | Available |
| `seo_audit`           | Title, meta, headings, canonical, robots.txt, sitemap, broken links         | Planned   |
| `accessibility_audit` | WCAG violations via axe-core                                                | Planned   |
| `portfolio_report`    | All of the above across a portfolio, sorted by urgency                      | Planned   |

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
- **`uptime_check` fetches one page, not a site.** Crawling arrives with
  `seo_audit`.

## Documentation

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development setup, and how to add a tool
- [`docs/architecture.md`](docs/architecture.md) — how a request flows, and how it
  is tested without a network
- [`docs/adr/`](docs/adr/) — one short record per structural decision
- [`SECURITY.md`](SECURITY.md) — threat model and reporting policy
- [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT — see [LICENSE](LICENSE).
