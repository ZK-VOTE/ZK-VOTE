import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import jsdoc from 'eslint-plugin-jsdoc'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Generated contract bindings and build artifacts - these are auto-generated
  globalIgnores(['dist', 'src/contracts/**', 'src/lib/verification_key_soroban.json']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    plugins: {
      jsdoc,
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // ZV-130: no user-controlled HTML bypasses SafeMarkdown/Trusted Types.
      // Apply these rules to both production sources and future components.
      'no-restricted-syntax': [
        'error',
        { selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]', message: 'Use SafeMarkdown; raw HTML rendering is forbidden.' },
        { selector: 'AssignmentExpression[left.property.name="innerHTML"]', message: 'Raw innerHTML sinks are forbidden.' },
        { selector: 'CallExpression[callee.property.name="insertAdjacentHTML"]', message: 'Raw HTML insertion is forbidden.' },
      ],
      // Type safety: warn on explicit any to encourage proper typing
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // React hooks: keep exhaustive-deps enabled to catch stale closure bugs
      'react-hooks/exhaustive-deps': 'warn',
      // JSDoc: check that existing doc comments are valid
      'jsdoc/check-param-names': 'warn',
      'jsdoc/check-tag-names': 'warn',
      'jsdoc/check-types': 'warn',
      'jsdoc/valid-types': 'warn',
    },
  },
])
