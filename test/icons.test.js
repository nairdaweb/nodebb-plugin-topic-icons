'use strict';

/*
 * Unit tests for lib/icons.js: settings validation, per-category choice, defaults, URL and id
 * cleaning, and the icon markup (escaping, no translation tokens).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const I = require('../lib/icons');

const lib = [
	{ id: 'question', key: 'question', name: '', url: '/assets/plugins/nodebb-plugin-topic-icons/icons/question.svg', cids: [], active: true },
	{ id: 'linux', name: 'Linux', url: '/assets/uploads/topic-icons/ti-1.png', cids: [2, 3], active: true },
	{ id: 'old', name: 'Old', url: 'https://cdn.example.com/i/old.webp', cids: [], active: false },
];

test('normalize: never saved → built-in set; saved empty list stays empty', () => {
	const fresh = I.normalize({});
	assert.deepEqual(fresh.icons.map(i => i.id), I.BUILTIN_KEYS);
	assert.equal(fresh.chooser, 'all');
	assert.equal(fresh.showInList, true);
	assert.equal(I.normalize({ icons: '[]' }).icons.length, 0);
	assert.equal(I.normalize({ icons: 'not json' }).icons.length, I.BUILTIN_KEYS.length);
});

test('normalize drops invalid entries and unknown defaults', () => {
	const c = I.normalize({
		icons: JSON.stringify(lib.concat([{ id: 'Bad ID', url: '/x.png' }, { id: 'nourl', url: 'javascript:alert(1)' }, { id: 'linux', url: '/dup.png' }])),
		defaultIcon: 'missing',
		categoryDefaults: JSON.stringify({ 2: 'linux', 3: 'missing', abc: 'linux' }),
		chooser: 'everyone',
		showInList: 'off',
	});
	assert.deepEqual(c.icons.map(i => i.id), ['question', 'linux', 'old']);
	assert.equal(c.defaultIcon, '');
	assert.deepEqual(c.categoryDefaults, { 2: 'linux' });
	assert.equal(c.chooser, 'all');
	assert.equal(c.showInList, false);
});

test('cleanUrl: only relative or https paths to png/webp/svg, no backslashes', () => {
	['/assets/uploads/topic-icons/a.png', '/a.svg?v=2', 'https://cdn.example.com/x/y.webp'].forEach(u => assert.equal(I.cleanUrl(u), u, u));
	['//evil.com/a.png', '/\\evil.com/a.png', '/a\\b.png', 'http://x.com/a.png', 'javascript:alert(1)//.png', '/a.gif', '/a.png" onerror="x',
		'data:image/svg+xml,<svg>.svg', 'https://x.com', '/../../etc/a.png', 'a.png', ' /a b.png'].forEach(u => assert.equal(I.cleanUrl(u), '', u));
});

test('cleanId / cleanCids', () => {
	assert.equal(I.cleanId('c-abc-1'), 'c-abc-1');
	['', '-a', 'A', 'a b', 'a'.repeat(41), '<x>'].forEach(v => assert.equal(I.cleanId(v), '', v));
	assert.deepEqual(I.cleanCids(['2', 3, 3, '0', '-1', 'x', 1.5]), [2, 3]);
	assert.deepEqual(I.cleanCids('2'), []);
});

test('validateSettings reports problems with row numbers only', () => {
	const bad = I.validateSettings({
		icons: JSON.stringify([{ id: 'a', name: '[[global:home]]', url: '/a.gif' }, { id: 'a', name: 'B', url: '/b.png' }, { id: 'c', name: '', url: '/c.png' }]),
		chooser: 'group',
		chooserGroup: '',
		defaultIcon: 'zzz',
		categoryDefaults: JSON.stringify({ 5: 'nope' }),
	});
	assert.deepEqual(bad.errors, [
		'[[admin/plugins/topic-icons:error.row-url, 1]]',
		'[[admin/plugins/topic-icons:error.row-duplicate, 2]]',
		'[[admin/plugins/topic-icons:error.row-no-name, 3]]',
		'[[admin/plugins/topic-icons:error.chooser-group]]',
		'[[admin/plugins/topic-icons:error.default-unknown]]',
		'[[admin/plugins/topic-icons:error.category-default-unknown, 5]]',
	]);
	const good = I.validateSettings({ icons: JSON.stringify(lib), chooser: 'mods', defaultIcon: 'question', categoryDefaults: '{"2":"linux"}', showInTopic: 'off' });
	assert.deepEqual(good.errors, []);
	assert.equal(good.settings.showInTopic, 'off');
	assert.equal(good.settings.showInList, 'on');
	assert.deepEqual(JSON.parse(good.settings.icons).map(i => i.id), ['question', 'linux', 'old']);
	assert.equal(I.validateSettings({ icons: '{' }).errors[0], '[[admin/plugins/topic-icons:error.icons-json]]');
});

test('iconsFor: active icons of the category, in library order', () => {
	const c = I.normalize({ icons: JSON.stringify(lib) });
	assert.deepEqual(I.iconsFor(c, 2).map(i => i.id), ['question', 'linux']);
	assert.deepEqual(I.iconsFor(c, '1').map(i => i.id), ['question']);
	assert.equal(I.isOffered(I.findIcon(c, 'old'), 1), false, 'inactive');
});

test('effectiveIcon: own icon (even if inactive) → category default → forum default', () => {
	const c = I.normalize({ icons: JSON.stringify(lib), defaultIcon: 'question', categoryDefaults: '{"3":"linux","4":"old"}' });
	assert.deepEqual(I.effectiveIcon(c, 'old', 1), { icon: I.findIcon(c, 'old'), isDefault: false });
	assert.equal(I.effectiveIcon(c, '', 3).icon.id, 'linux');
	assert.equal(I.effectiveIcon(c, 'deleted', 3).isDefault, true);
	assert.equal(I.effectiveIcon(c, '', 4).icon.id, 'question', 'inactive category default is skipped');
	assert.equal(I.effectiveIcon(c, undefined, 9).icon.id, 'question');
	assert.equal(I.effectiveIcon(I.normalize({ icons: '[]' }), 'x', 1), null);
});

test('nameSource: typed name, built-in translation, generic label', () => {
	const c = I.normalize({ icons: JSON.stringify(lib.concat([{ id: 'n', url: '/n.png' }])) });
	assert.deepEqual(I.nameSource(I.findIcon(c, 'linux')), { text: 'Linux' });
	assert.deepEqual(I.nameSource(I.findIcon(c, 'question')), { token: '[[topic-icons:icon.question]]' });
	assert.deepEqual(I.nameSource(I.findIcon(c, 'n')), { token: '[[topic-icons:icon-generic]]' });
});

test('buildHtml escapes the name, keeps [[ ]] out of the markup and adds relative_path', () => {
	const icon = I.normalize({ icons: JSON.stringify(lib) }).icons[1];
	const html = I.buildHtml(icon, '<b>"x"</b> [[global:home]]', { relativePath: '/forum', lang: 'pl' });
	assert.ok(html.includes('src="/forum/assets/uploads/topic-icons/ti-1.png"'));
	assert.ok(html.includes('alt="&lt;b&gt;&quot;x&quot;&lt;/b&gt; &lsqb;&lsqb;global:home&rsqb;&rsqb;"'));
	assert.ok(!html.includes('[['));
	assert.ok(!html.includes('<b>'));
	assert.ok(html.includes('data-ti-lang="pl"'));
	assert.ok(/^<span class="topic-icon"[^>]*><img [^>]*referrerpolicy="no-referrer"><\/span>$/.test(html));
	assert.equal(I.withRelativePath('/forum/a.png', '/forum'), '/forum/a.png');
	assert.equal(I.withRelativePath('https://x.com/a.png', '/forum'), 'https://x.com/a.png');
	assert.ok(I.buildHtml(icon, 'x', { isDefault: true }).startsWith('<span class="topic-icon topic-icon--default"'));
});

test('escape never produces a translation token and uses named bracket entities', () => {
	assert.equal(I.escape('[[a:b]]'), '&lsqb;&lsqb;a:b&rsqb;&rsqb;');
	assert.ok(!I.escape('[[x]]').includes('&#91;'));
	assert.equal(I.escape(null), '');
});
