import js from '@eslint/js';
import globals from 'globals';
import sonarjs from 'eslint-plugin-sonarjs';

export default [
  {
    files: ['src/**/*.js', 'dist/build.user.js', 'test/**/*.js', 'build.js', 'eslint.config.mjs'],
    rules: {
      ...js.configs.recommended.rules,
      // Unused declarations and unresolved names need the assembled script's scope.
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Escaping is stylistic; host regexes also pass through custom transformations.
      'no-useless-escape': 'off',
      // Filename sanitizers intentionally match ASCII control characters.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/**/*.js'],
    languageOptions: { sourceType: 'script' },
    plugins: { sonarjs },
    rules: {
      'sonarjs/cognitive-complexity': ['warn', 25],
      'sonarjs/no-duplicated-branches': 'warn',
      'sonarjs/no-identical-functions': 'warn',
      'sonarjs/no-dead-store': 'warn',
      'sonarjs/no-identical-expressions': 'error',
    },
  },
  {
    // Source files share one scope after concatenation. Check names once here.
    files: ['dist/build.user.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        GM_xmlhttpRequest: 'readonly',
        GM_download: 'readonly',
        GM_getValue: 'readonly',
        GM: 'readonly',
        GM_setValue: 'readonly',
        GM_deleteValue: 'readonly',
        GM_addValueChangeListener: 'readonly',
        GM_removeValueChangeListener: 'readonly',
        GM_openInTab: 'readonly',
        GM_cookie: 'readonly',
        GM_log: 'readonly',
        GM_info: 'readonly',
        sha256: 'readonly',
        saveAs: 'readonly',
        isFF: 'writable',
        logs: 'writable',
        // Modules expose selected functions only when loaded by Bun tests.
        module: 'readonly',
      },
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.bun, ...globals.jest } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] },
  },
  {
    files: ['build.js', 'eslint.config.mjs'],
    languageOptions: { globals: globals.node },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'error' },
  },
];
