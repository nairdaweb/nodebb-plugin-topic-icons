'use strict';

/*
 * Topic covers: pure logic shared by the server (library.js), the ACP script (public/admin.js,
 * exposed as "topic-icons/covers" through plugin.json) and the unit tests. No NodeBB imports and
 * no Node-only APIs.
 *
 * A cover is the picture shown next to a topic in topic lists and in the topic header. The plugin
 * works with NodeBB's own topic thumbnails ("thumbs"): a topic that has thumbnails keeps them, and
 * a topic without any gets one of these at display time, in this order:
 *   1. the first image of its first post (an upload of the forum; images from other sites only
 *      when the admin allows them), when "automatic covers" are on;
 *   2. the default cover of its category, when "category covers" are on;
 *   3. nothing.
 * Nothing is written into the topic's thumbnails, so a changed category cover shows everywhere at
 * once and switching a feature off takes its covers away. The first image is found once per first
 * post and kept in one topic field (see library.js), so lists cost no extra post query.
 *
 * Settings (stored as strings in the plugin settings hash, next to the icon library):
 *   coverCategory 'on'|'off'  category default covers
 *   coverAuto     'on'|'off'  first image of the first post
 *   coverExternal 'on'|'off'  first image may come from another site (http/https)
 *   coverStyle    'on'|'off'  uniform frame for all topic thumbnails (CSS, see scss/)
 *   coverPhones   'on'|'off'  show list thumbnails on phones as well
 *   coverRatio    '4-3'|'square'
 *   categoryCovers JSON { cid: url }
 */

const ACP_NAMESPACE = 'admin/plugins/topic-icons';
const RATIOS = ['4-3', 'square'];
/** Image types a category cover may have (uploads are limited to the same list). */
const COVER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];
/** Image types the first image of a post may have when it is an upload of the forum. */
const LOCAL_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg'];
/** Where ACP uploads are served (library.js stores them in <upload_path>/topic-icons). */
const UPLOAD_BASE = '/assets/uploads/topic-icons/';
const MAX_URL = 1000;
const MAX_CATEGORIES = 500;
/** Most images looked at in one post. */
const MAX_CANDIDATES = 50;

/**
 * @param {*} value checkbox value as stored by the settings module ('on'/'off', true/false)
 * @param {boolean} fallback used when the value was never saved
 * @returns {boolean}
 */
function toBool(value, fallback) {
	if (value === undefined || value === null || value === '') return fallback;
	return value === true || value === 'on' || value === 'true' || value === 1 || value === '1';
}

/**
 * @param {*} value category id
 * @returns {number} positive integer, or 0
 */
function cleanCid(value) {
	const v = String(value == null ? '' : value).trim();
	return /^[1-9]\d{0,9}$/.test(v) ? parseInt(v, 10) : 0;
}

/**
 * @param {*} value JSON text or an already parsed value
 * @param {*} fallback
 * @returns {*}
 */
