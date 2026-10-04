import { defineConfig } from 'vite';

// Relative base so the same build works on GitHub Pages (/Stargaze/), itch.io and a plain folder.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  server: { host: true },
});
