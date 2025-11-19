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
      },
    },
    rules: {
      'obsidianmd/ui/sentence-case': [
        'error',
        {
          allowAutoFix: true,
        },
      ],
    },
  },
]);
