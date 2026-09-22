import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'schema',
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
});
