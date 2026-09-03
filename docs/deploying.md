# Deploying the HTTP instance

The server speaks two transports. `stdio` is what a local MCP client starts on
your own machine, and it is the one you want unless you are publishing a demo.
This page is about the other one.

## What is different about the public instance

A stranger holding the keyboard is not the same as you holding it, so the HTTP
entrypoint is not the stdio entrypoint with a socket bolted on:

- **It contacts only public addresses, and only the web ports.** 443 over
  HTTPS, and 80 over plain HTTP, which is the only way to answer `uptime_check`'s
  question about whether HTTP upgrades. Any other port is refused: an endpoint
  that connects wherever a stranger asks is a port scanner wearing this
  project's name. Anything resolving to loopback, a private range or the
  link-local address where cloud metadata services live is refused with an
  explanation.
  [`docs/adr/0012`](adr/0012-public-target-guard.md) covers why, and what that
  guard still does not close.
- **It admits traffic through a token bucket**: 60 requests a minute per caller
  with a burst of 20, and 8 requests in flight across everyone. A refusal is an
  answer with a reason, not a dropped connection.
- **One process serves every visitor, and the run history lives in that
  process.** Two callers whose portfolio entries carry the same name and URL are
  compared against each other's previous run — which is public information about
  a public site, plus the fact that someone else checked it. Nothing else
  crosses: no portfolio file is read, and nothing is written down. If that is
  not acceptable for a given deployment, run the stdio server instead.
- **It reads no environment variables and holds no secrets.** The port comes
  from `--port`. There is nothing to configure and nothing to leak.

## Locally

```bash
npm run build
npm run start:http -- --port 8080
```

Then point an MCP client at `http://127.0.0.1:8080/mcp`. Opening the root in a
browser gives a plain-text page saying what the service is.

Note that the guard will refuse to check anything on your own network, which
includes `localhost`. That is the entrypoint working; use the stdio server for
local targets.

## On Google Cloud Run

Cloud Run was chosen because it runs an ordinary container: `node:dns`'s
resolver and raw TLS sockets both work, which they do not on edge runtimes.
[`docs/adr/0015`](adr/0015-cloud-run-as-the-deployment-target.md) records the
comparison and what would reopen it.

Its free tier is perpetual and generous for a demo: 2 million requests,
180,000 vCPU-seconds and 360,000 GiB-seconds a month.

```bash
gcloud run deploy upkeep-mcp \
  --source . \
  --region europe-west1 \
  --execution-environment gen1 \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --max-instances 2 \
  --concurrency 20 \
  --timeout 300
```

`--max-instances 2` is a cost ceiling, not a capacity target: the inbound
limiter already caps what one instance will take, and this caps how many
instances a determined caller can conjure.

`--timeout 300` is sized from the slowest thing this server does. A
`portfolio_report` over twenty sites runs five checks at a time, one per host,
half a second apart, each page allowed fifteen seconds — two to four minutes in
the worst case. The platform default is also 300s; naming it here is a note that
the number is load-bearing, and that a larger portfolio needs a larger number.

A European region because the egress argument that once pointed at the United
States does not survive arithmetic. Internet egress is priced by **destination**
continent, at about $0.12/GiB either way, so a US region buys nothing on rate.
The only difference is a free first gibibyte that exists for North American
source regions — and this server pulls rather than pushes, so the bytes it
downloads are ingress and free, while a whole `portfolio_report` goes back as
about 5.6 KB. At the traffic a demo sees, that free gibibyte is worth roughly
half a cent a month. Latency to European targets is worth more.

`europe-southwest1` (Madrid) is nearer still. Confirm it is a Tier 1 region
before choosing it: a Tier 2 region costs 1.4× for compute and burns the free
tier at the same rate.

### Outbound UDP leaves this server one feature from breaking

`domain_check` resolves through `node:dns`'s `Resolver`, which sends UDP to
whatever `/etc/resolv.conf` names. On Cloud Run that is the metadata resolver at
`169.254.169.254`, and it works — the platform depends on the same path.

**UDP to arbitrary internet hosts does not leave Cloud Run.** Nothing here sends
any, because `dns.ts` never calls `setServers`. The day it does — querying a
zone's authoritative nameservers directly is the obvious next step for a
domain-checking tool — every one of those queries fails on this platform, and
`optional()` turns each failure into an empty record set. The symptom would be
`domain_check` calmly reporting that a healthy client domain publishes no CAA,
no MX and no NS.

Whoever adds it: verify against a deployed instance, not locally.

### Before the first deploy

`--source .` builds through Cloud Build, which since mid-2024 runs as the
compute default service account rather than the old Cloud Build one. Without
`roles/run.builder` on it, the first deploy fails with

```
ERROR: (gcloud.run.deploy) NOT_FOUND: Build failed.
The service has encountered an internal error. Please try again later.
```

which is a permission error wearing a platform error's clothes. Grant the role
and give it a couple of minutes to propagate.

### What only you can do

- Create the Google Cloud project and attach a billing account. A card is
  required even though the free tier costs nothing, and that is true of every
  provider worth using.
- **Set a budget alert.** No line of code can stop egress charges if the
  endpoint is abused, and the guard raises the cost of abuse rather than
  removing it.
- **Add a logs exclusion on the `_Default` sink.** Cloud Run writes a request
  log for every request and offers no way to turn that off from its own side;
  Cloud Logging charges $0.50/GiB past the first 50 GiB. It is the one runaway
  that neither `--max-instances` nor a spend cap contains, and every bot probing
  `/.env` writes a line. People have been billed an order of magnitude more for
  logging than for compute.
- Decide whether the URL goes in the README. A demo that has quietly stopped
  paying its own bill is worse than no demo.

## The demo cannot run `accessibility_audit`

The image ships no browser, deliberately. It keeps the container small, and a
headless browser loading arbitrary pages on a stranger's request is a far larger
surface than the target guard covers — the browser fetches whatever a page
embeds, and none of that passes through the guard.

The tool is still advertised, and answers with the message naming the command
that installs a browser. Anyone who wants it runs the server locally.

## What this is not

It is a demo, not a service. It has no authentication, no availability promise
and no support. Anyone who wants to rely on these checks should run the stdio
server on their own machine, where none of the restrictions above apply.
