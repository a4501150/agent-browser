import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Launching real browsers is slow, and the profile lock serialises anyway.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
  },
});
