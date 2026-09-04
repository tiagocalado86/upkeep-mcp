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
- **The published container ships no browser**, which means the public demo
  cannot run this tool. That is deliberate twice over: the image stays small,
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
- **The gap this leaves, stated sharply: subresources bypass the port rule.**
  ADR 0012's guard checks a page's own URL, host and port. The browser then
  fetches whatever that page embeds — scripts, frames, images, fonts — and none
  of it passes `assertReachable`. A page that embeds a URL on a port this server
  refuses to open itself has it fetched anyway, from the deployment's address.
  So the port rule holds on every request this project _makes_ and on no
  subresource, which is the whole distance between "this server is not a port
  scanner" and "this process issues no unchecked request". Shipping no browser
  is what keeps that distance out of a public instance; adding one closes it
  only if the browser is put behind a proxy that applies the same guard.
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
