# 4. Registration data from RDAP only, with WHOIS deferred

Status: accepted (2026-08-31)

## Context

The brief specified "RDAP, with a WHOIS fallback". Investigating what that fallback
would actually buy changed the picture.

**The gap is a data gap, not a protocol gap.** `.de`, `.nl`, `.no`, `.au` and `.fi`
publish no expiry date over _either_ protocol. WHOIS recovers none of them.

**Where WHOIS does carry expiry, it is unparseable in general.** One query per
registry, same day, produced five field spellings and four date formats — `.pt` as
`Expiration Date: 28/02/2027 23:59:00` in DD/MM/YYYY, `.it` as `Expire Date:` in
ISO, `.jp` as `[有効期限] 2027/05/31`, plus `expires:` and `Expires:`. Two of ten
registries refused a single query outright. Every registry is a bespoke parser and a
standing maintenance cost.

**A bundled server table is now a security liability.** ICANN's _Rogue WHOIS Server
Exploit_ advisory (2025-01-24) documents decommissioned WHOIS hostnames being
re-registered by attackers, and warns that many clients ship stale server lists.
That is a poor fit for a tool whose entire argument is public data and nothing
intrusive.

RDAP coverage measured against the IANA bootstrap registry (publication 2026-07-23):
1,200 of 1,438 TLDs — effectively every gTLD, and 70 of 248 ccTLDs.

## Decision

RDAP only in v0.1.0. `domain_check` reports
`registration.source: 'rdap' | 'unavailable'`, and when unavailable it says why in
plain words — _"the .de registry does not publish expiry dates"_ — rather than
showing an indefinite `unknown`.

RDAP servers are resolved from the IANA bootstrap file locally per RFC 9224, not
through the `rdap.org` redirector: the redirector is bootstrap-driven and so 404s on
exactly the TLDs the bootstrap lacks, while routing every client domain through a
third party.

A small commented override map covers `.io`, which serves RDAP with expiry data but
is absent from the bootstrap file.

WHOIS is deferred, not abandoned.

## Consequences

- No WHOIS dependency, no port-43 client, no per-registry parsers.
- Some ccTLD portfolios get no expiry date. The tool names which registry and why,
  which is more useful than a silent blank.
- The README limitations section states this as a deliberate choice.
- Bootstrap matching is label-wise longest match, right to left (RFC 9224 §4) —
  never `endsWith`, since the entries `com` and `goodexample.com` both exist and
  `example.com` must match only `com`.
