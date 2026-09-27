'use strict';

/*
 * Checks for icon uploads (ACP only, see the upload route in library.js). Pure functions, so
 * they can be unit-tested without NodeBB.
 *
 * An upload is accepted only when the file name extension, the MIME type sent by the browser
 * and the content agree on one of PNG, WebP or SVG, and the file is not larger than MAX_BYTES.
 * The stored file gets a new, unique name (the original name is never used on disk).
 * NodeBB's file.saveFileToLocal() additionally sanitises SVG files, and the forum shows icons
 * only through <img>, where scripts inside an SVG do not run.
 */

/** Largest accepted icon file. */
const MAX_BYTES = 256 * 1024;
/** Extension → MIME types a browser may send for it. */
const TYPES = {
	png: ['image/png'],
	webp: ['image/webp'],
	svg: ['image/svg+xml'],
};

/**
 * Type of an image from its first bytes.
 *
 * @param {Uint8Array} buf file content (at least the first few hundred bytes)
 * @returns {'png'|'webp'|'svg'|''}
 */
function sniffType(buf) {
	if (!buf || !buf.length) return '';
	const b = i => buf[i];
	if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) return 'png';
	const ascii = (from, to) => String.fromCharCode.apply(null, Array.prototype.slice.call(buf, from, to));
	if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
	// SVG: text whose first element (after an optional BOM, XML declaration, comments and
	// doctype) is <svg.
	let text = ascii(0, Math.min(buf.length, 1024)).replace(/^(\ufeff|\u00ef\u00bb\u00bf)/, '');
	text = text.replace(/^\s*<\?xml[^>]*\?>/i, '');
	for (let i = 0; i < 10; i += 1) {
		const next = text.replace(/^\s*<!--[\s\S]*?-->/, '').replace(/^\s*<!DOCTYPE[^>]*>/i, '');
		if (next === text) break;
		text = next;
	}
	return /^\s*<svg[\s>]/i.test(text) ? 'svg' : '';
}

/**
 * Refuses SVG content that has no business in an icon. NodeBB sanitises SVG uploads as well;
 * this is a second, stricter gate that turns such files away instead of silently changing them.
 *
 * @param {string} text whole SVG file
 * @returns {boolean} true when the SVG looks safe
 */
function isSafeSvg(text) {
	const s = String(text || '');
	return !/<script|<foreignObject|<iframe|<embed|<object|\son[a-z]+\s*=|javascript:|<!ENTITY|href\s*=\s*(?:"\s*(?!#)|'\s*(?!#)|(?!["'\s#]))/i.test(s);
}

/**
 * Checks an uploaded file.
 *
 * @param {{originalname?: string, name?: string, mimetype?: string, type?: string, size: number}} fileInfo
 * @param {Uint8Array} head first bytes of the file
 * @returns {{ext: string}|{error: string}} error is a key of the ACP namespace
 */
function checkUpload(fileInfo, head) {
	if (!fileInfo) return { error: 'upload-missing' };
	const name = String(fileInfo.originalname || fileInfo.name || '');
	const match = /\.([a-z0-9]+)$/i.exec(name);
	const ext = match ? match[1].toLowerCase() : '';
	if (!TYPES[ext]) return { error: 'upload-type' };
	const mime = String(fileInfo.mimetype || fileInfo.type || '').toLowerCase();
	if (mime && !TYPES[ext].includes(mime)) return { error: 'upload-type' };
	if (!(fileInfo.size > 0)) return { error: 'upload-missing' };
	if (fileInfo.size > MAX_BYTES) return { error: 'upload-size' };
	if (sniffType(head) !== ext) return { error: 'upload-type' };
	return { ext };
}

/**
 * Unique file name for a stored icon: "ti-<time>-<random>.<ext>", so that two uploads called
 * "icon.png" never overwrite each other and nothing of the original name reaches the disk.
 *
 * @param {string} ext checked extension
 * @param {string} random random hex string (crypto on the server)
 * @param {number} [now] timestamp, for tests
 * @returns {string}
 */
function uniqueName(ext, random, now) {
	const rand = String(random || '').replace(/[^a-f0-9]/gi, '').toLowerCase().slice(0, 16) || '0';
	return `ti-${(now || Date.now()).toString(36)}-${rand}.${ext}`;
}

module.exports = { MAX_BYTES, TYPES, sniffType, isSafeSvg, checkUpload, uniqueName };
