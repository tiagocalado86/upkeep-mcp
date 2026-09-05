# 13. playwright-core, and a browser that is optional

Status: accepted (2026-09-01)

## Context

`accessibility_audit` is the only check here that needs a rendered page. Whether
a contrast ratio passes, whether a control can be reached by keyboard, whether a
landmark exists once the JavaScript has run — none of it is knowable from the
markup a server sends, which is all every other tool in this project reads.

That makes it the one place where the README's argument — light dependencies, an
install that fetches nothing surprising — is under real pressure. The `playwright`
package runs a postinstall that downloads Chromium, Firefox and WebKit: several
hundred megabytes, fetched when someone runs `npm install` to try the SSL check.

## Decision

Depend on **`playwright-core`** (13 MB, no postinstall, downloads nothing) and
**`axe-core`** (3 MB), and treat the browser binary as a dependency of _running_
this one check rather than of installing the project.

When no browser is present, `accessibility_audit` fails with `not_found` and the
single command that fixes it. Every other tool keeps working.

## Consequences

- `npm install` stays 16 MB heavier and downloads no browsers. Someone who never
  calls this tool never pays for it.
- `npx playwright install chromium` is a documented one-off, not a hidden step.
- In `portfolio_report`, a machine without a browser turns an `accessibility`
  check into a check that could not run, so the site reports `unknown` — never a
  clean result it did not earn.
- ~~**The published container ships no browser**, which means the public demo
  cannot run this tool.~~ **Reversed on 2026-09-05 by
  [`0016`](0016-a-browser-in-the-published-image.md)**, once the guard gap below
  was closed and the owner set the rule that a hosted instance must do
  everything a local one does. The reasoning as it stood: deliberate twice over,
  the image stays small,
  and a headless browser loading arbitrary pages on a stranger's request is a
  far larger surface than the target guard in ADR 0012 covers, since the browser
  fetches whatever a page embeds and that is not checked.
- Browsers get their own concurrency pool rather than sharing the request
  limiter's. An audit holds a slot for seconds while the browser makes requests
  nothing here counts, so sharing one pool starved every other check without
  pacing any of the browser's own traffic. Two at once; still one per host.
- axe-core is injected as source into the page rather than pulled from a CDN, so
  the audit runs offline against the version this project pins, and the report
  names that version so a result can be reproduced.
- Automated rules find roughly a third of real accessibility problems. The tool
  says so, in its description and in its output, because a green result here is
  a floor and reporting it as a verdict would be the same class of overstatement
  this project keeps finding in its own output.
- **Amended 2026-09-05, when the container stopped being only a demo.** This ADR
  weighed a browser against a public _demo_; `docs/deploying.md` now describes an
  instance meant to be usable as a connector, which is a stronger reason to want
  the tool and does not change the answer. What it does change is what the caller
  is told. The refusal named `npx playwright install chromium` — the fix on the
  machine the server runs on, and unfollowable by someone connecting to somebody
  else's. A hosted instance now answers "run the server on your own machine"
  (`rethrowForRemoteCaller` in `src/lib/ports.ts`), and the tool's description
  says a hosted instance cannot run this check before anyone calls it.
- **The gap this left is now closed, and it did not need a proxy.** As written,
  ADR 0012's guard checked a page's own URL, host and port, and the browser then
  fetched whatever that page embedded — scripts, frames, images, fonts — with
  none of it passing `assertReachable`. A page embedding a URL on a port this
  server refuses to open itself had it fetched anyway, from the deployment's
  address. That was the whole distance between "this server is not a port
  scanner" and "this process issues no unchecked request", and shipping no
  browser was what kept the distance out of a public instance.

  `blockRefused` in `src/lib/axe.ts` now intercepts every request the browser
  makes — `context.route('**/*')` — and puts each one through the same
  `assertReachable` the rest of the project uses, aborting what the policy
  refuses. Decisions are memoised per origin, host and port together, since the
  policy allows 443 and 80 and nothing else. A scheme that reaches no network is
  allowed without asking, having no host to decide about.

  This was worth doing whether or not a browser is ever added to the image: the
  gap was reachable **today** by anyone running the HTTP entrypoint themselves
  with a browser installed, not only in some future container.

  What it does not close is what ADR 0012 already records: the guard resolves a
  hostname and then lets the browser request by name, so a resolver that answers
  differently the second time defeats it. That limitation is shared with every
  other check here and is not specific to the browser.

  So the reason for shipping no browser is now size, memory and cold start —
  no longer an unguarded request surface. That is a weaker case than the one
  this ADR was decided on, and whoever revisits it should say so plainly rather
  than citing a gap that has been closed.

- **Adding Chromium to this image is not a one-line change: `playwright-core`
  does not support Alpine.** Its platform table has no musl entry and falls back
  to `ubuntu24.04`, so `npx playwright install chromium` on `node:22-alpine`
  _succeeds_, downloads a glibc build, and dies at `chromium.launch()` with a
  loader error that matches neither branch of the check in `launch()`
  (`src/lib/axe.ts`) — reported as "could not start a browser", not as the
  actionable "none is installed". Doing it properly means changing the base
  image, which takes the image from about 200 MB to about 550 MB, pushes memory
  past the `--memory 512Mi` in the deploy command, and reopens the
  `--execution-environment gen1` pin. Whoever wants the tool on a hosted
  instance is choosing all of that, not a package.
