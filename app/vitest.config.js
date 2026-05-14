import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.js'],
    projects: [
      {
        test: {
          name: 'api',
          include: ['tests/api/**/*.test.js'],
          environment: 'node',
          globals: true,
        },
      },
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.js'],
          environment: 'jsdom',
          globals: true,
        },
      },
    ],
  },
})
