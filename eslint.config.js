// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // design/support.js is dc-runtime's generated bundle for the Claude
    // Design canvases in design/ -- not project source, and it predates the
    // project's own lint rules (no browser globals declared, etc).
    ignores: ['dist/**', 'node_modules/**', 'test/render/baseline/**', 'design/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The project forbids `any` outright.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The physics and collision cores must stay renderer-free so they can run
    // headlessly in Node. This is what makes `npm run test:physics` possible.
    //
    // `src/demo/` and `src/playback/` join them for the same reason and by
    // the same argument: a `.dm_68` decoder that needs a GPU cannot be tested
    // from `npm run demo-info`, and a timeline whose easing curves are welded
    // to a THREE camera cannot be tested at all. `src/playback/` may reach
    // into physics/game (a ghost clip re-simulates, so it builds a `Game`);
    // it may not reach into rendering.
    files: [
      'src/physics/**/*.ts',
      'src/collision/**/*.ts',
      'src/math/**/*.ts',
      'src/demo/**/*.ts',
      'src/playback/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'three',
              message:
                'The physics/collision/math/demo/playback cores must not depend on THREE.js — they run headlessly in Node.',
            },
          ],
          patterns: [
            {
              group: ['three/*', '**/render/**', '**/assets/**'],
              message:
                'The physics/collision/math/demo/playback cores must not depend on rendering or asset code.',
            },
          ],
        },
      ],
    },
  },
);
