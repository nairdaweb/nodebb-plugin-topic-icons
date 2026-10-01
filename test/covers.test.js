'use strict';

/*
 * Unit tests for lib/covers.js: order of cover sources, first image of a post (Markdown and
 * HTML), URL checks, settings, thumbnail objects, clean-up of uploaded covers; and the cover
 * checks of lib/upload.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../lib/covers');
const U = require('../lib/upload');

const SITE = { uploadUrl: '/assets/uploads', relativePath: '', baseUrl: 'https://forum.example' };
const config = overrides => Object.assign(C.normalize({ coverAuto: 'on' }), overrides || {});

test('pickCover: own thumbnails → first image → category default → none', () => {
	const c = config({ categoryCovers: { 3: '/assets/uploads/topic-icons/tc-a-1.webp' } });
	const scan = { local: '/files/1-a.png', any: 'https://img.example/b.jpg' };
	assert.deepEqual(C.pickCover(c, { hasThumbs: true, cid: 3, scan }), { source: 'own' });
	assert.deepEqual(C.pickCover(c, { cid: 3, scan }), { source: 'auto', local: '/files/1-a.png' });
	assert.deepEqual(C.pickCover(c, { cid: 3, scan: { local: '', any: '' } }), { source: 'category', url: '/assets/uploads/topic-icons/tc-a-1.webp' });
	assert.deepEqual(C.pickCover(c, { cid: 3, scan: null }), { source: 'category', url: '/assets/uploads/topic-icons/tc-a-1.webp' });
	assert.equal(C.pickCover(c, { cid: 4, scan: null }), null);
});

test('pickCover: external images only when allowed, in post order', () => {
	const scan = { local: '/files/2-b.png', any: 'https://img.example/a.jpg' };
	assert.deepEqual(C.pickCover(config(), { cid: 1, scan }), { source: 'auto', local: '/files/2-b.png' });
	assert.deepEqual(C.pickCover(config({ external: true }), { cid: 1, scan }), { source: 'auto', external: 'https://img.example/a.jpg' });
	assert.equal(C.pickCover(config(), { cid: 1, scan: { local: '', any: 'https://img.example/a.jpg' } }), null);
});

test('pickCover: switches and private uploads', () => {
	const scan = { local: '/files/1-a.png', any: '/files/1-a.png' };
	const covers = { 1: '/assets/uploads/topic-icons/tc-a-1.png' };
	assert.deepEqual(C.pickCover(config({ auto: false, categoryCovers: covers }), { cid: 1, scan }), { source: 'category', url: covers[1] });
	assert.equal(C.pickCover(config({ auto: false, category: false, categoryCovers: covers }), { cid: 1, scan }), null);
	// Guests do not get forum uploads from posts when uploads are private (as NodeBB thumbnails).
	assert.deepEqual(C.pickCover(config({ categoryCovers: covers }), { cid: 1, scan, guest: true, privateUploads: true }), { source: 'category', url: covers[1] });
	assert.deepEqual(C.pickCover(config(), { cid: 1, scan, guest: true, privateUploads: false }), { source: 'auto', local: '/files/1-a.png' });
});

test('extractImages: Markdown, reference images and HTML in document order', () => {
	const md = [
		'Intro ![first](/assets/uploads/files/1-a.png "Title") text',
		'<img alt="x" src="https://img.example/b.jpg?w=1&amp;h=2">',
		'![ref][pic] and ![<spaced>](<https://img.example/c d.png>)',
		'',
		'[pic]: https://img.example/ref.webp "t"',
	].join('\n');
	assert.deepEqual(C.extractImages(md), [
		'/assets/uploads/files/1-a.png',
		'https://img.example/b.jpg?w=1&h=2',
		'https://img.example/ref.webp',
		'https://img.example/c d.png',
	]);
});

test('extractImages: images in code and comments are skipped', () => {
	const md = [
		'```md',
		'![in fence](/assets/uploads/files/1-code.png)',
		'```',
		'~~~',
		'<img src="/assets/uploads/files/2-tilde.png">',
		'~~~',
		'`![inline](/assets/uploads/files/3-inline.png)`',
		'<pre><code><img src="/assets/uploads/files/4-pre.png"></code></pre>',
		'<!-- ![hidden](/assets/uploads/files/5-comment.png) -->',
		'![real](/assets/uploads/files/6-real.png)',
	].join('\n');
	assert.deepEqual(C.extractImages(md), ['/assets/uploads/files/6-real.png']);
	assert.deepEqual(C.extractImages(''), []);
	assert.deepEqual(C.extractImages(null), []);
	assert.deepEqual(C.extractImages('[link](/assets/uploads/files/1-a.png) no image'), []);
});

test('scanPost: first forum upload and first image of any accepted kind', () => {
	const md = '![](https://img.example/a.jpg) ![](/assets/uploads/files/1-b.png) ![](/assets/uploads/files/2-c.png)';
	assert.deepEqual(C.scanPost(md, SITE), { local: '/files/1-b.png', any: 'https://img.example/a.jpg' });
	assert.deepEqual(C.scanPost('![](/assets/uploads/files/1-b.png)', SITE), { local: '/files/1-b.png', any: '/files/1-b.png' });
	assert.deepEqual(C.scanPost('no images', SITE), { local: '', any: '' });
	// Not images of the forum, nor http(s): ignored.
	assert.deepEqual(C.scanPost('![](javascript:alert(1)) ![](data:image/png;base64,AAA) ![](/plugins/x.png)', SITE), { local: '', any: '' });
});

test('classifyUrl: forum uploads in every spelling, external http(s) only', () => {
	assert.deepEqual(C.classifyUrl('/assets/uploads/files/1-a.png', SITE), { type: 'local', path: '/files/1-a.png' });
	assert.deepEqual(C.classifyUrl('https://forum.example/assets/uploads/files/1-a.PNG?x=1', SITE), { type: 'local', path: '/files/1-a.PNG?x=1' });
	assert.deepEqual(C.classifyUrl('http://forum.example/assets/uploads/files/1-a.jpg', SITE), { type: 'local', path: '/files/1-a.jpg' });
	assert.deepEqual(C.classifyUrl('/forum/assets/uploads/files/1-a.webp', Object.assign({}, SITE, { relativePath: '/forum' })), { type: 'local', path: '/files/1-a.webp' });
	assert.deepEqual(C.classifyUrl('http://img.example/a', SITE), { type: 'external', url: 'http://img.example/a' });
	assert.deepEqual(C.classifyUrl('https://img.example:8443/a.png', SITE), { type: 'external', url: 'https://img.example:8443/a.png' });
	[
		'', '/assets/uploads/files/1-a.exe', '/assets/uploads/../secret.png', '/assets/uploads/files/%2e%2e/a.png',
		'/assets/uploads/files%2fa.png', '//evil.example/a.png', '/\\evil.example/a.png', '/assets/other/a.png',
		'ftp://img.example/a.png', 'https://user:pw@img.example/a.png', 'https://img.example/a".png',
		'https://img.example/a<b>.png', 'javascript:alert(1)', 'https:/img.example/a.png', 'https://img example/a.png',
		`https://img.example/${'a'.repeat(1001)}.png`,
	].forEach((url) => {
		assert.equal(C.classifyUrl(url, SITE), null, url);
	});
});

test('cleanAdminUrl: site paths and https URLs of images', () => {
	assert.equal(C.cleanAdminUrl(' /assets/uploads/topic-icons/tc-a-1.webp '), '/assets/uploads/topic-icons/tc-a-1.webp');
	assert.equal(C.cleanAdminUrl('https://cdn.example/cover.jpeg?v=2'), 'https://cdn.example/cover.jpeg?v=2');
	['http://cdn.example/a.png', '//cdn.example/a.png', '/a.txt', '/a/../b.png', 'https://u@cdn.example/a.png', '/a b.png', 'javascript:x.png', '/a".png']
		.forEach(url => assert.equal(C.cleanAdminUrl(url), '', url));
});

test('scan results are stored with their first post', () => {
	const stored = C.serializeScan(12, { local: '/files/1-a.png', any: '/files/1-a.png' });
	assert.deepEqual(C.parseScan(stored), { pid: '12', local: '/files/1-a.png', any: '/files/1-a.png' });
	assert.equal(C.parseScan(''), null);
	assert.equal(C.parseScan('{bad'), null);
	assert.equal(C.parseScan('{"local":"/files/a.png"}'), null);
	assert.deepEqual(C.parseScan('{"pid":1,"local":5}'), { pid: '1', local: '', any: '' });
});

test('defaults and normalize: category covers on, automatic covers and external images off', () => {
	const c = C.normalize(C.defaults());
	assert.deepEqual(c, { category: true, auto: false, external: false, style: true, phones: true, ratio: '4-3', categoryCovers: {} });
	assert.deepEqual(C.normalize({}), c);
	const n = C.normalize({ coverRatio: 'square', coverStyle: 'off', categoryCovers: '{"2":"/assets/uploads/x.png","x":"/a.png","3":"javascript:1"}' });
	assert.equal(n.ratio, 'square');
	assert.equal(n.style, false);
	assert.deepEqual(n.categoryCovers, { 2: '/assets/uploads/x.png' });
	assert.equal(C.normalize({ coverRatio: '16-9' }).ratio, '4-3');
});

test('validateSettings: errors for bad covers and ratio, cleaned stored form', () => {
	const ok = C.validateSettings({ coverAuto: 'on', coverRatio: 'square', categoryCovers: '{"5":" /assets/uploads/topic-icons/tc-a-1.png ","6":""}' });
	assert.deepEqual(ok.errors, []);
	assert.deepEqual(ok.settings, {
		coverCategory: 'on', coverAuto: 'on', coverExternal: 'off', coverStyle: 'on', coverPhones: 'on', coverRatio: 'square',
		categoryCovers: '{"5":"/assets/uploads/topic-icons/tc-a-1.png"}',
	});
	const bad = C.validateSettings({ coverRatio: 'wide', categoryCovers: '{"7":"http://x.example/a.png","x":"/a.png"}' });
	assert.deepEqual(bad.errors, [
		'[[admin/plugins/topic-icons:error.cover-ratio]]',
		'[[admin/plugins/topic-icons:error.category-cover-url, 7]]',
		'[[admin/plugins/topic-icons:error.category-cover-url, 0]]',
	]);
	assert.deepEqual(C.validateSettings({ categoryCovers: '[1]' }).errors, ['[[admin/plugins/topic-icons:error.category-covers]]']);
});

test('toThumb: NodeBB thumbnail shape with relative_path and upload_url', () => {
	const site = { uploadUrl: '/assets/uploads', relativePath: '/forum' };
	assert.deepEqual(C.toThumb({ source: 'auto', local: '/files/1-a.png' }, 9, site), {
		id: '9', name: '1-a.png', path: '/files/1-a.png', url: '/forum/assets/uploads/files/1-a.png', cover: 'auto',
	});
	assert.deepEqual(C.toThumb({ source: 'auto', external: 'https://img.example/a.jpg?x' }, 9, site), {
		id: '9', name: 'a.jpg', path: 'https://img.example/a.jpg?x', url: 'https://img.example/a.jpg?x', cover: 'auto',
	});
	assert.deepEqual(C.toThumb({ source: 'category', url: '/assets/uploads/topic-icons/tc-a-1.webp' }, 9, site), {
		id: '9', name: 'tc-a-1.webp', path: '/topic-icons/tc-a-1.webp', url: '/forum/assets/uploads/topic-icons/tc-a-1.webp', cover: 'category',
	});
	assert.equal(C.toThumb({ source: 'category', url: '/img/c.png' }, 9, site).url, '/forum/img/c.png');
	assert.equal(C.toThumb({ source: 'category', url: 'https://cdn.example/c.png' }, 9, site).path, 'https://cdn.example/c.png');
});

test('uploaded cover files that a save leaves unused', () => {
	const a = '/assets/uploads/topic-icons/tc-abc-0123.png';
	const b = '/assets/uploads/topic-icons/tc-abd-4567.jpg';
	assert.equal(C.uploadedFile(a), 'tc-abc-0123.png');
	assert.equal(C.uploadedFile('/assets/uploads/topic-icons/ti-abc-0123.png'), '');
	assert.equal(C.uploadedFile('/assets/uploads/topic-icons/../tc-abc-0123.png'), '');
	assert.deepEqual(C.unusedFiles({ 1: a, 2: b, 3: 'https://cdn.example/x.png' }, { 2: b, 4: a }), []);
	assert.deepEqual(C.unusedFiles({ 1: a, 2: b }, { 2: b }), ['tc-abc-0123.png']);
});

test('bodyClasses follow the display settings', () => {
	assert.deepEqual(C.bodyClasses(C.normalize({})), ['topic-covers', 'topic-covers--4-3', 'topic-covers--phones']);
	assert.deepEqual(C.bodyClasses(C.normalize({ coverRatio: 'square', coverPhones: 'off' })), ['topic-covers', 'topic-covers--square']);
	assert.deepEqual(C.bodyClasses(C.normalize({ coverStyle: 'off' })), []);
});

test('cover uploads: PNG, JPEG, WebP, GIF and SVG up to the cover limit', () => {
	const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
	const GIF = Buffer.from('GIF89a\u0001\u0000');
	assert.equal(U.sniffType(JPG), 'jpg');
	assert.equal(U.sniffType(GIF), 'gif');
	assert.deepEqual(U.checkCoverUpload({ originalname: 'c.jpeg', mimetype: 'image/jpeg', size: 1000 }, JPG), { ext: 'jpg' });
	assert.deepEqual(U.checkCoverUpload({ originalname: 'c.gif', mimetype: 'image/gif', size: 1000 }, GIF), { ext: 'gif' });
	assert.deepEqual(U.checkCoverUpload({ originalname: 'c.jpg', mimetype: 'image/png', size: 1000 }, JPG), { error: 'upload-type' });
	assert.deepEqual(U.checkCoverUpload({ originalname: 'c.png', mimetype: 'image/png', size: 1000 }, JPG), { error: 'upload-type' });
	assert.deepEqual(U.checkCoverUpload({ originalname: 'c.jpg', mimetype: 'image/jpeg', size: U.COVER_MAX_BYTES + 1 }, JPG), { error: 'upload-size' });
	assert.deepEqual(U.checkCoverUpload({ originalname: 'c.bmp', mimetype: 'image/bmp', size: 10 }, JPG), { error: 'upload-type' });
	// Icons keep their own, smaller list.
	assert.deepEqual(U.checkUpload({ originalname: 'c.jpg', mimetype: 'image/jpeg', size: 1000 }, JPG), { error: 'upload-type' });
	assert.match(U.uniqueName('webp', 'ab12', 1, 'tc'), /^tc-1-ab12\.webp$/);
	assert.match(U.uniqueName('png', 'ab12', 1), /^ti-1-ab12\.png$/);
});
