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
	assert.deepEqual(Object.keys(I.validateSettings({ icons: '[]', undefined: '[]', other: 'x' }).settings).sort(),
		['categoryDefaults', 'chooser', 'chooserGroup', 'defaultIcon', 'icons', 'showInList', 'showInTopic']);
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

/** Minimal stand-in for document: elements record attributes and children, nothing is parsed. */
const fakeDoc = {
	createElement(tag) {
		return {
			tagName: tag.toUpperCase(),
			className: '',
			attrs: {},
			children: [],
			setAttribute(name, value) { this.attrs[name] = String(value); },
			appendChild(child) { this.children.push(child); return child; },
		};
	},
};

test('buildElement builds the icon with DOM methods and refuses bad ids and URLs', () => {
	const el = I.buildElement(fakeDoc, { id: 'linux', name: '<img src=x onerror=alert(1)>', url: '/forum/assets/uploads/topic-icons/ti-1.png', isDefault: true }, { lang: 'pl' });
	assert.equal(el.tagName, 'SPAN');
	assert.equal(el.className, 'topic-icon topic-icon--default');
	assert.deepEqual(el.attrs, { 'data-topic-icon': 'linux', 'data-ti-lang': 'pl' });
	const img = el.children[0];
	assert.equal(img.tagName, 'IMG');
	assert.equal(img.attrs.src, '/forum/assets/uploads/topic-icons/ti-1.png');
	assert.equal(img.attrs.alt, '<img src=x onerror=alert(1)>', 'the name stays text');
	assert.equal(img.attrs.referrerpolicy, 'no-referrer');
	assert.equal(I.buildElement(fakeDoc, { id: 'a', name: 'x', url: 'https://cdn.example.com/a.svg' }).className, 'topic-icon');
	['javascript:alert(1)', '//evil.example/a.png', 'data:image/png;base64,AAAA', '/a.png" onerror="x', 'http://x.com/a.png', '/x/../a.png']
		.forEach(url => assert.equal(I.buildElement(fakeDoc, { id: 'a', name: 'x', url }), null, url));
	assert.equal(I.buildElement(fakeDoc, { id: '"><x', name: 'x', url: '/a.png' }), null);
	assert.equal(I.buildElement(fakeDoc, null), null);
});

test('escape never produces a translation token and uses named bracket entities', () => {
	assert.equal(I.escape('[[a:b]]'), '&lsqb;&lsqb;a:b&rsqb;&rsqb;');
	assert.ok(!I.escape('[[x]]').includes('&#91;'));
	assert.equal(I.escape(null), '');
});

test('cleanUrl refuses percent-encoded dot segments and slashes', () => {
	['/assets/uploads/topic-icons/%2e%2e/%2E%2E/x.svg', '/a/%2e/b.png', '/a/./b.png', '/a/..%2fb.png', '/a/%5cb.png']
		.forEach(u => assert.equal(I.cleanUrl(u), '', u));
	assert.equal(I.cleanUrl('https://cdn.example.com/a%20b/c.png'), 'https://cdn.example.com/a%20b/c.png');
});

test('decodeEntities turns escaped text into plain text without parsing HTML', () => {
	assert.equal(I.decodeEntities('Tom &amp; Jerry &quot;x&quot; &#39;y&#x27; &lsqb;&lsqb;a:b&rsqb;&rsqb;'), 'Tom & Jerry "x" \'y\' [[a:b]]');
	assert.equal(I.decodeEntities('&lt;img src=x onerror=alert(1)&gt;'), '<img src=x onerror=alert(1)>', 'stays text');
	assert.equal(I.decodeEntities('&hellip; &#8222;&#x201D; &unknown; &#0; &#xD800;'), '… „” &unknown; &#0; &#xD800;');
	assert.equal(I.decodeEntities(I.escape('a<b>&"c"[d]')), 'a<b>&"c"[d]');
	assert.equal(I.decodeEntities(null), '');
	assert.equal(I.decodeEntities('&amp;lt;'), '&lt;', 'decoded once');
});

