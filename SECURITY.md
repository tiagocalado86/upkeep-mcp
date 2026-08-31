# Security Policy

## Supported versions

`upkeep-mcp` is in early development and has not had a tagged release yet.
Until `v0.1.0` ships, only the `main` branch is supported.

| Version       | Supported |
| ------------- | --------- |
| `main`        | ✅        |
| Anything else | ❌        |

## Reporting a vulnerability

Please report security issues privately, not in a public issue.

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**
(<https://github.com/tiagocalado86/upkeep-mcp/security/advisories/new>).

Include, as far as you can:

- what the issue is and why it matters,
- the steps or input needed to reproduce it,
- the affected file, tool or commit,
- any suggested fix.

You can expect an acknowledgement within 7 days and a fix or a decision within
30 days. If a report is valid you will be credited in the advisory, unless you
prefer otherwise.

## Threat model

This server is designed so that a compromise of it leaks nothing worth having.
The following are project rules, not aspirations — a feature that breaks one of
them does not get merged.

**It never handles credentials.** No API keys, no tokens, no passwords, for any
service, ever. There is nothing to steal from its configuration and nothing to
leak from its memory.

**It reads only public information.** Everything it inspects is what any person
with a browser or a DNS resolver could read: DNS records, RDAP registration
data, TLS certificates presented by a public endpoint, HTTP response headers,
and public page content. Registration data comes from RDAP only — there is no
WHOIS fallback, and
[`docs/adr/0004`](docs/adr/0004-rdap-without-whois.md) explains why.

**It tells you who else learns what you checked.** Running a check discloses the
target to whoever answers for it, which is unavoidable, so the list is short and
written down rather than left implicit:

| Contacted                  | What it learns         | Why                                                                       |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| The target host itself     | That it was requested  | `ssl_check` and `uptime_check` connect to it                              |
| `data.iana.org`            | Nothing about a domain | The RDAP bootstrap file, fetched at most once per process                 |
| The registry's RDAP server | The domain             | It is the registry for that domain and already holds the record           |
| `cloudflare-dns.com`       | The domain             | `node:dns` cannot query DS at all, so DNSSEC delegation is asked over DoH |

Nothing else is contacted, no analytics or telemetry is sent anywhere, and every
request carries a `User-Agent` naming this project and linking to it.

**It is not an offensive tool.** No port scanning, no subdomain
brute-forcing, no vulnerability probing, no attempt to bypass authentication or
access controls. It inspects public configuration and reports on it.

**It behaves politely on the network.** `robots.txt` is respected on any page
crawl, requests are rate-limited per host, concurrency is bounded, every network
operation has an explicit timeout, and the `User-Agent` identifies the tool with
a contact URL.

**It keeps no sensitive state.** Caching is in memory or in a local file with a
TTL. There is no database and no persistent record of what was checked.

## Scope

In scope for a report:

- a way to make the server handle, store or transmit credentials,
- a way to make it act on a target beyond what its documented inputs allow
  (SSRF, request smuggling, unbounded redirect following),
- a crash, hang or resource exhaustion triggered by hostile input or a hostile
  remote host,
- leaking one user's data into another's results on the public HTTP demo.

Out of scope:

- vulnerabilities in the sites you point the tools at — that is what they are
  for,
- missing hardening on a site reported by `uptime_check` or `seo_audit`,
- issues in third-party dependencies with no exploitable path through this
  code; report those upstream.
