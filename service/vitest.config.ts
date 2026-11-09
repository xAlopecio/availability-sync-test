import { defineConfig } from 'vitest/config';

// Run tests in a time zone with DST so that date logic that accidentally depends on local time
// fails (scenario D8). Workers inherit this from the main process.
process.env.TZ = 'Europe/Madrid';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // Real Portal Sol (30 req/min, random 503s) + Postgres: slow by nature.
          testTimeout: 180_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
