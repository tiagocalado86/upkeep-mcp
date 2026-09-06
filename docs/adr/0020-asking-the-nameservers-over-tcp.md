# 20. Ask a zone's nameservers directly, over TCP, with a hand-written message

Status: accepted (2026-09-07)

## Context

Everything else in this project asks a recursive resolver. A resolver answers
with whatever one authoritative server told it, and does not say which one. Two
questions a maintenance retainer is judged on cannot be answered that way:

- **Is every nameserver in the delegation actually serving the zone?** A server
  decommissioned after a migration and left in the NS set answers `REFUSED`, or
  its own hostname stops resolving. Resolvers keep trying it for as long as it
  is listed, and every query that lands there is slow or fails. Nothing about
  this is visible through a resolver, which simply asks one of the others.
- **Do the nameservers agree?** A zone edited on one server and never
  transferred to the rest resolves correctly for some visitors and not others,
  intermittently. It is the hardest kind of outage to be told about by a client
  and one of the easiest to see, if you ask each server for its SOA serial.

`node:dns`'s `Resolver` cannot ask either. `setServers` points it at a specific
address, but it sends **UDP**, which `docs/deploying.md` records does not leave
Cloud Run — the platform this server is deployed on — and it exposes no `AA`
flag, so an answer a server is authoritative for cannot be told from one it
merely repeated. DNS-over-HTTPS does not help: a DoH endpoint is itself a
recursive resolver, and there is no way to ask it what some other server holds.

## Decision

Speak DNS to each nameserver directly, over **TCP port 53**, with a message
built and read in this repository (`src/lib/dns-wire.ts`). One SOA query per
nameserver, recursion off, every server asked in parallel.

TCP because it is the transport that leaves every platform this is deployed to,
and because a TCP answer is never truncated into a second round trip. The wire
format is hand-written for the same reason `der.ts` is: it parses bytes a
stranger's server chose, which is the worst possible place for a dependency, and
DNS messages are a small closed grammar — a header, a question, records, and
name compression.

**This opens a third port on the public instance**, which until now contacted
443 and 80 only and said so in four places. The destination is not a caller's to
choose: it is whatever the target domain's own NS records name, resolved and put
through the same public-target guard as every other destination — an NS record
pointing at `169.254.169.254` is exactly why that guard is not optional — and
the question asked is fixed. `PUBLIC_PORTS` in `src/lib/public-target.ts` is
still the whole list of what may be opened.

## Consequences

- Lame delegations and disagreeing nameservers are reported, with the serial
  each server holds. Neither was visible before at any price.
- **What is a fault and what is merely unestablished are graded apart**, and
  getting this wrong would have been worse than not shipping it. A resolver
  asks over UDP first; this server can only use TCP. So a nameserver that
  refuses TCP is **not** broken — `sapo.pt`'s four all refuse it and the domain
  resolves perfectly — and is reported as `info`, or as `unknown` when it is
  true of every one of them. A nameserver whose hostname does not resolve, or
  that answers without authority, is broken for every resolver on the internet
  and is a `warning`.
- **Serials disagreeing is `info`, not a warning.** Two ordinary things produce
  it: a domain served by two providers that do not transfer between them —
  `github.com`'s NS1 servers report `1656468023` while its Route 53 servers
  report `1`, and Route 53 always reports `1` — and a zone changed a minute ago,
  which is what `gov.uk` was doing when this was written, its two sets 301
  apart and equal again later. A transfer stuck for a week is real and is worth
  reporting; it cannot be told from the other two in one snapshot, so the report
  says what it saw and what it means rather than grading a guess.
- Both of those gradings came from running the check against real domains. On
  fixtures every one of them would have read as a fault.
- One question, to at most eight nameservers, in parallel, on a five-second
  deadline, through the same per-host limiter as everything else, cached for as
  long as any other DNS answer. `checkNameservers: false` turns it off.
- **The parent's delegation is deliberately not compared.** "The NS records at
  the registrar differ from the NS records in the zone" is the other classic
  delegation fault, and answering it means querying the parent zone's servers
  for a referral — a second hop, a second set of failure modes, and a different
  feature. What is here compares the zone's own servers with each other.
- Nothing is validated cryptographically. DNSSEC is still reported from the
  delegation only, exactly as `README` says.
