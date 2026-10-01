'use strict';

/*
 * Path checks for files the plugin reads or deletes. Unit-tested in test/safe-path.test.js.
 *
 * - MULTER_NAME: the form of the temporary file names written by NodeBB's multer middleware.
 *   library.js rebuilds the path of an upload from the temporary folder and such a name.
 * - fileInFolder(): a file name (no folders) inside a given folder, for the clean-up of
 *   uploaded icons and covers.
 */

const path = require('path');

/**
 * Names multer's disk storage gives temporary files: 16 random bytes in hex (multer 2.x,
 * storage/disk.js). Upload paths are rebuilt from the temporary folder and a name like this.
 */
const MULTER_NAME = /^[a-f0-9]{32}$/;

/**
 * @param {string} root real, absolute folder
 * @param {string} target real, absolute path
 * @returns {boolean} whether target lies strictly inside root
 */
function isInside(root, target) {
	const prefix = root.endsWith(path.sep) ? root : root + path.sep;
	return target.length > prefix.length && target.startsWith(prefix);
}

/**
 * Absolute path of a file directly inside a folder, or null when `name` is not a plain file
 * name (folders, "..", hidden files, NUL bytes).
 *
 * @param {string} folder
 * @param {*} name
 * @returns {string|null}
 */
function fileInFolder(folder, name) {
	if (typeof name !== 'string' || !name || name.length > 255 || name.startsWith('.') ||
		name.includes('\0') || /[\\/]/.test(name) || path.basename(name) !== name) return null;
	const root = path.resolve(folder);
	const target = path.resolve(root, name);
	return path.dirname(target) === root && isInside(root, target) ? target : null;
}

module.exports = { MULTER_NAME, fileInFolder, isInside };
