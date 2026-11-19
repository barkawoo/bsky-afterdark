import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    clearMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // generated lexicon bindings are not hand-written code
      exclude: ['src/lexicon/**'],
      reporter: ['text', 'lcov'],
    },
  },
})
