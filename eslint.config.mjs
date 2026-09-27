import js from '@eslint/js';
import globals from 'globals';

export default [
	{ ignores: ['node_modules/**', 'static/**'] },
	js.configs.recommended,
	{
		files: ['library.js', 'lib/**/*.js', 'test/**/*.js'],
		languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
		rules: {
			'no-control-regex': 'off',
			indent: ['error', 'tab', { SwitchCase: 1 }],
			quotes: ['error', 'single', { avoidEscape: true }],
			semi: ['error', 'always'],
			'prefer-const': 'error',
			'no-var': 'error',
		},
	},
	{
		files: ['public/**/*.js'],
		languageOptions: {
			ecmaVersion: 2020,
			sourceType: 'script',
			globals: { ...globals.browser, define: 'readonly', require: 'readonly', $: 'readonly', ajaxify: 'readonly', config: 'readonly' },
		},
		rules: {
			indent: ['error', 'tab', { SwitchCase: 1 }],
			quotes: ['error', 'single', { avoidEscape: true }],
			semi: ['error', 'always'],
		},
	},
];
