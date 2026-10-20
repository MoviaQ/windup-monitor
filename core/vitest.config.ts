import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Unit tests living next to sources (src/ai/chatgpt.test.ts) run in the
    // regular suite too — no throwaway .tmp configs needed.
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Real Postgres: run files sequentially, no cross-file parallelism.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
