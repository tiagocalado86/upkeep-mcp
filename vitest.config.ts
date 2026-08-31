import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests hit the network and live in their own suite, run by
    // `npm run test:integration`. The default suite must stay offline.
    exclude: ['test/integration/**', 'node_modules/**'],
  },
});
