import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ffmpeg.wasm (single-thread core) works without special headers.
// If you later switch to the multi-thread core for speed, uncomment
// the headers block below and swap the core URLs in App.jsx to `-mt`.
export default defineConfig({
  plugins: [react()],
  // @ffmpeg/ffmpeg spins up an internal Worker (worker.js) at runtime. Vite's
  // esbuild-based dep pre-bundler doesn't handle that worker file correctly,
  // which causes stale "file does not exist ... .vite/deps/worker.js" errors
  // after the cache is invalidated. Excluding both packages from
  // optimizeDeps avoids pre-bundling them at all, which fixes it.
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  server: {
    // headers: {
    //   'Cross-Origin-Opener-Policy': 'same-origin',
    //   'Cross-Origin-Embedder-Policy': 'require-corp',
    // },
  },
});
