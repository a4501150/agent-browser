import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
  // manifest.json is imported for the pinned binary version and per-platform hashes.
  loader: { '.json': 'json' },
});
