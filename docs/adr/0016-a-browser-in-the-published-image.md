# 0016 — A browser in the published image

## Status

Accepted, 2026-09-05. Reverses the container half of
[`0013`](0013-playwright-core-and-an-optional-browser.md), which stands
otherwise: `playwright-core` is still the dependency, and a browser is still not
downloaded by `npm install`.

## Context

[`0013`](0013-playwright-core-and-an-optional-browser.md) kept a browser out of
the published image for two reasons, and only one of them was about size.

The other was a security argument, and it was the load-bearing one: the target
guard checked a page's own URL, and the browser then fetched whatever that page
embedded — scripts, images, fonts, an XHR fired on load — with none of it
passing any policy. Shipping no browser kept that surface off a public instance.

Two things changed.

The first is that the gap turned out not to be hypothetical. Anyone running the
HTTP entrypoint on a machine with a browser installed had it, and the README
documents that configuration. It was fixed on its own merits: `blockRefused` in
`src/lib/axe.ts` intercepts every request the browser makes and puts it through
the same `assertReachable` as the rest of the project.

The second is that the owner of this project stated a rule that outranks the
size argument: **the hosted instance must do everything the local one does.**
Not as a preference — as fairness. Someone who cannot run a server on their own
machine should not get a weaker tool than someone who can. Under that rule, one
tool answering "not here" was a defect rather than a documented limit.

## Decision

Ship a browser in the published image, and let a hosted instance run
`accessibility_audit`.

- **The headless shell, not the full browser.** `--only-shell` installs 196 MB
  where the full Chromium is several hundred more, and
  `chromium.launch({ headless: true })` uses it. That was verified against a
  browser directory containing nothing else, not taken from release notes.
- **Debian, not Alpine.** Forced, not preferred: `playwright-core` publishes no
  musl build, its platform table falls back to `ubuntu24.04`, so installing on
  Alpine _succeeds_ and the browser dies at launch with a loader error.
- **`--memory 1Gi`**, up from 512Mi. A Chromium does not fit in the old figure.
- **`--execution-environment gen2`**, up from gen1. [`0015`](0015-cloud-run-as-the-deployment-target.md)
  called the gen1 pin "the least-supported decision here" and rested it on cold
  start alone; gen1's gVisor is exactly the environment where a browser is
  likely to fail. Chromium started on gen2 without `--no-sandbox`, which is
  worth recording: the flag was not added, so Chromium's own sandbox is intact.

## Consequences

- The image grows from roughly 200 MB to roughly 550 MB, and cold starts with
  it. For a demo whose first visitor already waits on a cold start, that is the
  price of the tool existing there at all.
- **Cost is not the constraint.** Measured against Cloud Run's perpetual free
  tier — 180,000 vCPU-seconds and 360,000 GiB-seconds a month — an audit at
  roughly 10 vCPU-seconds and 10 GiB-seconds leaves room for over 18,000 audits
  a month at no charge. `--max-instances 2` still caps what a determined caller
  can conjure.
- **The guard is now the only thing between a stranger's page and this
  server's address**, where before there were two things. It is tested offline
  against six cases, and against two reintroduced mutants; two integration tests
  check the wiring in a real browser, one of them that a refused policy makes the
  audit _fail_ rather than report zero violations on a page that never loaded.
- What none of this closes is what [`0012`](0012-public-target-guard.md) already
  records: the guard resolves a hostname and the browser then requests by name,
  so a resolver answering differently the second time defeats it. That is shared
  with every other check here.
- The refusal message for a missing browser changes meaning. It used to describe
  a deliberate limit; on a hosted instance it now describes a broken deployment,
  and `rethrowForRemoteCaller` says that instead.

## What would reopen this

A cold start that makes the demo unusable, or an audit cost that stops fitting
the free tier. Both are measurable, and neither has been measured under load —
the twenty-site timing run in `docs/deploying.md` predates the browser.
