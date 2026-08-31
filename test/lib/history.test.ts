import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from '../../src/lib/history.js';

describe('createMemoryHistory', () => {
  it('has nothing to offer before a run is recorded', () => {
    // A fresh server process cannot say what changed, and the report depends on
    // being able to tell that apart from "nothing changed".
    expect(createMemoryHistory().previous()).toBeNull();
  });

  it('returns the run it was given', () => {
    const history = createMemoryHistory();
    const snapshot = {
      takenAt: '2026-08-31T12:00:00.000Z',
      sites: {
        'https://example.com/': {
          severity: 'warning' as const,
          codes: ['a'],
          checks: ['uptime' as const],
        },
      },
    };

    history.record(snapshot);
    expect(history.previous()).toEqual(snapshot);
  });

  it('keeps only the most recent run', () => {
    const history = createMemoryHistory();
    history.record({ takenAt: '2026-08-30T12:00:00.000Z', sites: {} });
    history.record({ takenAt: '2026-08-31T12:00:00.000Z', sites: {} });

    expect(history.previous()?.takenAt).toBe('2026-08-31T12:00:00.000Z');
  });

  it('does not share state between instances', () => {
    const first = createMemoryHistory();
    first.record({ takenAt: '2026-08-31T12:00:00.000Z', sites: {} });

    expect(createMemoryHistory().previous()).toBeNull();
  });
});
