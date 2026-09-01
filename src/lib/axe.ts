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
 * @returns What axe found.
 * @throws {CheckError} `not_found` when no browser is installed, with the
 *   command that installs one; `timeout` when the deadline passes; `network`
 *   when the page cannot be loaded.
 */
export async function runAxe(
  url: string,
  tags: readonly string[],
  timeoutMs: number = TIMEOUTS.browserMs,
): Promise<AxeRun> {
  const browser = await launch();

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      // A viewport, because half of what axe judges — reflow, target size,
      // contrast against a rendered background — depends on one.
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    try {
      // `domcontentloaded` rather than `networkidle`: a page with a chat widget
      // or an analytics beacon never goes idle, and waiting for it to would
      // time out on exactly the sites a client pays someone to maintain.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
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
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

/**
 * Starts a headless browser.
 *
 * @returns The browser.
 * @throws {CheckError} `not_found` when none is installed. This is the
 *   graceful-degradation path the whole design turns on: the message names the
 *   one command that fixes it, and every other tool keeps working without it.
 */
async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/Executable doesn't exist|playwright install|browserType.launch/i.test(message)) {
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
