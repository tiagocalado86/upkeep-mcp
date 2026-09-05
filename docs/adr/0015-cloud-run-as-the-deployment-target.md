# 15. Cloud Run as the deployment target

Status: accepted (2026-09-03)

## Context

Phase 4 puts the tools behind a public HTTP endpoint. Somebody has to run it,
and the choice was never written down — it lived in `docs/deploying.md` mixed in
with instructions, which is how a decision quietly becomes a habit.

What the code needs is narrower than "somewhere to run Node", and the narrowness
is the whole argument:

- `src/lib/tls.ts` calls `tls.connect()` with `rejectUnauthorized: false` and
  reads `socket.getPeerCertificate(true)`. Refusing to validate is not an
  oversight, it is the point: `ssl_check` exists to describe expired and
  self-signed certificates, which a validating client will not complete a
  handshake with.
- `src/lib/dns.ts` builds a `node:dns` `Resolver`, which speaks UDP to port 53.
- Outbound HTTP and HTTPS to arbitrary public hosts, on 80 and 443.
- A request that may run for two to four minutes, because that is what a
  `portfolio_report` over twenty sites costs at this project's own rate limits.
- As close to free as possible. This is a portfolio demo, not a service.

## Decision

Google Cloud Run, from the existing `Dockerfile`, in a European region.

## Consequences

- **Cloudflare Workers is not a candidate, and the reason is `ssl_check`.**
  `workerd` refuses `rejectUnauthorized: false` outright with
  `ERR_OPTION_NOT_IMPLEMENTED`, so the connection never opens; had it opened,
  `getPeerCertificate()` and `getPeerX509Certificate()` both throw "not
  implemented". Cloudflare's own Node-compat survey lists them as gaps with no
  ship date. `crypto.X509Certificate` _is_ implemented, so the parsing half
  would work — what is missing is any way to obtain the bytes.
- An earlier version of this reasoning said DNS was a second blocker there. It
  was wrong: `workerd` implements `node:dns` as a DoH client against
  `cloudflare-dns.com`, and this project's record mapping would work unchanged.
  The real second break is smaller and sharper — `Resolver.cancel()` throws, and
  `withDeadline` calls it from inside a `setTimeout`, so the throw would escape
  the promise chain and cross the MCP boundary that `guard` exists to close.
- Cloudflare Containers would run this image, with a real kernel and real
  sockets, but has no free tier — Workers Paid at $5/month — plus Durable Object
  billing and a Worker to write as a router. Its `interceptHttps` option
  installs a Cloudflare CA in the container, which would make `ssl_check` report
  Cloudflare's synthetic certificate as though it were the client's. A wrong
  answer delivered confidently is the worst failure this project has.
- **AWS Lambda was the real rival and lost on shape, not capability.** Node 22
  is Node 22 there and everything works, and its free egress allowance is better
  than Google's. But `node:22-alpine` does not speak the Lambda Runtime API, so
  it needs the Lambda Web Adapter or a rewritten handler. App Runner would have
  avoided that and is disqualified twice over: closed to new customers since
  April 2026, and a fixed 120-second request timeout that a `portfolio_report`
  would exceed.
- Timeouts eliminated most of the rest. Azure Container Apps cuts idle
  connections at 230 seconds and Railway at five minutes; both sit inside the
  worst case rather than outside it. Render's free tier cold-starts for about a
  minute, which is the experience of nearly every first visitor. Oracle's
  always-free tier reclaims instances under 20% utilisation, which describes a
  quiet demo exactly.
- **Fly.io is the fallback**, at roughly $24/year rather than nothing. It builds
  this `Dockerfile` unchanged and documents outbound UDP more clearly than
  anyone else.
- **Outbound UDP to the internet does not leave Cloud Run**, and the platform
  resolver — which is all `dns.ts` uses, because it never calls `setServers` —
  answers most of what this project asks it. **Most, not all: measured on the
  deployed instance, it does not answer record type 257.** A, AAAA, NS, MX and
  TXT come back correct; CAA comes back empty for `google.com` and `github.com`,
  both of which demonstrably publish it. `dns.ts` therefore asks
  DNS-over-HTTPS for CAA whenever the resolver returns none, so the hosted
  instance answers the same question the local one does. `docs/deploying.md`
  carries the warning where someone will meet it, and it still applies with full
  force to any future authoritative lookup.
- Cold start is around half a second for a container of this shape, of which
  roughly 350ms is platform floor. Nothing in `src/lib/` opens anything at
  import time and `ports.ts` builds its caches lazily; that is worth keeping,
  because module-scope work is what turns a half-second cold start into a
  forty-second one.
- `--execution-environment gen1` is pinned, and it is the least-supported
  decision here. Networking is a tie — gVisor implements a full userspace
  netstack, UDP included, and `tls.connect()` is an ordinary TCP socket — so
  cold start decides, and the cold-start evidence for gen1 is suggestive rather
  than controlled. It is one flag.
- **None of this is load-bearing.** The server reads no environment variables (a
  test enforces it), holds no secrets and imports no vendor SDK. What gets
  deployed is an OCI container that runs unchanged on Fly, Render, ECS or Azure
  Container Apps. This is not a choice of provider so much as a choice of where
  to point an artefact that already exists, which is why it did not deserve more
  deliberation than it got.

## What would reopen this

- A Worker that can read a peer certificate. Cloudflare's edge placement and
  zero cold start would matter if `ssl_check` could work there; the test is two
  minutes of work against a live Worker.
- Needing `setServers` — authoritative DNS queries, DNSSEC beyond the DoH path
  `dns.ts` already uses for DS records. That breaks on Cloud Run specifically,
  and Fly is the near neighbour that survives it.
- Wanting `accessibility_audit` in the demo. That needs a browser in the image,
  which changes the size, the cost and the attack surface all at once
  ([`0013`](0013-playwright-core-and-an-optional-browser.md)).

## What the field test found

The check this section used to ask for has been run, against the first deployed
instance, on 2026-09-05 — and it failed, which is why it was worth asking for.

A, AAAA, NS, MX and TXT came back populated. **CAA came back empty**, for both
`google.com` (`0 issue "pki.goog"`) and `github.com` (seven records). Running
`resolveRecords` on a laptop returned the record, so neither the query nor the
mapping was at fault: the platform resolver does not answer for type 257.

The failure mode is the one this ADR predicted for a different cause. `optional()`
turns any failed query into an empty result, and an empty CAA set is exactly what
a domain publishing no CAA looks like — so the hosted instance was reporting
every client as unprotected against mis-issuance, in the shape of a clean answer.

What could not be established is _how_ the resolver declines: NOTIMP, SERVFAIL
and an empty NOERROR are indistinguishable from outside a deployed instance.
The fallback in `dns.ts` is therefore keyed on an empty answer rather than on an
error code — see `resolveCaaRecords` for what that costs.

The general lesson stands and is worth restating: a platform's DNS behaviour is
not a single fact, and "the resolver works" is not a finding. Ask it for each
record type the project depends on.
