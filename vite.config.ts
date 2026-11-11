import { defineConfig } from 'vitest/config';

// `base: './'` keeps asset URLs relative, so the same build works both at the
// site's own domain (https://bridgebreak.org/) and from a GitHub Pages
// sub-path (https://<user>.github.io/<repo>/).
//
// `public/CNAME` names that domain and is copied into `dist` by every build,
// which is what keeps the custom domain through a deploy: publishing replaces
// the whole branch, and a CNAME file only in the branch would be wiped.
export default defineConfig({
  base: './',
  build: { target: 'es2022', outDir: 'dist', sourcemap: true },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
