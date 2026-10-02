'use strict';

/*
 * Checks for icon and cover uploads (ACP only, see the upload routes in library.js). Pure functions, so
 * they can be unit-tested without NodeBB.
 *
 * An upload is accepted only when the file name extension, the MIME type sent by the browser
 * and the content agree on one of the allowed types (icons: PNG, WebP, GIF, SVG; category covers:
 * also JPEG), and the file is not larger than the limit (MAX_BYTES, COVER_MAX_BYTES).
 * The stored file gets a new, unique name (the original name is never used on disk).
 * NodeBB's file.saveFileToLocal() additionally sanitises SVG files, and the forum shows icons
 * only through <img>, where scripts inside an SVG do not run.
 */

/** Largest accepted icon file. */
const MAX_BYTES = 512 * 1024;
/** Extension → MIME types a browser may send for it. */
const TYPES = {
	png: ['image/png'],
	webp: ['image/webp'],
	gif: ['image/gif'],
	svg: ['image/svg+xml'],
};
/** Largest accepted cover file. */
const COVER_MAX_BYTES = 2 * 1024 * 1024;
/** Extension → MIME types, for category covers. */
const COVER_TYPES = Object.assign({}, TYPES, {
	jpg: ['image/jpeg', 'image/pjpeg'],
	jpeg: ['image/jpeg', 'image/pjpeg'],
});

/**
 * Type of an image from its first bytes.
 *
 * @param {Uint8Array} buf file content (at least the first few hundred bytes)
 * @returns {'png'|'webp'|'jpg'|'gif'|'svg'|''}
 */
function sniffType(buf) {
	if (!buf || !buf.length) return '';
	const b = i => buf[i];
	if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 && b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) return 'png';
	const ascii = (from, to) => String.fromCharCode.apply(null, Array.prototype.slice.call(buf, from, to));
	if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
	if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpg';
	if (buf.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'gif';
	// SVG: text whose first element (after an optional BOM, XML declaration, comments and
	// doctype) is <svg.
	// Bytes become Latin-1 characters here, so the UTF-8 BOM (EF BB BF) is three characters.
	let text = ascii(0, Math.min(buf.length, 1024)).replace(/^\u00ef\u00bb\u00bf/, '');
	text = text.replace(/^\s*<\?xml[^>]*\?>/i, '');
	for (let i = 0; i < 10; i += 1) {
		const next = text.replace(/^\s*<!--[\s\S]*?-->/, '').replace(/^\s*<!DOCTYPE[^>]*>/i, '');
		if (next === text) break;
		text = next;
	}
	return /^\s*<svg[\s>]/i.test(text) ? 'svg' : '';
}

/**
 * Refuses SVG content that has no business in an icon: scripts, embedded documents, event
 * handlers, javascript: URLs, entity declarations, links that are not local fragments ("#id"),
 * and external resources in styles (url(…) other than "#id", @import). NodeBB sanitises SVG
 * uploads as well; this is a second, stricter gate that turns such files away instead of
 * silently changing them.
 *
 * @param {string} text whole SVG file
 * @returns {boolean} true when the SVG looks safe
 */
function isSafeSvg(text) {
	const s = String(text || '');
	if (/<script|<foreignObject|<iframe|<embed|<object|[\s/]on[a-z]+\s*=|javascript:|<!ENTITY|@import/i.test(s)) return false;
	if (/href\s*=\s*(?:"\s*(?!#)|'\s*(?!#)|(?!["'\s#]))/i.test(s)) return false;
	// url( "#id" ) and url(#id) point into the same file; anything else loads a resource.
	return !/url\s*\((?!\s*(?:["']|&quot;|&apos;|&#3[49];)?\s*#)/i.test(s);
}

/**
 * Checks an uploaded file.
 *
 * @param {{originalname?: string, name?: string, mimetype?: string, type?: string, size: number}} fileInfo
 * @param {Uint8Array} head first bytes of the file
 * @param {{types?: object, maxBytes?: number}} [opts] allowed types and size (default: icons)
 * @returns {{ext: string}|{error: string}} error is a key of the ACP namespace; ext is "jpg" for
 *   .jpg and .jpeg files
 */
function checkUpload(fileInfo, head, opts) {
	opts = opts || {};
	const types = opts.types || TYPES;
	const maxBytes = opts.maxBytes || MAX_BYTES;
	if (!fileInfo) return { error: 'upload-missing' };
	const name = String(fileInfo.originalname || fileInfo.name || '');
	const match = /\.([a-z0-9]+)$/i.exec(name);
	const ext = match ? match[1].toLowerCase() : '';
	if (!Object.prototype.hasOwnProperty.call(types, ext)) return { error: 'upload-type' };
	const mime = String(fileInfo.mimetype || fileInfo.type || '').toLowerCase();
	if (mime && !types[ext].includes(mime)) return { error: 'upload-type' };
	if (!(fileInfo.size > 0)) return { error: 'upload-missing' };
	if (fileInfo.size > maxBytes) return { error: 'upload-size' };
	const clean = ext === 'jpeg' ? 'jpg' : ext;
	if (sniffType(head) !== clean) return { error: 'upload-type' };
	return { ext: clean };
}

/**
 * Checks an uploaded category cover (PNG, JPEG, WebP, GIF or SVG, up to COVER_MAX_BYTES).
 *
 * @param {object} fileInfo see checkUpload
 * @param {Uint8Array} head
 * @returns {{ext: string}|{error: string}}
 */
function checkCoverUpload(fileInfo, head) {
	return checkUpload(fileInfo, head, { types: COVER_TYPES, maxBytes: COVER_MAX_BYTES });
}

/**
 * Unique file name for a stored upload: "<prefix>-<time>-<random>.<ext>" ("ti" for icons, "tc"
 * for covers), so that two uploads called "icon.png" never overwrite each other and nothing of
 * the original name reaches the disk.
 *
 * @param {string} ext checked extension
 * @param {string} random random hex string (crypto on the server)
 * @param {number} [now] timestamp, for tests
 * @param {'ti'|'tc'} [prefix]
 * @returns {string}
 */
function uniqueName(ext, random, now, prefix) {
	const rand = String(random || '').replace(/[^a-f0-9]/gi, '').toLowerCase().slice(0, 16) || '0';
	return `${prefix === 'tc' ? 'tc' : 'ti'}-${(now || Date.now()).toString(36)}-${rand}.${ext}`;
}

module.exports = { MAX_BYTES, TYPES, COVER_MAX_BYTES, COVER_TYPES, sniffType, isSafeSvg, checkUpload, checkCoverUpload, uniqueName };
