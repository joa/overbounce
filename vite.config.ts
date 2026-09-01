// `vitest/config` rather than `vite`: it is Vite's own `defineConfig` with the
// `test` key typed on. Nothing about the dev server or the build changes.
import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

/**
 * `package.json`'s version, compiled in as `__APP_VERSION__`.
 *
 * Read with `readFileSync` rather than imported: a JSON import needs an import
 * attribute, and the config is loaded by whatever Node is on the machine.
 *
 * The one thing that reads it is the results screenshot's own footer stamp
 * (`ui/screens/results-export.ts`) -- a picture of a run that gets pasted
 * somewhere has to say which build produced it, or a screenshot from before a
 * physics change is indistinguishable from one after it. Declared for
 * TypeScript in `src/env.d.ts`.
 */
const pkgVersion: string = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
).version;

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
  define: { __APP_VERSION__: JSON.stringify(pkgVersion) },
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
  test: {
    /*
     * `--expose-gc`, for `test/physics/allocation.test.ts`.
     *
     * That suite measures retained heap across twenty thousand physics ticks,
     * and without a forced collection at each end the numbers are whatever V8
     * happened to be doing -- it would be a coin toss, not a gate. The flag has
     * to reach the WORKER process, which is what `poolOptions` is for; setting
     * it on the parent does nothing, because tests do not run there.
     *
     * The suite skips itself when `global.gc` is absent and one always-on test
     * reports that it did, so losing this line shows up as a failure rather
     * than as a silently smaller run.
     */
    poolOptions: {
      forks: { execArgv: ['--expose-gc'] },
      threads: { execArgv: ['--expose-gc'] },
    },
  },
});
