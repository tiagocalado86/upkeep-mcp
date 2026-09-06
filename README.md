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
| `portfolio_report`    | All of the above across a portfolio, sorted by urgency                      | Available |
| `accessibility_audit` | WCAG violations via axe-core, in a real browser                             | Available |

It also exposes the `portfolio://sites` resource (the site list, for a client to
read without spending a tool call) and the `quarterly_report` prompt (turns a
portfolio run into the report a client actually reads).

Published on npm, so it installs with one command — see
[Installation](#installation). A public instance is also running, for anyone who
would rather point a client at a URL than run anything — see
[The hosted instance](#the-hosted-instance).

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
Revocation not established: http://ocsp.comodoca.com could not answer: the
responder is not authorised to answer for this certificate.

Needs attention:
- [critical] The certificate expired 4159 days ago.
- [critical] The certificate chain does not verify: CERT_HAS_EXPIRED.
```

```
> Check the certificate on revoked.grc.com

revoked.grc.com:443 certificate expires 2026-10-18 (42 days).
Issued by Certera RSA DV SSL CA 2.
Chain verifies. Negotiated TLSv1.2.
Host matched via revoked.grc.com.
Revoked on 2025-09-18.

Needs attention:
- [critical] The certificate was revoked on 2025-09-18; browsers that check
  revocation will refuse the site.
```

Note what the second one does: the chain **verifies**. Node performs no
revocation lookup of its own, so that certificate completes a handshake and
reports as trusted. Only asking its issuer finds the problem.

Every tool also returns structured data alongside the text, so results can be
sorted, filtered and fed into a report. Full input and output for each tool is in
[`examples/`](examples/), and a whole portfolio session — the weekly triage, a
drill-down, and what the comparison against the previous run will and will not
claim — is in [`examples/conversation.md`](examples/conversation.md).

## The tools

### `domain_check`

Input: `domain` — a bare domain, a full URL, or an internationalised name. A
subdomain is reduced to its registrable domain, since that is what a registration
belongs to.

Returns the expiry date and days remaining, the registrar and its IANA ID,
registry statuses, A/AAAA/NS/MX/TXT/CAA records, whether the apex and `www`
resolve, whether the delegation is signed with DNSSEC, and what the domain's SPF
and DMARC records say about who may send email as it.

Email authentication is read from the domain's own DNS — the SPF record at the
apex, the DMARC record at `_dmarc`. A record that is **absent** is reported as
information, because it is a standing improvement rather than something that
broke this week. A record that is **present and wrong** is a warning, because it
fails right now: two SPF records make receivers skip SPF entirely, and `+all`
authorises the whole internet to send as the domain.

DKIM is deliberately not reported. A DKIM key lives at `<selector>._domainkey`,
and a selector cannot be discovered — only guessed, one DNS query per guess.
That is subdomain enumeration, which this project does not do, so a domain with
no DKIM and one whose selector was not guessed are left indistinguishable rather
than the second being reported as the first.

### `ssl_check`

Input: `domain`, optional `port` (443 by default).

Returns expiry and days remaining, issuer, whether the chain verifies and why not
when it does not, which hostnames the certificate covers and via which SAN entry,
the negotiated TLS version and cipher, and whether the certificate has been
revoked. Expired, self-signed and untrusted certificates are inspected and
reported rather than refused — those are the ones worth finding.

Revocation is checked over OCSP. The response a server staples to the handshake
is preferred, because it costs no request at all; when there is none, the
responder named in the certificate is asked directly. An answer is only believed
once its signature verifies against the issuing authority, and only once its
`CertID` is shown to be about the certificate that was actually served — a server
serving a revoked certificate alongside a valid response for a different one is
otherwise the easy way to fake a clean result.

Many healthy certificates cannot be checked at all: since 2025 the two largest
issuers, Let's Encrypt and Google Trust Services, publish no OCSP responder and
distribute revocation by CRL. That is reported as an `unavailableReason` and
produces **no finding**, because it is a decision of the certificate authority
and nothing the site owner can act on. A responder that was asked and would not
answer is different, and gets one `unknown`.

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

No change is reported: this server has not run a report on this portfolio before,
and the portfolio names no history file, so nothing survived the last restart.
History for this portfolio is kept in memory only. To compare across restarts,
add a "history" path to the portfolio file.

Nothing to do: Example Foundation.
```

**Comparing across restarts.** By default the previous run lives in this server
process and nowhere else, so a client that restarts daily gets a comparison that
never spans more than a day — and a quarter-over-quarter report cannot be
produced from it at all. Add one line to the portfolio file:

```json
{ "version": 1, "history": "upkeep-history.json", "sites": [...] }
```

and the run is written there instead, beside the portfolio file itself. The next
report compares against it however many restarts later, up to ninety days. The
file names your clients and says which were broken, so it is created readable by
your account alone and replaced on every run; without that line nothing is
written at all.
[`docs/adr/0018`](docs/adr/0018-opt-in-history-file.md) records the reasoning.

Each site can set `maxLinks` — how many internal links the `seo` check may
request, `0` for none. It is the setting that decides what a run costs: measured
over twenty sites, the portfolio takes about eight seconds without `seo` and
around forty with it, because link checking is one request per link paced at
half a second per host.

The portfolio file format is documented in
[`sites.example.json`](sites.example.json). Copy it to `sites.json` — which is
gitignored, so a real client list never gets committed. `file` is resolved
against the directory the client started the server in, so give the full path
when that directory is not yours.

### `accessibility_audit`

Input: `url`, plus optional `standard` (`wcag2aa` by default; also `wcag2a`,
`wcag21aa`, `wcag22aa`, `best-practice`).

Opens the page in a headless browser and runs axe-core over it. Returns the
rules that failed, how many elements failed each, CSS selectors for the first
few, and how many rules axe could not decide on its own.

This is the only tool that needs a browser, and it is optional: nothing is
downloaded when you install this project. Run `npx playwright install chromium`
once if you want it. Without it the tool says so and names that command, and
every other check carries on.

Automated rules find roughly a third of accessibility problems. A page with no
violations passed the machine-checkable part, which is not the same as being
usable — which is why the count of undecided rules is reported alongside.

## Installation

Requires **Node.js 22 or newer**. Nothing else: installing downloads no browser,
and every check works without one except `accessibility_audit`.

### Claude Code

```bash
claude mcp add upkeep -- npx -y upkeep-mcp
```

### Claude Desktop

Add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "upkeep": {
      "command": "npx",
      "args": ["-y", "upkeep-mcp"]
    }
  }
}
```

Restart the client and ask it to run the `health` tool. It answers with the
server version, the Node.js version and how long the process has been up.

A desktop client starts a server in a directory of its own choosing, usually
`/`. That matters for one thing only: `portfolio_report` and the
`portfolio://sites` resource look for `sites.json` there. Pass `sites` inline,
or give `portfolio_report` the full path — `file: "/Users/you/sites.json"`.

