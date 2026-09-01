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
- **The gap this leaves, stated plainly: the address is checked and then the
  request is made by hostname, so a resolver that answers differently the second
  time defeats it.** Closing that means pinning the connection to the address
  that was checked, through a custom dispatcher. It is the right fix and it is
  not done; until it is, the guard raises the cost of abuse rather than removing
  it, and a public instance should be treated as untrusted by whatever network
  it runs in.
