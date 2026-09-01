# 12. Refusing private targets is the entrypoint's job, not the checks'

Status: accepted (2026-09-01)

## Context

Every check here takes a host or a URL from its caller and connects to it. That
is the entire product.

Run over stdio, the caller is the person who started the process, on their own
machine. Pointing the tool at `192.168.1.10` is not an attack, it is a staging
box someone maintains — exactly what a maintenance tool is for.

Phase 4 puts the same tools behind a public HTTP endpoint, and the same
behaviour becomes something else. A stranger can ask a server running in a cloud
to fetch `http://169.254.169.254/latest/meta-data/` and read back the instance's
own credentials. They can walk a private network the server happens to sit in.
They can scan ports on a third party, from an address that is not theirs, with a
`User-Agent` naming this project — and every hosting provider's acceptable use
policy makes that the operator's violation, not the visitor's.

Nothing in the code refused any of it: `normaliseUrl` accepted any host, and
`ssl_check` accepted any port.

## Decision

The restriction is a property of the entrypoint, not of the checks. It lives at
the I/O boundary — `createDefaultPorts({ publicTargetsOnly })` — so no tool
knows it exists and no tool can bypass it.

Off by default, which keeps the local operator's authority over their own
network. On for the HTTP entrypoint, where it refuses any target that resolves
outside public unicast space, and any port but 443.

## Consequences

- One place to audit, one place to change. A tool added later inherits the
  policy without knowing about it.
- A name is checked against **every** address it resolves to. Answering with one
  public and one private address is the standard way past a check that stops at
  the first.
- A literal address is judged without a lookup: resolving `127.0.0.1` would fail
  rather than answer, and the failure would read as an unreachable host instead
  of a refused one.
- The public deployment cannot check a certificate on port 8443, and says so
  rather than failing obscurely. That is a real loss of function, accepted
  because the alternative is running a port scanner for strangers.
- The port rule is per scheme: 443 over HTTPS, 80 over plain HTTP. Port 80 is
  allowed because `uptime_check` exists partly to answer "does plain HTTP still
  answer, and does it upgrade?", which cannot be asked over 443. Two web ports
  is not a port scan.
- **The port check applied to the TLS path alone until 2026-09-01.** `hop`,
  `text` and `robots` called `assertPublic` and nothing else, so a public
  instance would have fetched `https://any-host:22/` and reported back whether
  the connection was refused — the port scan this ADR says it prevents,
  available with no DNS trickery at all, while three documents claimed port 443
  only. Every outbound path now goes through one helper that checks host and
  port together, and `test/lib/ports.test.ts` asserts it for each of them. The
  lesson is the one this project keeps relearning: a policy is only in force
  where it is wired in, and the test that would have caught this had to assert
  the _wiring_, not the policy.
- **The gap this leaves, stated plainly: the address is checked and then the
  request is made by hostname, so a resolver that answers differently the second
  time defeats it.** Closing that means pinning the connection to the address
  that was checked, through a custom dispatcher. It is the right fix and it is
  not done; until it is, the guard raises the cost of abuse rather than removing
  it, and a public instance should be treated as untrusted by whatever network
  it runs in.
- **Why that gap is accepted on Cloud Run specifically**, rather than closed
  before deploying: the prize behind it is not there. Google's metadata server
  requires a `Metadata-Flavor: Google` header on every request and retired the
  header-free endpoints in 2020; this project sends a fixed header set and has
  no injection path, so a rebound request to `169.254.169.254` gets a 403 and no
  credential. The deployment in `docs/deploying.md` has no VPC connector and no
  Direct VPC egress, so private ranges have no route out of the instance at all.
  What remains is a blind fetch into an empty network. Against that, closing it
  means a runtime dependency on undici, a second hand-written redirect loop, a
  hand-rolled replacement for happy-eyeballs address fallback, and the loss of
  the offline test seam — in a project whose worst possible output is a false
  "this client's site is down". **This reasoning is platform-dependent and does
  not survive attaching a VPC connector, or moving to a host whose metadata
  service is not header-gated.** If either happens, close the gap first.
