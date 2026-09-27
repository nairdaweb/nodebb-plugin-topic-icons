'use strict';

/*
 * Unit tests for lib/upload.js: type sniffing, SVG gate, the combined upload check and unique
 * file names.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const U = require('../lib/upload');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('﻿<?xml version="1.0"?>\n<!-- icon --><!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><use href="#a"/></svg>');

test('sniffType recognises PNG, WebP and SVG by content', () => {
	assert.equal(U.sniffType(PNG), 'png');
	assert.equal(U.sniffType(WEBP), 'webp');
	assert.equal(U.sniffType(SVG), 'svg');
	assert.equal(U.sniffType(Buffer.from('GIF89a')), '');
	assert.equal(U.sniffType(Buffer.from('<html><svg></svg>')), '');
	assert.equal(U.sniffType(Buffer.alloc(0)), '');
});

test('isSafeSvg refuses scripts, handlers and external links', () => {
	assert.equal(U.isSafeSvg(SVG.toString()), true);
	['<svg><script>alert(1)</script></svg>', '<svg onload="x()">', '<svg><a href="https://x">', '<svg><image xlink:href="http://x/a.png"/>',
		'<svg><foreignObject>', '<svg><a href="javascript:x">', '<!ENTITY x "y"><svg>', '<svg><use href=//evil/x.svg#a>'].forEach(s => assert.equal(U.isSafeSvg(s), false, s));
});

test('checkUpload: extension, MIME type and content must agree; size limit', () => {
	assert.deepEqual(U.checkUpload({ originalname: 'a.PNG', mimetype: 'image/png', size: 100 }, PNG), { ext: 'png' });
	assert.deepEqual(U.checkUpload({ originalname: 'a.svg', mimetype: 'image/svg+xml', size: 100 }, SVG), { ext: 'svg' });
	assert.deepEqual(U.checkUpload({ originalname: 'a.png', mimetype: 'image/png', size: 100 }, SVG), { error: 'upload-type' }, 'renamed SVG');
	assert.deepEqual(U.checkUpload({ originalname: 'a.png', mimetype: 'image/svg+xml', size: 100 }, PNG), { error: 'upload-type' });
	assert.deepEqual(U.checkUpload({ originalname: 'a.gif', mimetype: 'image/gif', size: 100 }, PNG), { error: 'upload-type' });
	assert.deepEqual(U.checkUpload({ originalname: 'a.png', size: U.MAX_BYTES + 1 }, PNG), { error: 'upload-size' });
	assert.deepEqual(U.checkUpload({ originalname: 'a.png', size: 0 }, PNG), { error: 'upload-missing' });
	assert.deepEqual(U.checkUpload(null, PNG), { error: 'upload-missing' });
});

test('uniqueName never contains the original name and differs per upload', () => {
	assert.equal(U.uniqueName('png', 'ABCdef12', 36 ** 3), 'ti-1000-abcdef12.png');
	assert.equal(U.uniqueName('svg', '../../x'), U.uniqueName('svg', '../../x').replace(/[^a-z0-9.-]/g, ''));
	assert.notEqual(U.uniqueName('png', 'aa'), U.uniqueName('png', 'bb'));
});
