import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Each test boots a real DuckDB engine (WASM/native init is ~1s); running
    // files in parallel on a shared machine starves them and trips timeouts.
    fileParallelism: false,
  },
});
