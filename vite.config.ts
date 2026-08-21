import { defineConfig } from 'vite';

/**
 * Root by default -- every local flow (`npm run dev`, `npm run build` for a
 * self-hosted deploy) serves from `/` and needs nothing here. GitHub Pages
 * project sites do not: `joa.github.io/overbounce/` is a subpath, and Vite's
 * own asset rewriting only fixes `<script>`/`<link>` tags in `index.html` --
 * it has no way to know about the handful of runtime `fetch('/pak0.pk3')`-
 * style calls this app also makes (course-select.ts, main.ts's ?devpak=
 * path), which read this same value through `import.meta.env.BASE_URL` for
 * exactly this reason. `.github/workflows/deploy-pages.yml` sets this env var
 * for its build step; nothing else ever needs to.
 */
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
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
