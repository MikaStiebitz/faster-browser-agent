import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Unit tests are fast; the browser-backed integration tests need room for a
    // cold Chromium launch (~1-8s) plus navigation.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Browser tests bind ports and take profile locks — running files in
    // parallel would make them fight over both.
    fileParallelism: false,
    reporters: ['default'],
  },
});