### From source

For development, or to run a branch:

```bash
git clone https://github.com/tiagocalado86/upkeep-mcp.git
cd upkeep-mcp
npm install
npm run build
claude mcp add upkeep -- node /absolute/path/to/upkeep-mcp/dist/index.js
```

### The hosted instance

For anyone who cannot or would rather not run a server, there is a public one:

```
https://upkeep-mcp-1080119881249.europe-west1.run.app/mcp
```

Point any MCP client that takes a remote server URL at it — in Claude, as a
custom connector. Opening the host in a browser gives a plain page saying what
it is.

**It is a demo.** No authentication, no availability promise, no support, and it
may be switched off without notice. `npx -y upkeep-mcp` is the supported way to
run this, and it is what you want if these checks matter to your work.

**Every tool works there, `accessibility_audit` included** — the image ships a
browser, and every request that browser makes goes through the same rules as the
rest of the server. Someone who cannot run a server themselves should not get a
weaker tool than someone who can.

One thing genuinely differs, and it is a property of running in public rather
than a compromise: **it contacts only public addresses, and only the web
ports** — 443, or 80 when checking whether plain HTTP upgrades. So it refuses to
check anything on your own network, `localhost` included. Use the stdio server
for those.

### Running your own over HTTP

The transport is the same one the hosted instance uses:

