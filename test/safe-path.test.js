'use strict';

/*
 * Unit tests for lib/safe-path.js: multer's temporary file names, rebuilt upload paths and plain
 * file names inside a folder.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const { MULTER_NAME, fileInFolder, isInside } = require('../lib/safe-path');

test('MULTER_NAME matches the temporary names of multer only', () => {
	// multer's disk storage: crypto.randomBytes(16).toString('hex').
	for (let i = 0; i < 20; i += 1) assert.ok(MULTER_NAME.test(crypto.randomBytes(16).toString('hex')));
	['', 'abc', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(32)}.png`,
		`../${'a'.repeat(32)}`, `${'a'.repeat(32)}\n`, '..', '/etc/passwd']
		.forEach(name => assert.equal(MULTER_NAME.test(name), false, name));
});

test('rebuilding the temporary path keeps only the file name', () => {
	const tmp = path.resolve(os.tmpdir());
	const name = crypto.randomBytes(16).toString('hex');
	for (const given of [path.join(tmp, name), `/elsewhere/${name}`, `${tmp}/../x/${name}`]) {
		const rebuilt = path.join(tmp, path.basename(given));
		assert.equal(rebuilt, path.join(tmp, name));
		assert.ok(path.resolve(rebuilt).startsWith(tmp + path.sep));
	}
	assert.equal(path.basename('/x/..'), '..');
	assert.equal(MULTER_NAME.test(path.basename('/x/..')), false);
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
