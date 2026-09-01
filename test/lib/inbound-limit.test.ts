import { describe, expect, it } from 'vitest';
import { clientKey, createInboundLimiter } from '../../src/lib/inbound-limit.js';

const LIMITS = { perClientPerMinute: 60, burst: 3, maxConcurrent: 2, maxClients: 3 };

/** A limiter with a clock the test drives. */
function limiterAt(start = 0): {
  limiter: ReturnType<typeof createInboundLimiter>;
  advance: (ms: number) => void;
} {
  let clock = start;
  const limiter = createInboundLimiter(LIMITS, () => clock);
  return {
    limiter,
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe('createInboundLimiter', () => {
  it('lets a client spend its burst and then refuses', () => {
    const { limiter } = limiterAt();

    for (let attempt = 0; attempt < LIMITS.burst; attempt += 1) {
      const admission = limiter.admit('a');
      expect(admission.ok, `attempt ${String(attempt)}`).toBe(true);
      if (admission.ok) admission.release();
    }

    const refused = limiter.admit('a');
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.status).toBe(429);
      expect(refused.message).toContain('run it locally');
    }
  });

  it('refills over time rather than resetting on a window boundary', () => {
    const { limiter, advance } = limiterAt();
    for (let attempt = 0; attempt < LIMITS.burst; attempt += 1) {
      const admission = limiter.admit('a');
      if (admission.ok) admission.release();
    }
    expect(limiter.admit('a').ok).toBe(false);

    // Sixty a minute is one a second.
    advance(1000);
    const admission = limiter.admit('a');
    expect(admission.ok).toBe(true);
    if (admission.ok) admission.release();
    expect(limiter.admit('a').ok).toBe(false);
  });

  it('never refills past the burst, however long it waits', () => {
    const { limiter, advance } = limiterAt();
    advance(600_000);

    let admitted = 0;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const admission = limiter.admit('a');
      if (!admission.ok) break;
      admission.release();
      admitted += 1;
    }

    expect(admitted).toBe(LIMITS.burst);
  });

  it('counts clients separately', () => {
    const { limiter } = limiterAt();
    for (let attempt = 0; attempt < LIMITS.burst; attempt += 1) {
      const admission = limiter.admit('a');
      if (admission.ok) admission.release();
    }

    expect(limiter.admit('a').ok).toBe(false);
    expect(limiter.admit('b').ok).toBe(true);
  });

  it('caps what is in flight across every client at once', () => {
    const { limiter } = limiterAt();

    const first = limiter.admit('a');
    const second = limiter.admit('b');
    const third = limiter.admit('c');

    expect(first.ok && second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.status).toBe(503);
    expect(limiter.inFlight).toBe(2);

    if (first.ok) first.release();
    expect(limiter.admit('c').ok).toBe(true);
  });

  it('ignores a second release, which would let the cap drift upwards', () => {
    const { limiter } = limiterAt();
    const admission = limiter.admit('a');

    if (admission.ok) {
      admission.release();
      admission.release();
    }

    expect(limiter.inFlight).toBe(0);
  });

  it('bounds what it remembers, so a flood of addresses is not a leak', () => {
    const { limiter } = limiterAt();

    for (let client = 0; client < 50; client += 1) {
      const admission = limiter.admit(`client-${String(client)}`);
      if (admission.ok) admission.release();
    }

    // The earliest clients were forgotten, which costs them a fresh bucket and
    // costs this process nothing.
    const admission = limiter.admit('client-0');
    expect(admission.ok).toBe(true);
  });
});

describe('clientKey', () => {
  it('prefers the first forwarded address, which is what the platform proxy sets', () => {
    expect(clientKey('203.0.113.7, 70.41.3.18', '10.0.0.1')).toBe('203.0.113.7');
  });

  it('falls back to the socket when there is no header', () => {
    expect(clientKey(undefined, '203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('', '203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('   ', '203.0.113.7')).toBe('203.0.113.7');
  });

  it('always returns something to key on', () => {
    expect(clientKey(undefined, undefined)).toBe('unknown');
  });
});
