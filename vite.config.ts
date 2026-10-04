import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Relative base so the same build works on GitHub Pages (/Stargaze/), itch.io and a plain folder.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        audioLab: fileURLToPath(new URL('./audio-lab.html', import.meta.url)),
      },
    },
  },
  server: { host: true },
});
