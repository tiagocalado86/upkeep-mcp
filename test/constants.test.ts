import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVER_NAME, SERVER_VERSION, USER_AGENT } from '../src/lib/constants.js';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string };

describe('server identity', () => {
  // SERVER_VERSION is hand-maintained rather than read from package.json at
  // runtime. This test is what keeps that duplication honest.
  it('matches the published package version', () => {
    expect(SERVER_VERSION).toBe(manifest.version);
  });

  it('matches the published package name', () => {
    expect(SERVER_NAME).toBe(manifest.name);
  });
});

describe('USER_AGENT', () => {
  it('identifies the server and its version', () => {
    expect(USER_AGENT).toContain(`${SERVER_NAME}/${SERVER_VERSION}`);
  });

  it('carries a contact URL, as required for any crawl', () => {
    expect(USER_AGENT).toMatch(/\(\+https:\/\/\S+\)$/);
  });
});
