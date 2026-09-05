import axe from 'axe-core';
import { chromium, type Browser } from 'playwright-core';
import { TIMEOUTS } from './defaults.js';
import { CheckError } from './errors.js';
import { USER_AGENT } from './constants.js';

/**
 * Running axe-core against a real rendered page.
 *
 * This is the only part of the project that needs a browser, and the reason
 * `accessibility_audit` is the last tool rather than the first. Everything else
 * reads what a server sends; accessibility is a property of what a browser
 * builds from it, and no amount of markup parsing establishes whether a
 * contrast ratio passes or a control is reachable by keyboard.
 *
 * `playwright-core` is used rather than `playwright`: it is the same library
 * without the postinstall that downloads three browsers. A browser is a
 * dependency of *running* this check, not of installing this project, and the
 * failure when one is missing says exactly that.
 */

/** One rule that failed, with the elements that failed it. */
export interface AxeViolation {
  /** The axe rule identifier, e.g. `color-contrast`. */
  id: string;
  /** How much axe thinks it matters, or `null` when it does not say. */
  impact: 'critical' | 'serious' | 'moderate' | 'minor' | null;
  /** One line describing what is wrong. */
  help: string;
  /** Where to read about the rule. */
  helpUrl: string;
  /** The standards this rule belongs to, e.g. `wcag2aa`. */
  tags: string[];
  /** How many elements failed it. */
  nodeCount: number;
  /** The first few failing elements, as CSS selectors. */
  selectors: string[];
}

/** What one run of axe found. */
export interface AxeRun {
  /** The URL the browser ended on, after any redirect. */
  url: string;
  /** The page title as rendered, which may differ from the served markup. */
  title: string;
  /** Rules that failed. */
  violations: AxeViolation[];
  /** Rules that passed, counted rather than listed. */
  passCount: number;
  /** Rules axe could not decide, which need a person. */
  incompleteCount: number;
  /** Which axe-core did the judging, so a result can be reproduced. */
  axeVersion: string;
}

/**
 * The one global the injected script uses, declared here rather than by adding
 * `dom` to the project's TypeScript libraries.
 *
 * The callback below is serialised and run inside the browser, not in this
 * process. Pulling the whole DOM library in to type six characters would put
 * `document` and `window` in scope for every server file in the project, where
 * their presence would be a bug rather than a convenience.
 */
declare const window: {
  axe: {
    run: (options: { runOnly: { type: 'tag'; values: string[] } }) => Promise<axe.AxeResults>;
  };
};

/** Failing elements kept per rule. Enough to find them, not enough to flood a report. */
const SELECTOR_SAMPLE = 5;

/**
 * Audits one page with axe-core in a headless browser.
 *
 * @param url The page to audit.
 * @param tags axe tags selecting the standard, e.g. `['wcag2a', 'wcag2aa']`.
 * @param timeoutMs Deadline for the whole thing: launch, navigation and audit.
 * @param allow Decides whether the browser may make a given request. Called for
 *   the page and for every subresource it embeds — see {@link blockRefused}.
 *   Omitted, the browser fetches whatever the page asks for.
 * @returns What axe found.
 * @throws {CheckError} `not_found` when no browser is installed, with the
 *   command that installs one; `timeout` when the deadline passes; `network`
 *   when the page cannot be loaded.
 */
export async function runAxe(
  url: string,
  tags: readonly string[],
  timeoutMs: number = TIMEOUTS.browserMs,
  allow?: (target: URL) => Promise<void>,
): Promise<AxeRun> {
  const startedAt = Date.now();
  const browser = await launch(timeoutMs);
  let timer: NodeJS.Timeout | undefined;

  // The deadline covers everything from here, not just the navigation.
  // `page.evaluate` has no timeout of its own, so a page whose main thread never
  // yields — or one large enough that axe grinds on it — would otherwise hang
  // forever, holding a rate-limiter slot with it and taking a whole portfolio
  // run down. Closing the browser is what actually stops the work; rejecting
  // alone would leave it running.
  const remaining = Math.max(1000, timeoutMs - (Date.now() - startedAt));
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void browser.close().catch(() => undefined);
      reject(
        new CheckError(
          'timeout',
          `auditing ${url} did not finish within ${(timeoutMs / 1000).toFixed(0)}s`,
        ),
      );
    }, remaining);
  });

  try {
    return await Promise.race([audit(browser, url, tags, remaining, allow), deadline]);
  } finally {
    clearTimeout(timer);
    await browser.close().catch(() => undefined);
  }
}

