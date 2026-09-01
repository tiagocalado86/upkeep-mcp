import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { USER_AGENT } from '../src/lib/constants.js';

/**
 * The project's inviolable principles, asserted against the source itself.
 *
 * These are structural claims — "no tool performs I/O directly", "nothing here
 * handles credentials" — and a claim nothing checks is a claim that quietly
 * stops being true. Reading the source is the only way to test them.
 */

/** Every `.ts` file under a directory, recursively. */
function sourcesIn(directory: string): { path: string; text: string }[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => {
      const path = `${entry.parentPath}/${entry.name}`;
      return { path, text: readFileSync(path, 'utf8') };
    });
}

/**
 * Strips comments, so that prose about a rule is not mistaken for a breach of
 * it: `has any address record` is documentation, not an `any` type.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const sources = sourcesIn('src');

describe('nothing handles credentials', () => {
  it('never reads the environment', () => {
    // Principle 1: no API keys, tokens or passwords, for any service. The way
    // that rule usually dies is a well-meaning `process.env.SOMETHING_KEY`.
    // Comments are stripped: a file explaining that it does not read the
    // environment is not a file reading the environment.
    for (const { path, text } of sources) {
      expect(code(text).includes('process.env'), `${path} reads process.env`).toBe(false);
    }
  });

  it('never sends an authorization header', () => {
    for (const { path, text } of sources) {
      expect(/authorization\s*['"`:]/i.test(text), `${path} sets an authorization header`).toBe(
        false,
      );
      expect(/x-api-key/i.test(text), `${path} sets an api key header`).toBe(false);
    }
  });

  it('never writes to disk', () => {
    // Principle 5: no persistent state. The server reads a portfolio file the
    // user wrote; it creates nothing.
    for (const { path, text } of sources) {
      expect(/writeFile|appendFile|createWriteStream|mkdir/.test(text), `${path} writes`).toBe(
        false,
      );
    }
  });
});

describe('no tool performs I/O directly', () => {
  const forbidden = ['node:fs', 'node:dns', 'node:tls', 'node:net', 'node:http', 'node:https'];

  it('keeps every builtin out of src/tools, src/resources and src/prompts', () => {
    // The structural claim behind the ports: a tool can only reach the network
    // through an interface a test can replace. Entrypoints are exempt by
    // definition — `src/index.ts` and `src/http.ts` exist to do I/O — and they
    // register tools rather than implementing any.
    const callers = sources.filter(
      ({ path }) =>
        path.startsWith('src/tools') ||
        path.startsWith('src/resources') ||
        path.startsWith('src/prompts'),
    );
    expect(callers.length).toBeGreaterThan(5);

    for (const { path, text } of callers) {
      for (const builtin of forbidden) {
        expect(text.includes(`'${builtin}'`), `${path} imports ${builtin}`).toBe(false);
      }
    }
  });

  it('makes http-client.ts the only module that calls fetch', () => {
    for (const { path, text } of sources) {
      if (path.endsWith('lib/http-client.ts')) continue;
      expect(/await fetch\(/.test(code(text)), `${path} calls fetch directly`).toBe(false);
    }
  });
});

describe('every outbound request identifies itself', () => {
  it('sets the user agent on every fetch in the http client', () => {
    const client = readFileSync('src/lib/http-client.ts', 'utf8');
    const calls = client.match(/await fetch\(/g) ?? [];
    const identified = client.match(/'user-agent': USER_AGENT/g) ?? [];

    expect(calls.length).toBeGreaterThan(0);
    expect(identified).toHaveLength(calls.length);
  });

  it('carries a contact URL, so anyone seeing it in their logs can complain', () => {
    // Principle 4 asks for an identifiable agent with a contact point.
    expect(USER_AGENT).toMatch(/^upkeep-mcp\/\d+\.\d+\.\d+ \(\+https:\/\/.+\)$/);
  });
});

describe('the conventions that keep the types honest', () => {
  it('has no `any` and no suppression comments anywhere in src', () => {
    for (const { path, text } of sources) {
      // Type positions only: `AbortSignal.any` is a real API, and a
      // description that uses the word "any" in a sentence is not a breach.
      expect(/:\s*any\b|\bas any\b|<any>|\bany\[\]/.test(code(text)), `${path} uses any`).toBe(
        false,
      );
      expect(text.includes('@ts-ignore'), `${path} suppresses the compiler`).toBe(false);
      expect(text.includes('@ts-expect-error'), `${path} suppresses the compiler`).toBe(false);
    }
  });

  it('documents everything exported from lib', () => {
    // The rule is JSDoc on everything exported from `lib/`: purpose,
    // parameters, return value, and which errors it throws.
    for (const { path, text } of sources.filter((file) => file.path.startsWith('src/lib'))) {
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        if (!/^export (async )?function |^export function /.test(line)) return;
        const preceding = lines.slice(Math.max(0, index - 3), index).join('\n');
        expect(preceding.includes('*/'), `${path}:${String(index + 1)} is undocumented`).toBe(true);
      });
    }
  });
});
