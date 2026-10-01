'use strict';

/*
 * Path checks for files the plugin reads or deletes. Unit-tested in test/safe-path.test.js.
 *
 * - tempUploadPath(): the temporary file of an upload (req.file.path, written by NodeBB's multer
 *   middleware into the system temporary folder). The path is used only when it is a regular
 *   file, not a symbolic link, without ".." segments, and its real location is inside one of the
 *   allowed folders. Everything else is refused, so a crafted path can never make the plugin
 *   read, copy or delete another file.
 * - fileInFolder(): a file name (no folders) inside a given folder, for the clean-up of
 *   uploaded icons and covers.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Longest path accepted. */
const MAX_PATH = 4096;

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
 * @param {*} p
 * @returns {boolean} whether p is a usable path string without ".." segments or NUL bytes
 */
function plainPath(p) {
	return typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH && !p.includes('\0') &&
		!p.split(/[\\/]+/).includes('..');
}

/**
 * Real path of a temporary upload file, or null when it must not be touched.
 *
 * @param {*} filePath req.file.path
 * @param {string[]} [roots] folders the file may be in (default: the system temporary folder,
 *   where NodeBB's multer middleware stores uploads)
 * @returns {Promise<string|null>}
 */
async function tempUploadPath(filePath, roots) {
	if (!plainPath(filePath)) return null;
	const resolved = path.resolve(filePath);
	let stat;
	try {
		stat = await fs.promises.lstat(resolved);
	} catch {
		return null;
	}
	// lstat does not follow links: a symbolic link is neither accepted nor followed.
	if (stat.isSymbolicLink() || !stat.isFile()) return null;
	let real;
	try {
		real = await fs.promises.realpath(resolved);
	} catch {
		return null;
	}
	const allowed = await Promise.all((roots && roots.length ? roots : [os.tmpdir()]).map(async (root) => {
		if (!plainPath(root)) return null;
		try {
			return await fs.promises.realpath(path.resolve(root));
		} catch {
			return null;
		}
	}));
	return allowed.some(root => root && isInside(root, real)) ? real : null;
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

module.exports = { tempUploadPath, fileInFolder, isInside };
