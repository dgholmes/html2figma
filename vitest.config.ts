import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/schema', 'packages/capture', 'packages/extension', 'packages/figma-plugin'],
  },
});