/**
 * Loads the page and runs axe over it.
 *
 * @param browser An open browser.
 * @param url The page to audit.
 * @param tags axe tags selecting the standard.
 * @param timeoutMs Deadline for the navigation.
 * @param allow Decides whether a request may be made, if the caller supplied one.
 * @returns What axe found.
 * @throws {CheckError} `timeout` or `network`.
 */
async function audit(
  browser: Browser,
  url: string,
  tags: readonly string[],
  timeoutMs: number,
  allow?: (target: URL) => Promise<void>,
): Promise<AxeRun> {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    // A viewport, because half of what axe judges — reflow, target size,
    // contrast against a rendered background — depends on one.
    viewport: { width: 1280, height: 900 },
    // axe is injected as an inline script, which a Content-Security-Policy
    // without `unsafe-inline` blocks — and a client site with a strict CSP is
    // a well-configured one, exactly the kind this should still be able to
    // audit. Nothing is executed that the page did not already allow itself;
    // the policy is bypassed for the audit, not weakened for the visitor.
    bypassCSP: true,
  });
  if (allow !== undefined) await blockRefused(context, allow);

  const page = await context.newPage();

  try {
    // `load` rather than `networkidle`, which never arrives on a page with a
    // chat widget or an analytics beacon — and rather than `domcontentloaded`,
    // which returns before a client-rendered site has rendered anything. Auditing
    // an empty root element reports zero violations, which is the worst possible
    // wrong answer: a clean bill for the sites most likely to have problems.
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    await page.addScriptTag({ content: axe.source });

    // No context argument: axe defaults to the whole document, which is what
    // this wants and which keeps `document` out of this file's types.
    const result = await page.evaluate(
      (selected) => window.axe.run({ runOnly: { type: 'tag', values: selected } }),
      [...tags],
    );

    return {
      url: page.url(),
      title: await page.title(),
      violations: result.violations.map(summariseViolation),
      passCount: result.passes.length,
      incompleteCount: result.incomplete.length,
      axeVersion: axe.version,
    };
  } catch (cause) {
    throw asCheckError(cause, url, timeoutMs);
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * The part of Playwright's `Route` this needs, so a test can supply one.
 *
 * Declared structurally for the same reason `DnsResolver` is in `dns.ts`: a
 * real `Route` only exists inside a running browser, and the decision this
 * makes is worth testing without one
 * (`docs/adr/0006-injected-ports-as-the-test-seam.md`). A real `Route`
 * satisfies it.
 */
export interface InterceptedRequest {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

/** The part of Playwright's `BrowserContext` this needs. A real one satisfies it. */
export interface RoutableContext {
  // Playwright resolves this to a `Disposable`, which nothing here uses.
  route(pattern: string, handler: (route: InterceptedRequest) => Promise<void>): Promise<unknown>;
}

/**
 * Puts every request the browser makes through the same target policy the rest
 * of the project uses.
 *
 * Without this, only the page's own URL is checked. A browser then fetches
 * whatever that page embeds — images, scripts, fonts, stylesheets, an XHR the
 * page fires on load — and none of it passes any guard. On an instance anyone
 * can reach, that is the whole guard defeated by one `<img>`: a page saying
 * `<img src="http://169.254.169.254/latest/meta-data/">` makes the server fetch
 * it, and while the response is not handed back, whether it loaded is
 * observable from the page itself. `docs/adr/0013` accepted this on the grounds
 * that the published container shipped no browser. It now ships one
 * (`docs/adr/0016`), so this policy is the only thing standing between the two —
 * and it was already the only thing for anyone running the HTTP entrypoint on a
 * machine with a browser installed.
 *
 * Decisions are memoised per origin. A page pulling forty files from one CDN
 * would otherwise resolve that hostname forty times, and the audit already has
 * a deadline to fit inside.
 *
 * A scheme that reaches no network — `data:`, `blob:`, `about:` — is allowed
 * without asking. There is nothing for a target policy to decide about bytes
 * that never leave the process.
 *
 * Exported for its own test: a real browser context only exists with a browser
 * installed, and this decision is the one thing here that must hold on a
 * machine that has none.
 *
 * @param context The browser context to intercept.
 * @param allow Throws when a target may not be contacted.
 * @throws Never — a refusal aborts the individual request, and a route that can
 *   no longer be answered (the page navigated away) is not an error either.
 */
export async function blockRefused(
  context: RoutableContext,
  allow: (target: URL) => Promise<void>,
): Promise<void> {
  const decided = new Map<string, Promise<boolean>>();

  await context.route('**/*', async (route: InterceptedRequest) => {
    const target = new URL(route.request().url());

    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      await route.continue().catch(() => undefined);
      return;
    }

    const origin = `${target.protocol}//${target.host}`;
    let decision = decided.get(origin);
    if (decision === undefined) {
      decision = allow(target).then(
        () => true,
        () => false,
      );
      decided.set(origin, decision);
    }

    // `blockedbyclient` rather than a failure code: this is a policy decision,
    // and a page that reports why its image did not load should say so.
    const permitted = await decision;
    await (permitted ? route.continue() : route.abort('blockedbyclient')).catch(() => undefined);
  });
}

/**
 * Starts a headless browser.
 *
 * @param timeoutMs Deadline for the launch itself.
 * @returns The browser.
 * @throws {CheckError} `not_found` when none is installed. This is the
 *   graceful-degradation path the whole design turns on: the message names the
 *   one command that fixes it, and every other tool keeps working without it.
 */
async function launch(timeoutMs: number): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true, timeout: timeoutMs });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);

    // Matched narrowly. Playwright prefixes every launch failure with
    // `browserType.launch:`, so matching that would tell someone whose Linux
    // host is missing shared libraries to install a browser they already have.
    if (/Executable doesn't exist|Please run the following command/i.test(message)) {
      throw new CheckError(
        'not_found',
        'no browser is installed for this check; run `npx playwright install chromium` once, or use the other tools, which need none',
        { cause },
      );
    }
    throw new CheckError('unexpected', `could not start a browser: ${message}`, { cause });
  }
}

/**
 * @param violation One axe violation.
 * @returns The reportable summary of it.
 * @throws Never.
 */
function summariseViolation(violation: axe.Result): AxeViolation {
  return {
    id: violation.id,
    impact: violation.impact ?? null,
    help: violation.help,
    helpUrl: violation.helpUrl,
    tags: violation.tags,
    nodeCount: violation.nodes.length,
    selectors: violation.nodes
      .slice(0, SELECTOR_SAMPLE)
      .map((node) => node.target.map(String).join(' ')),
  };
}

/**
 * @param cause Whatever the browser threw.
 * @param url The page being audited.
 * @param timeoutMs The deadline that applied.
 * @returns A categorised error.
 * @throws Never.
 */
function asCheckError(cause: unknown, url: string, timeoutMs: number): CheckError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const seconds = (timeoutMs / 1000).toFixed(0);

  if (/Timeout .* exceeded|timeout/i.test(message)) {
    return new CheckError('timeout', `${url} did not finish loading within ${seconds}s`, { cause });
  }
  return new CheckError('network', `the browser could not load ${url}: ${message}`, { cause });
}
