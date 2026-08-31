# 3. Require Node.js 22, not 20

Status: accepted (2026-08-31)

## Context

The brief specified Node.js 20+. Node 20 reached end of life on 2026-04-30; Node 22
is in maintenance and Node 24 is Active LTS.

The checks in Phase 1 sit exactly on that boundary:

| Needed for                    | Node 20   | Node 22           |
| ----------------------------- | --------- | ----------------- |
| `X509Certificate.validToDate` | absent    | v22.10.0          |
| `dnsPromises.resolveTlsa`     | absent    | v22.15.0          |
| `Resolver({ maxTimeout })`    | absent    | present           |
| `undici` (dev)                | `^7` only | `^8` from 22.19.0 |
| `node:punycode` DEP0040       | docs-only | runtime warning   |

Supporting 20 means a hand-written fallback at each of those points.

## Decision

`engines: ">=22"`. CI runs 22.x and 24.x.

## Consequences

- Certificate dates come from `validToDate` rather than from parsing
  `'Apr  9 00:00:00 2015 GMT'` — a format with a double space for single-digit days
  that only V8's non-standard fallback parser handles.
- One fewer CI leg, not one more.
- Anyone still on Node 20 cannot install the package. They are running an
  unsupported runtime; shipping a first release against one would be worse.
- Node 20 disappears from the README, CONTRIBUTING and CLAUDE.md in the same change.
