import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Vitest 4 no longer excludes build output by default; running a stale
    // dist/*.test.js duplicates every test and resolves fixtures from dist/.
    exclude: [...configDefaults.exclude, '**/dist/**', '**/coverage/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
})
