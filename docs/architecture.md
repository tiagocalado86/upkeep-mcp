# Architecture

How a request flows, why the code is split the way it is, and how it is all
tested without a network.

## The shape

```
src/
  index.ts      entrypoint: serves MCP over stdio
  server.ts     builds the McpServer and registers tools; no logic of its own
  tools/        one file per tool: schemas, findings, and the human summary
  lib/          everything that touches the network, plus the pure helpers
  types.ts      the vocabulary the tools share
```

Two rules hold the structure together.

**No tool performs I/O directly.** A tool receives a `Ports` object
(`lib/ports.ts`) and reaches DNS, RDAP, TLS and HTTP only through it. This is not
a convention: the interfaces are the only thing a tool can see, so the compiler
enforces it.

**No exception crosses the MCP boundary.** Every handler is wrapped in `guard`
(`lib/tool-result.ts`). A failure becomes a result with `isError: true` and an
actionable message. A server that crashes on one bad input is a server nobody can
rely on.

## How a request flows

Take `domain_check` for `https://www.shop.example.co.uk/basket`.

1. **The SDK validates the input** against the Zod schema before the handler
   runs. A wrong type never reaches project code.
2. **`parseTarget`** (`lib/domain-name.ts`) reduces the URL to a hostname,
   converts it to A-labels, and derives the registrable domain — `example.co.uk`,
   which is what a registration is actually a property of. Internationalised
   names are converted here and only here, because `tls.connect` rejects the
   Unicode form that `node:dns` accepts.
3. **Registration and DNS are gathered concurrently** through the ports, each
   behind its own cache and, where a third party is involved, a per-host rate
   limiter.
4. **They degrade independently.** A registry that is down does not hide the DNS
   records; DNS that times out does not hide the expiry date. Only losing both is
   a failure.
5. **DNSSEC prefers the registry's own answer.** `secureDNS.delegationSigned`
   arrived with the registration and is the parent zone's own view. Only when it
   is absent is a DNS-over-HTTPS query worth making.
6. **Findings are collected, sorted worst first, then reduced to one severity** —
   the worst present. The order is part of the contract, not an accident of the
   order things were detected in: `portfolio_report` will concatenate findings
   from every check across a whole portfolio and needs them to arrive ranked. A
   partial answer is a success with a gap explained, never an error.
7. **The result carries both halves**: text for the person reading the
   conversation, and `structuredContent` validated against the output schema.

`ssl_check` and `uptime_check` follow the same shape.

`portfolio_report` sits on top rather than beside: it calls the same checks
through a second entry point on each tool (`check*ForPortfolio`), which returns
the report itself instead of an MCP result. That is why the tools split
"gather the report" from "render a result" — reading a report back out of a
`CallToolResult` would mean parsing our own output.

`seo_audit` adds one step in front of all of them: it reads `robots.txt` and
obeys it before requesting anything, including before requesting each internal
link it would otherwise check. A page it is not allowed to read produces a
report saying so, never a report built from a request that should not have been
made. An unreadable `robots.txt` is treated as a refusal, per RFC 9309 §2.3.1.

## Why the pieces are where they are

**`lib/` splits into I/O and pure logic.** `dns.ts`, `tls.ts`, `rdap.ts` and
`http-client.ts` make requests. `severity.ts`, `http-headers.ts`, `json.ts` and
`domain-name.ts` do not — they are plain functions over data. Almost every
awkward real-world case lives in the second group, which is why most of the test
suite needs no network at all.

**Caches hold promises, not values.** Twenty domains checked at once collapse
into one request per registry rather than twenty. A failed load is never cached,
so a blip does not poison an entry for its whole lifetime.

**The rate limiter is keyed by the host actually contacted.** Twenty `.com`
domains all reach `rdap.verisign.com`. A limiter keyed on the domain being asked
about would appear to work and pace nothing.

**Timeouts are explicit everywhere** and gathered in `lib/defaults.ts` so the
numbers a report depends on can be reviewed together. Two of them cannot use the
obvious mechanism: `node:dns` ignores `AbortSignal` entirely and its `timeout`
option is per attempt with exponential backoff, so DNS is raced against a timer
that calls `resolver.cancel()`; and `tls.connect`'s `timeout` option emits an
event without destroying the socket, so TLS destroys it explicitly.

## Testing without a network

Three layers, in order of how much they carry.

1. **Pure functions, tested directly** against recorded payloads: parsing an RDAP
   response with a timezone offset or a bare date, an HSTS header that disables
   the policy, a CAA record whose tag is the property name.
2. **Anything going through `fetch`** — RDAP, DNS-over-HTTPS, uptime — uses
   undici's `MockAgent` with `disableNetConnect()`. It intercepts the same global
   `fetch` the code really uses, and a request nobody intercepted fails loudly
   instead of escaping to the network.
3. **`node:dns` and `node:tls`**, which `MockAgent` cannot reach, are behind the
   `DnsClient` and `TlsProbe` interfaces. Tests pass fakes.

Nothing mocks a Node builtin. Mocking one would couple the tests to the sequence
of calls into someone else's module rather than to this project's own contract.

A separate suite in `test/integration/` makes real requests against public
control targets — an expired certificate, a chain missing its intermediate, a
domain that does not resolve, a registry that publishes no expiry date. It runs
with `npm run test:integration` and stays out of CI, so a third party's outage
never fails a build.

## What is deliberately absent

No database and no cache file (`docs/adr/0005`). No WHOIS (`docs/adr/0004`). No
revocation checking — Node performs no CRL or OCSP lookup, so a revoked
certificate verifies cleanly, and the output says so rather than implying
otherwise. No DNSSEC validation: the tool reports whether a delegation is signed
and where it learned that, and never claims to have validated a chain.
