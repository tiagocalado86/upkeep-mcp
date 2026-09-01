import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The promise this tool is built around: with no browser installed, it says so
 * usefully and nothing else in the server is affected.
 *
 * Checked by running the real launcher in a subprocess whose browser path
 * points nowhere. That is an environment variable set by the test harness, not
 * read by `src/` — Playwright reads it, and pointing it at an empty directory
 * is the only faithful way to reproduce a machine that never ran
 * `playwright install`.
 */
const repoRoot = new URL('..', import.meta.url);
const tsx = fileURLToPath(new URL('node_modules/tsx/dist/cli.mjs', repoRoot));

const axeModule = fileURLToPath(new URL('src/lib/axe.ts', repoRoot));

// Wrapped rather than top-level await: `tsx --eval` compiles to CommonJS. The
// import is absolute because an eval'd script has no directory of its own to
// resolve against.
const PROBE = `
import { runAxe } from ${JSON.stringify(axeModule)};
void (async () => {
  try {
    await runAxe('https://example.com/', ['wcag2a']);
    console.log(JSON.stringify({ ran: true }));
  } catch (cause) {
    console.log(JSON.stringify({ code: cause.code, message: cause.message }));
  }
})();
`;

describe('with no browser installed', () => {
  it('fails with a code and a command, not a stack trace', () => {
    const output = execFileSync(process.execPath, [tsx, '--eval', PROBE], {
      cwd: fileURLToPath(repoRoot),
      encoding: 'utf8',
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: fileURLToPath(new URL('test/fixtures/no-browsers', repoRoot)),
      },
      timeout: 60_000,
    });

    const result = JSON.parse(output.trim()) as { code?: string; message?: string; ran?: boolean };

    expect(result.ran).toBeUndefined();
    expect(result.code).toBe('not_found');
    expect(result.message).toContain('npx playwright install chromium');
    // And it says the rest of the server still works, because it does.
    expect(result.message).toContain('other tools, which need none');
  }, 90_000);
});