function parseJson(value, fallback) {
	if (value === undefined || value === null || value === '') return fallback;
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

/**
 * Path part of a URL, lower-cased, without query and fragment.
 *
 * @param {string} v
 * @returns {string}
 */
function pathOf(v) {
	return v.split(/[?#]/)[0].toLowerCase();
}

/**
 * @param {string} pathPart lower-cased path
 * @returns {boolean} whether it has "." or ".." segments (also percent-encoded) or encoded slashes
 */
function hasBadSegments(pathPart) {
	if (/%2f|%5c/.test(pathPart)) return true;
	return pathPart.replace(/%2e/g, '.').split('/').some(seg => seg === '..' || seg === '.');
}

/**
 * @param {string} pathPart lower-cased path
 * @param {string[]} list allowed extensions
 * @returns {boolean}
 */
function hasExtension(pathPart, list) {
	const dot = pathPart.lastIndexOf('.');
	return dot !== -1 && list.includes(pathPart.slice(dot + 1));
}

/**
 * Category cover URL typed or uploaded in the ACP: a site-relative path ("/assets/…", not
 * "//host") or an https URL, without whitespace, quotes, angle brackets or backslashes, ending
 * in one of COVER_EXTENSIONS (a query string is allowed).
 *
 * @param {*} value
 * @returns {string} URL, or ''
 */
function cleanAdminUrl(value) {
	const v = String(value == null ? '' : value).trim();
	if (!v || v.length > MAX_URL || /[\s"'<>`\\]/.test(v)) return '';
	if (!/^\/(?![/\\])/.test(v) && !/^https:\/\/[^/?#@]+\//i.test(v)) return '';
	const p = pathOf(v);
	if (hasBadSegments(p)) return '';
	return hasExtension(p, COVER_EXTENSIONS) ? v : '';
}

/**
 * Classifies an image URL found in a post.
 *
 * - local: an upload of this forum, given as "/assets/uploads/…", with the forum's relative path
 *   ("/forum/assets/uploads/…") or as an absolute URL of the forum ("https://forum/…"). Returned as
 *   the path under the upload URL ("/files/1-photo.png"), the way NodeBB stores thumbnails.
 * - external: an http(s) URL of another site (no user name or password in it).
 *
 * @param {*} value URL as written in the post (HTML entities already decoded)
 * @param {{uploadUrl?: string, relativePath?: string, baseUrl?: string}} [site]
 *   uploadUrl: NodeBB's upload_url ("/assets/uploads"); relativePath: "" or "/forum";
 *   baseUrl: the forum's origin ("https://example.org")
 * @returns {{type: 'local', path: string}|{type: 'external', url: string}|null}
 */
function classifyUrl(value, site) {
	site = site || {};
	let v = String(value == null ? '' : value).trim();
	if (!v || v.length > MAX_URL || /[\s"'<>`\\\u0000-\u001f\u007f]/.test(v)) return null;
	const uploadUrl = String(site.uploadUrl || '/assets/uploads').replace(/\/+$/, '');
	const relativePath = String(site.relativePath || '').replace(/\/+$/, '');
	const baseUrl = String(site.baseUrl || '').replace(/\/+$/, '').toLowerCase();
	if (baseUrl && /^https?:\/\//i.test(v)) {
		// The forum's own absolute URLs (also with the other scheme) are site paths.
		const bare = baseUrl.replace(/^https?:/, '');
		const m = /^https?:(\/\/[^/?#]+)(.*)$/i.exec(v);
		if (m && m[1].toLowerCase() === bare && (!m[2] || m[2].charAt(0) === '/')) v = m[2] || '/';
	}
	if (v.charAt(0) === '/') {
		if (/^\/[/\\]/.test(v)) return null;
		let rest = v;
		if (relativePath && rest.startsWith(`${relativePath}/`)) rest = rest.slice(relativePath.length);
		if (!rest.startsWith(`${uploadUrl}/`)) return null;
		const sub = rest.slice(uploadUrl.length);
		const p = pathOf(sub);
		if (hasBadSegments(p) || !hasExtension(p, LOCAL_EXTENSIONS)) return null;
		return { type: 'local', path: sub };
	}
	const m = /^(https?):\/\/([^/?#]+)([/?#].*)?$/i.exec(v);
	if (!m || m[2].includes('@') || !/^[a-z0-9.-]+(:\d{1,5})?$/i.test(m[2]) && !/^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(m[2])) return null;
	return { type: 'external', url: v };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', '#39': '\'', '#x27': '\'', '#34': '"' };

/**
 * Decodes the few entities that appear in attribute values written by editors and NodeBB.
 *
 * @param {string} s
 * @returns {string}
 */
function decodeAttr(s) {
	return s.replace(/&(amp|lt|gt|quot|apos|#39|#x27|#34);/gi, (m, name) => ENTITIES[name.toLowerCase()] || m);
}

/**
 * Image URLs of a post, in the order they appear. Reads both Markdown (inline images
 * ![alt](url "title"), reference images ![alt][ref] with their definitions) and HTML
 * (<img src>). Code (fenced blocks, inline code, <pre> and <code>) and HTML comments are skipped,
 * so an image in a code sample is not taken.
 *
 * @param {*} content raw post content (Markdown or HTML)
 * @returns {string[]} URLs as written (entities in HTML attributes decoded), at most MAX_CANDIDATES
 */
function extractImages(content) {
	let text = String(content == null ? '' : content);
	if (text.length > 200000) text = text.slice(0, 200000);
	text = text
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|$)|$)/gm, ' ')
		.replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
		.replace(/(`+)[^`\n][\s\S]*?\1/g, ' ');

	const refs = {};
	text.replace(/^ {0,3}\[([^\]\n]{1,200})\]:[ \t]*<?([^\s>]+)>?/gm, (m, label, url) => {
		const key = label.trim().toLowerCase();
		if (!Object.prototype.hasOwnProperty.call(refs, key)) refs[key] = url;
		return m;
	});

	const out = [];
	const re = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]*)>|([^\s)]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)|!\[([^\]\n]*)\]\[([^\]\n]*)\]|<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
	let m;
	while ((m = re.exec(text)) && out.length < MAX_CANDIDATES) {
		if (m[2] !== undefined || m[3] !== undefined) {
			out.push(m[2] !== undefined ? m[2] : m[3]);
		} else if (m[5] !== undefined || m[4] !== undefined) {
			const key = (m[5] || m[4] || '').trim().toLowerCase();
			if (Object.prototype.hasOwnProperty.call(refs, key)) out.push(refs[key]);
		} else {
			out.push(decodeAttr(m[6] !== undefined ? m[6] : (m[7] !== undefined ? m[7] : m[8])));
		}
	}
	return out;
}

/**
 * What a post offers as a cover: its first image that is an upload of the forum, and its first
 * image of any accepted kind (forum upload or http(s) URL of another site). Both are kept, so
 * switching "images from other sites" on or off needs no new scan.
 *
 * @param {*} content raw post content
 * @param {object} [site] see classifyUrl
 * @returns {{local: string, any: string}} local: path under the upload URL; any: that path or an
 *   external URL ('' when there is none)
 */
function scanPost(content, site) {
	let local = '';
	let any = '';
	for (const url of extractImages(content)) {
		const found = classifyUrl(url, site);
		if (!found) continue;
		const value = found.type === 'local' ? found.path : found.url;
		if (!any) any = value;
		if (found.type === 'local' && !local) local = value;
		if (local && any) break;
	}
	return { local, any };
}

/**
 * Stored scan result (topic field, JSON) → object; anything unreadable counts as "not scanned".
 *
 * @param {*} raw field value
 * @returns {{pid: string, local: string, any: string}|null}
 */
function parseScan(raw) {
	const data = parseJson(raw, null);
	if (!data || typeof data !== 'object' || data.pid === undefined) return null;
	return {
		pid: String(data.pid),
		local: typeof data.local === 'string' ? data.local : '',
		any: typeof data.any === 'string' ? data.any : '',
	};
}

/**
 * @param {string|number} pid first post the scan belongs to
 * @param {{local: string, any: string}} scan
 * @returns {string} field value
 */
function serializeScan(pid, scan) {
	return JSON.stringify({ pid: String(pid), local: scan.local || '', any: scan.any || '' });
}

/**
 * Settings of a fresh installation, in the stored (string) form. Automatic covers and images
 * from other sites are off until the admin switches them on.
 *
 * @returns {object}
 */
function defaults() {
	return {
		coverCategory: 'on',
		coverAuto: 'off',
		coverExternal: 'off',
		coverStyle: 'on',
		coverPhones: 'on',
		coverRatio: '4-3',
		categoryCovers: '{}',
	};
}

/**
 * Stored settings → cover config (lenient: invalid entries are dropped).
 *
 * @param {object} [raw]
 * @returns {{category: boolean, auto: boolean, external: boolean, style: boolean, phones: boolean,
 *   ratio: string, categoryCovers: Object<number, string>}}
 */
function normalize(raw) {
	raw = raw || {};
	const categoryCovers = {};
	const map = parseJson(raw.categoryCovers, {});
	if (map && typeof map === 'object' && !Array.isArray(map)) {
		Object.keys(map).slice(0, MAX_CATEGORIES).forEach((cid) => {
			const url = cleanAdminUrl(map[cid]);
			if (cleanCid(cid) && url) categoryCovers[cleanCid(cid)] = url;
		});
	}
	return {
		category: toBool(raw.coverCategory, true),
		auto: toBool(raw.coverAuto, false),
		external: toBool(raw.coverExternal, false),
		style: toBool(raw.coverStyle, true),
		phones: toBool(raw.coverPhones, true),
		ratio: RATIOS.includes(raw.coverRatio) ? raw.coverRatio : '4-3',
		categoryCovers,
	};
}

/**
 * Strict check before saving (library.js onSettingsSave, and the ACP before sending). Errors are
 * translation tokens of the ACP namespace with category ids as their only arguments.
 *
 * @param {object} raw settings from the ACP form
 * @returns {{errors: string[], settings: object}} cleaned settings in the stored form
 */
function validateSettings(raw) {
	raw = raw || {};
	const errors = [];
	const t = (key, ...args) => `[[${ACP_NAMESPACE}:${key}${args.length ? `, ${args.join(', ')}` : ''}]]`;
	const ratio = raw.coverRatio === undefined || raw.coverRatio === '' ? '4-3' : raw.coverRatio;
	if (!RATIOS.includes(ratio)) errors.push(t('error.cover-ratio'));
	const map = parseJson(raw.categoryCovers, {});
	const categoryCovers = {};
	if (!map || typeof map !== 'object' || Array.isArray(map)) {
		errors.push(t('error.category-covers'));
	} else {
		Object.keys(map).forEach((cid) => {
			const value = String(map[cid] == null ? '' : map[cid]).trim();
			if (!value) return;
			const url = cleanAdminUrl(value);
			if (!cleanCid(cid) || !url) errors.push(t('error.category-cover-url', cleanCid(cid) || 0));
			else if (Object.keys(categoryCovers).length < MAX_CATEGORIES) categoryCovers[cleanCid(cid)] = url;
		});
	}
	const flag = (key, fallback) => (toBool(raw[key], fallback) ? 'on' : 'off');
	return {
		errors,
		settings: {
			coverCategory: flag('coverCategory', true),
			coverAuto: flag('coverAuto', false),
			coverExternal: flag('coverExternal', false),
			coverStyle: flag('coverStyle', true),
			coverPhones: flag('coverPhones', true),
			coverRatio: RATIOS.includes(ratio) ? ratio : '4-3',
			categoryCovers: JSON.stringify(categoryCovers),
		},
	};
}

/**
 * The cover a topic gets, in the documented order: its own thumbnails (left alone) → the first
 * image of its first post → the default cover of its category → none.
 *
 * @param {object} config cover config (normalize())
 * @param {{hasThumbs?: boolean, cid?: *, scan?: {local: string, any: string}|null, guest?: boolean,
 *   privateUploads?: boolean}} topic hasThumbs: NodeBB already shows thumbnails; guest and
 *   privateUploads: forum uploads in posts are hidden from guests then, as NodeBB does with
 *   thumbnails
 * @returns {{source: 'own'}|{source: 'auto', local: string}|{source: 'auto', external: string}|
 *   {source: 'category', url: string}|null}
 */
function pickCover(config, topic) {
	topic = topic || {};
	if (topic.hasThumbs) return { source: 'own' };
	if (config.auto && topic.scan) {
		const value = config.external ? topic.scan.any : topic.scan.local;
		if (value && value.charAt(0) === '/') {
			if (!(topic.guest && topic.privateUploads)) return { source: 'auto', local: value };
		} else if (value && config.external) {
			return { source: 'auto', external: value };
		}
	}
	const url = config.category ? config.categoryCovers[cleanCid(topic.cid)] : '';
	return url ? { source: 'category', url } : null;
}

/**
 * Thumbnail object in NodeBB's shape ({ id, name, path, url }, see src/topics/thumbs.js) for a
 * picked cover, plus `cover` (its source). URLs of local files get relative_path and upload_url
 * the way NodeBB builds them.
 *
 * @param {object} picked result of pickCover (not 'own')
 * @param {string|number} tid
 * @param {{uploadUrl?: string, relativePath?: string}} [site]
 * @returns {{id: string, name: string, path: string, url: string, cover: string}}
 */
function toThumb(picked, tid, site) {
	site = site || {};
	const uploadUrl = String(site.uploadUrl || '/assets/uploads').replace(/\/+$/, '');
	const relativePath = String(site.relativePath || '').replace(/\/+$/, '');
	let thumbPath;
	let url;
	if (picked.local) {
		thumbPath = picked.local;
		url = relativePath + uploadUrl + picked.local;
	} else if (picked.external) {
		thumbPath = picked.external;
		url = picked.external;
	} else {
		url = picked.url;
		const local = url.charAt(0) === '/';
		const withPrefix = local && relativePath && !url.startsWith(`${relativePath}/`) ? relativePath + url : url;
		// Site paths under the upload URL are stored the way NodeBB stores thumbnail paths.
		const uploadPrefix = relativePath + uploadUrl;
		thumbPath = local && withPrefix.startsWith(`${uploadPrefix}/`) ? withPrefix.slice(uploadPrefix.length) : withPrefix;
		url = withPrefix;
	}
	const base = pathOf(thumbPath).split('/').pop() || 'cover';
	return { id: String(tid), name: base, path: thumbPath, url, cover: picked.source };
}

/**
 * File name of a cover uploaded from the ACP, from its URL.
 *
 * @param {string} url stored URL
 * @returns {string} "tc-….webp" etc., or '' when the URL is not such an upload
 */
function uploadedFile(url) {
	const v = String(url || '');
	if (!v.startsWith(UPLOAD_BASE)) return '';
	const name = v.slice(UPLOAD_BASE.length).split(/[?#]/)[0];
	return /^tc-[a-z0-9]{1,12}-[a-f0-9]{1,16}\.(png|jpg|webp|gif|svg)$/.test(name) ? name : '';
}

/**
 * Uploaded cover files that a save leaves unused (category cover removed or replaced).
 *
 * @param {Object<number, string>} before stored category covers
 * @param {Object<number, string>} after category covers being saved
 * @returns {string[]} file names
 */
function unusedFiles(before, after) {
	const kept = new Set(Object.values(after || {}).map(uploadedFile).filter(Boolean));
	const out = [];
	Object.values(before || {}).forEach((url) => {
		const name = uploadedFile(url);
		if (name && !kept.has(name) && !out.includes(name)) out.push(name);
	});
	return out;
}

/**
 * Body classes that turn on the plugin's thumbnail styles (scss/topic-icons.scss).
 *
 * @param {object} config cover config
 * @returns {string[]}
 */
function bodyClasses(config) {
	if (!config.style) return [];
	const out = ['topic-covers', `topic-covers--${config.ratio}`];
	if (config.phones) out.push('topic-covers--phones');
	return out;
}

module.exports = {
	RATIOS,
	COVER_EXTENSIONS,
	LOCAL_EXTENSIONS,
	UPLOAD_BASE,
	cleanAdminUrl,
	classifyUrl,
	extractImages,
	scanPost,
	parseScan,
	serializeScan,
	defaults,
	normalize,
	validateSettings,
	pickCover,
	toThumb,
	uploadedFile,
	unusedFiles,
	bodyClasses,
};
