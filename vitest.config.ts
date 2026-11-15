import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['App.tsx', 'components/**/*.{ts,tsx}', 'hooks/**/*.ts', 'services/**/*.ts', 'utils/**/*.ts'],
      reporter: ['text', 'html', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      thresholds: {
        statements: 70, branches: 70, functions: 70, lines: 70,
        'hooks/useTagInsurance.ts': { statements: 95, branches: 95, functions: 100, lines: 100 },
        'utils/tagInsurance.ts': { statements: 85, branches: 85, functions: 100, lines: 100 },
        'components/dashboard/TagInsuranceTab.tsx': { statements: 90, branches: 90, functions: 80, lines: 90 },
      },
    },
  },
});
