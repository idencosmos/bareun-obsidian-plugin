import tsparser from '@typescript-eslint/parser';
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig([
  {
    ignores: ['main.js', 'main.js.map', 'node_modules/**'],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir,
      },
      globals: {
        console: 'readonly',
        window: 'readonly',
        Buffer: 'readonly',
        document: 'readonly',
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      noInlineConfig: true,
    },
    rules: {
      '@typescript-eslint/require-await': 'error',
      // Keep sentence-case checks strict (no plugin-specific brand exceptions) to mirror marketplace review.
      'obsidianmd/ui/sentence-case': ['error', { enforceCamelCaseLower: true }],
    },
  },
]);
