// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'test/render/baseline/**'],
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
    files: ['src/physics/**/*.ts', 'src/collision/**/*.ts', 'src/math/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'three',
              message:
                'The physics/collision/math cores must not depend on THREE.js — they run headlessly in Node.',
            },
          ],
          patterns: [
            {
              group: ['three/*', '**/render/**', '**/assets/**'],
              message:
                'The physics/collision/math cores must not depend on rendering or asset code.',
            },
          ],
        },
      ],
    },
  },
);
