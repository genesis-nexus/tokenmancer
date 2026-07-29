import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Per-file environment via `// @vitest-environment jsdom` where DOM is needed;
    // default stays node for the core/parser/pricing/tokenizer suites.
    environment: 'node',
    include: [
      'packages/*/src/**/*.{test,spec}.{ts,tsx}',
      'packages/*/test/**/*.{test,spec}.{ts,tsx}',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.{test,spec}.ts', '**/index.ts'],
    },
  },
});
