# 6. Inject I/O ports; never mock a Node builtin

Status: accepted (2026-08-31)

## Context

The default test suite must make no network calls, and no tool may perform I/O
directly. That leaves the question of how tests substitute the I/O.

`vi.mock('node:tls')` couples a test to the sequence of calls into a builtin rather
than to this project's own contract, and leaves "no tool performs I/O directly"
as a convention rather than a structural fact.

## Decision

Three layers, in order of how much they carry:

1. **Pure functions need no seam.** Parsing and scoring — `parseRdapDomain`,
   `summariseChain`, `parseHsts`, `expirySeverity` — are plain functions tested
   against recorded payloads. This is where the edge cases live.
2. **Anything going through `fetch`** (RDAP, DoH, uptime) is tested with undici's
   `MockAgent` plus `disableNetConnect()`. It intercepts the global `fetch` the code
   actually uses, and an unmatched request fails loudly instead of escaping to the
   network.
3. **`node:dns` and `node:tls`** are reached only through the `DnsClient` and
   `TlsProbe` interfaces in `src/lib/ports.ts`. Tools take a ports object with a
   lazily constructed real default; tests pass fakes.

## Consequences

- `server.ts` still calls `registerDomainCheckTool(server)` and stays logic-free.
- The rule that tools never do I/O is enforced by types, not by review.
- `undici` is a devDependency: `node:undici` is not a builtin, so `MockAgent` has to
  be installed even though the runtime uses the bundled copy.
- Default port implementations are constructed lazily, so importing a tool module
  opens no sockets.
