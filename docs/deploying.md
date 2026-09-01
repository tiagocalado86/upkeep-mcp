# Deploying the HTTP instance

The server speaks two transports. `stdio` is what a local MCP client starts on
your own machine, and it is the one you want unless you are publishing a demo.
This page is about the other one.

## What is different about the public instance

A stranger holding the keyboard is not the same as you holding it, so the HTTP
entrypoint is not the stdio entrypoint with a socket bolted on:

- **It contacts only public addresses, and only port 443.** Anything resolving
  to loopback, a private range or the link-local address where cloud metadata
  services live is refused with an explanation.
  [`docs/adr/0012`](adr/0012-public-target-guard.md) covers why, and what that
  guard still does not close.
- **It admits traffic through a token bucket**: 60 requests a minute per caller
  with a burst of 20, and 8 requests in flight across everyone. A refusal is an
  answer with a reason, not a dropped connection.
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
resolver and raw TLS sockets both work, which they do not on edge runtimes —
Cloudflare Workers implements four functions of `node:tls` and none of them read
a peer certificate, so `ssl_check` would be dead there while everything else
appeared fine.

Its free tier is perpetual and generous for a demo: 2 million requests,
180,000 vCPU-seconds and 360,000 GiB-seconds a month, with **1 GB of outbound
transfer from North America**. That last line is why a US region is worth
choosing — this server's whole job is making outbound requests.

```bash
gcloud run deploy upkeep-mcp \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --max-instances 2 \
  --concurrency 20
```

`--max-instances 2` is a cost ceiling, not a capacity target: the inbound
limiter already caps what one instance will take, and this caps how many
instances a determined caller can conjure.

### What only you can do

- Create the Google Cloud project and attach a billing account. A card is
  required even though the free tier costs nothing, and that is true of every
  provider worth using.
- **Set a budget alert.** No line of code can stop egress charges if the
  endpoint is abused, and the guard raises the cost of abuse rather than
  removing it.
- Decide whether the URL goes in the README. A demo that has quietly stopped
  paying its own bill is worse than no demo.

## What this is not

It is a demo, not a service. It has no authentication, no availability promise
and no support. Anyone who wants to rely on these checks should run the stdio
server on their own machine, where none of the restrictions above apply.
