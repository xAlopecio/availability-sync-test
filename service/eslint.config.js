// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// Basic rules on purpose: catch real mistakes, leave style to Prettier. One type-aware rule
// for production code: a promise that is neither awaited nor handled (core review, worker block).
export default tseslint.config(
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error', // use the Fastify (pino) logger
    },
  },
  {
    // Tests reach production code only through the #src subpath import (SPEC §3).
    files: ['test/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/src/**'], message: 'Import production code as #src/... in tests.' },
          ],
        },
      ],
    },
  },
  {
    // Production code uses relative imports; #src is for tests only. (A regex, because the
    // gitignore-style `group` syntax treats a leading # as a comment and ignores the pattern.)
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '^#src/', message: 'Use relative imports inside src/.' }] },
      ],
    },
  },
  {
    // Tests may print diagnostics for intermittent failures; production code must use the logger.
    files: ['test/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { '@typescript-eslint/no-floating-promises': 'error' },
  },
  prettier,
);
