import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    // Real DNS, TLS and HTTP round trips against control domains are slower
    // than anything in the offline suite.
    testTimeout: 30_000,
  },
});
