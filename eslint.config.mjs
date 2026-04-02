import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores
  {
    ignores: ['out/', 'dist/', '.electron-vite/', 'node_modules/', 'prisma/migrations/'],
  },

  // Base: JS recommended
  js.configs.recommended,

  // TypeScript recommended (syntax-only, no type-checked for speed)
  ...tseslint.configs.recommended,

  // Prettier compat (disables formatting rules that conflict)
  eslintConfigPrettier,

  // Global settings for all source files
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      // Loosen a few TS rules that are too noisy for an existing codebase
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Renderer-specific: add browser globals + React hooks (with compiler-powered rules)
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // Test files: relax some rules
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