```bash
npm run build
npm run start:http -- --port 8080
```

The HTTP entrypoint is not the stdio one with a socket attached: a stranger is
not the person who started the process, so it applies the address and port rules
above and admits traffic through a per-caller rate limit.
[`docs/deploying.md`](docs/deploying.md) covers running it on Google Cloud Run,
and [`docs/adr/0012`](docs/adr/0012-public-target-guard.md) explains the guard
and what it does not close.

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
  no database. The one file this server ever writes is a portfolio run snapshot,
  and only when a portfolio file names a `history` path for it.
- The only third parties contacted are the ones that hold the answer: the
  registry's own RDAP server, IANA's RDAP bootstrap file, and
  `cloudflare-dns.com` for the one question `node:dns` cannot ask (whether a
  DNSSEC delegation is signed). [`SECURITY.md`](SECURITY.md) lists them and what
  each one learns.

## Limitations

Stated plainly, because a tool that hides what it cannot do is worse than one
that does less.

- **Certificate revocation lists are not downloaded.** Revocation is checked over
  OCSP, and only over OCSP. A CRL is a file of every serial an authority has ever
  revoked — megabytes, fetched to answer one question about one certificate — so
  a certificate whose issuer publishes no responder is reported as unchecked,
  with the reason, rather than being judged from a file this tool declined to
  read. Since 2025 that covers Let's Encrypt and Google Trust Services, which is
  a large share of the web. See
  [`docs/adr/0017`](docs/adr/0017-ocsp-without-crl.md).
- **An OCSP answer is a point in time, not a subscription.** Responders pre-sign
  about a week ahead, so `good` means "not revoked as of `thisUpdate`", and a
  certificate revoked an hour ago may still read as good until the authority
  publishes its next answer. `producedAt`, `thisUpdate` and `nextUpdate` are all
  reported so the age of the answer is visible rather than implied.
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
- **A page nested thousands of levels deep is refused, not audited.** HTML
  parsing costs roughly the square of the nesting depth, so a document built to
  be absurd would block the server for minutes. `seo_audit` measures the depth
  first and reports the refusal.
- **Accessibility is only checked as far as a machine can.** Automated rules
  find roughly a third of real problems. The tool reports what axe could not
  decide rather than counting it as a pass, but no green result here is an
  accessibility statement.
- **Nothing here judges how a page ranks.** `seo_audit` reports what is in the
  HTML. Rankings depend on things no public endpoint exposes.
- **"What changed since last time" lasts as long as the server process, unless
  you ask for otherwise.** By default the previous run is held in memory and
  never written anywhere, so a restarted server — which for a desktop MCP client
  is a daily event — has nothing to compare against, and says so rather than
  implying nothing changed. Adding a `history` path to the portfolio file makes
  the comparison survive a restart, for up to ninety days; nothing is written
  without it. Only sites both runs measured the same way are compared, so a quick
  uptime-only pass never invents regressions in the run after it.
  [`docs/adr/0011`](docs/adr/0011-in-memory-run-history.md) and
  [`docs/adr/0018`](docs/adr/0018-opt-in-history-file.md) explain the trade.
- **Only the previous run is kept, never a series.** Each run replaces the last.
  A trend over quarters is a different feature with a different storage question,
  and it has not been asked for.
- **Certificates and domains are judged on different clocks.** A registration is
  a warning inside 30 days; a certificate only inside 14. ACME clients renew with
  30 days left, so warning that early would fire on nearly every healthy site.

## Documentation

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — development setup, and how to add a tool
- [`docs/architecture.md`](docs/architecture.md) — how a request flows, and how it
  is tested without a network
- [`docs/prior-art.md`](docs/prior-art.md) — the MCP servers that already do parts
  of this, what they do better, and the gap this one fills
- [`docs/deploying.md`](docs/deploying.md) — running the HTTP instance, and what
  is different about it
- [`docs/adr/`](docs/adr/) — one short record per structural decision, including
  why the browser is
  [optional](docs/adr/0013-playwright-core-and-an-optional-browser.md)
- [`SECURITY.md`](SECURITY.md) — threat model and reporting policy
- [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT — see [LICENSE](LICENSE).
