import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'capture',
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
});