test('validateSettings: the chooser group must exist and must not be a group nobody can post from', () => {
	const base = { icons: JSON.stringify(lib), chooser: 'group' };
	assert.deepEqual(I.validateSettings(Object.assign({ chooserGroup: 'helpers' }, base), { groupExists: false }).errors,
		['[[admin/plugins/topic-icons:error.chooser-group-missing]]']);
	assert.deepEqual(I.validateSettings(Object.assign({ chooserGroup: 'helpers' }, base), { groupExists: true }).errors, []);
	assert.deepEqual(I.validateSettings(Object.assign({ chooserGroup: 'helpers' }, base)).errors, [], 'not checked without the flag');
	['guests', 'banned-users', 'spiders'].forEach(g => assert.deepEqual(
		I.validateSettings(Object.assign({ chooserGroup: g }, base), { groupExists: true }).errors,
		['[[admin/plugins/topic-icons:error.chooser-group-invalid]]'], g));
	assert.deepEqual(I.validateSettings({ icons: JSON.stringify(lib), chooser: 'all', chooserGroup: 'gone' }, { groupExists: false }).errors, [],
		'only checked for chooser "group"');
});

test('validateSettings on a partial save merged with the stored settings keeps the other keys', () => {
	const stored = I.validateSettings({ icons: JSON.stringify(lib), chooser: 'mods', defaultIcon: 'question', categoryDefaults: '{"2":"linux"}' }).settings;
	const merged = Object.assign({}, I.defaults(), stored, { showInList: 'off' });
	const result = I.validateSettings(merged);
	assert.deepEqual(result.errors, []);
	assert.equal(result.settings.showInList, 'off');
	assert.equal(result.settings.chooser, 'mods');
	assert.equal(result.settings.icons, stored.icons);
	assert.equal(result.settings.categoryDefaults, stored.categoryDefaults);
	// Never saved before: the built-in library comes from the defaults.
	const fresh = I.validateSettings(Object.assign({}, I.defaults(), {}, { showInList: 'off' }));
	assert.deepEqual(fresh.errors, []);
	assert.deepEqual(JSON.parse(fresh.settings.icons).map(i => i.id), I.BUILTIN_KEYS);
});

test('libraryChanges: removed icons and uploaded files no icon uses any more', () => {
	const up = name => `/assets/uploads/topic-icons/${name}`;
	const before = [
		{ id: 'a', url: up('ti-abc-0123.png') },
		{ id: 'b', url: up('ti-abd-4567.svg') },
		{ id: 'c', url: '/assets/plugins/nodebb-plugin-topic-icons/icons/idea.svg' },
		{ id: 'd', url: up('../ti-x-1.png') },
	];
	const after = [
		{ id: 'b', url: up('ti-new-89ab.svg') }, // image replaced
		{ id: 'c', url: '/assets/plugins/nodebb-plugin-topic-icons/icons/idea.svg' },
		{ id: 'e', url: up('ti-abc-0123.png') }, // the removed icon's file is still used here
	];
	assert.deepEqual(I.libraryChanges(before, after), { ids: ['a', 'd'], files: ['ti-abd-4567.svg'] });
	assert.deepEqual(I.libraryChanges(after, after), { ids: [], files: [] });
	assert.equal(I.uploadedFile(up('ti-abc-0123.png?v=1')), 'ti-abc-0123.png');
	['/assets/uploads/topic-icons/x.png', '/assets/uploads/topic-icons/ti-a-b/../x.png', 'https://x.com/assets/uploads/topic-icons/ti-a-0.png', null]
		.forEach(u => assert.equal(I.uploadedFile(u), '', String(u)));
});

test('categoryTree: parents before children, siblings by order, with depth', () => {
	const tree = I.categoryTree([
		{ cid: 3, parentCid: 1, order: 2, name: 'C' },
		{ cid: 1, parentCid: 0, order: 2, name: 'A' },
		{ cid: 2, parentCid: 1, order: 1, name: 'B' },
		{ cid: 4, parentCid: 0, order: 1, name: 'D' },
		{ cid: 5, parentCid: 99, order: 1, name: 'orphan' },
		{ cid: 6, parentCid: 7, name: 'loop1' },
		{ cid: 7, parentCid: 6, name: 'loop2' },
	]);
	assert.deepEqual(tree.map(c => `${c.cid}:${c.depth}`), ['4:0', '5:0', '1:0', '2:1', '3:1', '6:0', '7:0']);
	assert.deepEqual(I.categoryTree(null), []);
});
