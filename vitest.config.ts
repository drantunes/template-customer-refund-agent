import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'contract',
          include: ['test/contract/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'eval',
          include: ['test/eval/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'web-unit',
          include: ['web/src/**/*.unit.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'web-integration',
          include: ['web/src/**/*.integration.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'web-contract',
          include: ['web/src/**/*.contract.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'web-eval',
          include: ['web/src/**/*.eval.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
