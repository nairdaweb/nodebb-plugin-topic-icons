'use strict';

/*
 * Unit tests for lib/safe-path.js: temporary upload paths (inside the allowed folder, no "..",
 * no symbolic links, regular files only) and plain file names inside a folder.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { tempUploadPath, fileInFolder, isInside } = require('../lib/safe-path');

test('tempUploadPath accepts a regular file inside the allowed folder', async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-safe-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, 'uploads');
	const outside = path.join(dir, 'outside');
	fs.mkdirSync(root);
	fs.mkdirSync(outside);
	const good = path.join(root, '3f2a9c');
	fs.writeFileSync(good, 'x');
	const secret = path.join(outside, 'secret');
	fs.writeFileSync(secret, 'x');

	assert.equal(await tempUploadPath(good, [root]), fs.realpathSync(good));
	// Default root: the system temporary folder (where multer stores uploads).
	assert.equal(await tempUploadPath(good), fs.realpathSync(good));

	// Outside the allowed folder, through "..", missing, a folder, odd values.
	assert.equal(await tempUploadPath(secret, [root]), null);
	assert.equal(await tempUploadPath(path.join(root, '..', 'outside', 'secret'), [root]), null);
	assert.equal(await tempUploadPath(`${root}/../outside/secret`, [root]), null);
	assert.equal(await tempUploadPath(path.join(root, 'missing'), [root]), null);
	assert.equal(await tempUploadPath(root, [dir]), null);
	assert.equal(await tempUploadPath(root, [root]), null);
	assert.equal(await tempUploadPath(`${good}\0`, [root]), null);
	for (const bad of [undefined, null, '', 42, {}, 'x'.repeat(5000)]) {
		assert.equal(await tempUploadPath(bad, [root]), null);
	}
	// A root that does not exist allows nothing.
	assert.equal(await tempUploadPath(good, [path.join(dir, 'nope')]), null);
});

test('tempUploadPath refuses symbolic links, also through a linked folder', async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-safe-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, 'uploads');
	const outside = path.join(dir, 'outside');
	fs.mkdirSync(root);
	fs.mkdirSync(outside);
	const secret = path.join(outside, 'secret');
	fs.writeFileSync(secret, 'x');
	fs.symlinkSync(secret, path.join(root, 'link'));
	fs.symlinkSync(outside, path.join(root, 'linkdir'));

	assert.equal(await tempUploadPath(path.join(root, 'link'), [root]), null);
	assert.equal(await tempUploadPath(path.join(root, 'linkdir', 'secret'), [root]), null);
});

test('fileInFolder allows plain file names only', () => {
	const folder = path.resolve('/srv/uploads/topic-icons');
	assert.equal(fileInFolder(folder, 'ti-abc.png'), path.join(folder, 'ti-abc.png'));
	['', '.', '..', '.hidden', '../x.png', 'a/b.png', 'a\\b.png', '/etc/passwd', 'x\0.png', null, 7, 'x'.repeat(300)]
		.forEach(name => assert.equal(fileInFolder(folder, name), null, String(name)));
});

test('isInside needs a real child path', () => {
	const root = path.resolve('/a/b');
	assert.equal(isInside(root, path.resolve('/a/b/c')), true);
	assert.equal(isInside(root, root), false);
	assert.equal(isInside(root, path.resolve('/a/bc')), false);
	assert.equal(isInside(root, path.resolve('/a')), false);
});
