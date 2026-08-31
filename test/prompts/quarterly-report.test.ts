import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../src/prompts/quarterly-report.js';

describe('buildRequest', () => {
  it('names the period and the tool to call', () => {
    const text = buildRequest({ period: 'Q3 2026' });

    expect(text).toContain('Q3 2026');
    expect(text).toContain('`portfolio_report`');
  });

  it('passes tags through as a list the model can hand straight to the tool', () => {
    const text = buildRequest({ period: 'Q3 2026', tags: 'retainer,quarterly' });

    expect(text).toContain('with tags ["retainer","quarterly"]');
  });

  it('asks for no tags at all when none were given', () => {
    expect(buildRequest({ period: 'Q3 2026' })).toContain('First call `portfolio_report`.');
  });

  it('adds the language only when one was asked for', () => {
    expect(buildRequest({ period: 'Q3 2026', language: 'Portuguese' })).toContain(
      'Write it in Portuguese',
    );
    expect(buildRequest({ period: 'Q3 2026' })).not.toContain('Write it in');
  });

  it('tells the model not to invent what the report does not contain', () => {
    // The whole risk of a reporting prompt: a confident paragraph about checks
    // that never ran.
    const text = buildRequest({ period: 'Q3 2026' });

    expect(text).toContain('Do not invent anything the report does not contain');
    expect(text).toContain('do not imply stability that was not measured');
  });
});
