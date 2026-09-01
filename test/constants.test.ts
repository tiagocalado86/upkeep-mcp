import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVER_NAME, SERVER_VERSION, USER_AGENT } from '../src/lib/constants.js';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string; mcpName: string };

const registry = JSON.parse(
  readFileSync(fileURLToPath(new URL('../server.json', import.meta.url)), 'utf8'),
) as {
  name: string;
  description: string;
  version: string;
  packages: { identifier: string; version: string }[];
};

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

describe('server.json, the MCP registry manifest', () => {
  // Three files now carry the version, and a registry entry pointing at a
  // package version that was never published is worse than no entry.
  it('names the same version as the package', () => {
    expect(registry.version).toBe(manifest.version);
    expect(registry.packages[0]?.version).toBe(manifest.version);
  });

  it('points at this package, under the name the package claims', () => {
    expect(registry.packages[0]?.identifier).toBe(manifest.name);
    expect(registry.name).toBe(manifest.mcpName);
  });

  // The registry rejects anything longer, at publish time rather than here.
  it('keeps the description within the 100 characters the schema allows', () => {
    expect(registry.description.length).toBeLessThanOrEqual(100);
  });
});
