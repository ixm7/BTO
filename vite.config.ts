import { defineConfig } from 'vitest/config';

// `base: './'` keeps asset URLs relative so the built site works when served
// from a GitHub Pages sub-path (https://<user>.github.io/<repo>/).
export default defineConfig({
  base: './',
  build: { target: 'es2022', outDir: 'dist', sourcemap: true },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
