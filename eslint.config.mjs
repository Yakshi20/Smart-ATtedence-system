import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Tenant isolation depends on not silently widening types at a boundary.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
    },
  },
  {
    // Test files legitimately fabricate partial objects to stand in for framework types.
    files: ['**/*.test.ts', '**/testing/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Tooling config files are CommonJS scripts run by Node, not application source.
    files: ['**/*.config.js', '**/jest.base.js'],
    languageOptions: {
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
