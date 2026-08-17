import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Maps are fetched as raw binary from public/maps/.
    fs: { strict: true },
  },
  build: {
    target: 'esnext', // WebGPU needs top-level await
    sourcemap: true,
  },
  // .bsp files are served from public/ as static assets; no plugin needed.
});
