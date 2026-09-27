'use strict';

/*
 * Pure icon-library logic: settings validation, the per-category choice of icons, the icon shown
 * for a topic and the icon markup. Used by library.js (server) and, through "modules" in
 * plugin.json, by the ACP script (public/admin.js) for the same validation. No NodeBB imports and
 * no Node-only APIs, so it runs in the browser and in node:test (test/*.test.js).
 *
 * Settings arrive from the ACP form as strings (meta.settings stores flat string values, the
 * library and the category defaults as JSON). normalize() turns them into the config used
 * everywhere downstream; validateSettings() is the stricter check run when they are saved.
 *
 * Config shape (normalised):
 * {
 *   chooser: 'all' | 'group' | 'mods',   who may pick an icon in the composer
 *   chooserGroup: string,                 group for chooser 'group' (moderators always may)
 *   showInList, showInTopic: boolean,
 *   defaultIcon: string,                  forum-wide default icon id ('' = none)
 *   categoryDefaults: { [cid]: id },      per-category default, wins over defaultIcon
 *   icons: [{ id, key, name, url, cids: number[], active }]
 * }
 * An icon with an empty `cids` list is offered in every category. `key` is set for the built-in
 * icons only; their name comes from the language files unless the admin typed one.
 */

const NAMESPACE = 'topic-icons';
/** Namespace of the ACP strings (languages/<lang>/admin/plugins/topic-icons.json). */
const ACP_NAMESPACE = 'admin/plugins/topic-icons';
const CHOOSERS = ['all', 'group', 'mods'];
// Upper bounds keep the stored config and the picker small.
const MAX_ICONS = 200;
const MAX_NAME = 60;
const MAX_CIDS = 500;
/** Image types an icon may have (uploads are limited to the same list, see lib/upload.js). */
const IMAGE_EXTENSIONS = ['png', 'webp', 'svg'];
/** Where the built-in icons are served (plugin.json "staticDirs"). */
const BUILTIN_BASE = '/assets/plugins/nodebb-plugin-topic-icons/icons/';
/** Built-in icons, in their default order; files static/icons/<key>.svg. */
const BUILTIN_KEYS = ['question', 'guide', 'problem', 'idea', 'project', 'showcase', 'announcement', 'discussion'];

const ESC = {
	'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;', '`': '&#96;', '=': '&#61;',
	'[': '&lsqb;', ']': '&rsqb;',
};

/**
 * HTML-escapes text for element content and quoted attributes. Square brackets become
 * &lsqb; / &rsqb;: NodeBB's translator runs over rendered pages and would expand a
 * "[[namespace:key]]" hidden in a name, and it decodes numeric entities such as &#91; first, so
 * only the named entities keep a name from turning into a translation token.
 *
 * @param {*} str
 * @returns {string}
 */
function escape(str) {
	return String(str == null ? '' : str).replace(/[&<>"'`=[\]]/g, c => ESC[c]);
}

/**
 * Plain one-line text: control characters removed, whitespace collapsed, cut to `max`.
 *
 * @param {*} value
 * @param {number} max
 * @returns {string}
 */
function cleanText(value, max) {
	return String(value == null ? '' : value)
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max);
}

/**
 * Icon id: lower-case letters, digits and dashes. Used in data attributes, topic fields and
 * the API, and as an HTML attribute value (still escaped there).
 *
 * @param {*} value
 * @returns {string} id, or ''
 */
function cleanId(value) {
	const v = String(value == null ? '' : value).trim();
	return /^[a-z0-9][a-z0-9-]{0,39}$/.test(v) ? v : '';
}

/**
 * Image URL of an icon: a site-relative path ("/assets/…", not "//host" or "/\host") or an
 * https URL, without whitespace, quotes, angle brackets or backslashes, ending in .png, .webp
 * or .svg (a query string is allowed). Everything else is refused, so the value can be written
 * into a src attribute (escaped as well).
 *
 * @param {*} value
 * @returns {string} URL, or ''
 */
function cleanUrl(value) {
	const v = String(value == null ? '' : value).trim();
	if (!v || v.length > 500 || /[\s"'<>`\\]/.test(v)) return '';
	if (!/^\/(?![/\\])/.test(v) && !/^https:\/\/[^/?#]+\//i.test(v)) return '';
	const pathPart = v.split(/[?#]/)[0].toLowerCase();
	if (pathPart.split('/').includes('..')) return '';
	const ext = pathPart.slice(pathPart.lastIndexOf('.') + 1);
	return IMAGE_EXTENSIONS.includes(ext) ? v : '';
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
 * @param {*} value array of category ids
 * @returns {number[]} unique positive integers, in the given order
 */
function cleanCids(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	value.forEach((c) => {
		const cid = cleanCid(c);
		if (cid && !out.includes(cid) && out.length < MAX_CIDS) out.push(cid);
	});
	return out;
}

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
 * @param {*} value JSON text or an already parsed value
 * @param {*} fallback returned for empty or invalid JSON
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
 * The built-in library: one active icon per BUILTIN_KEYS entry, offered in every category.
 *
 * @returns {Array<object>}
 */
function builtinIcons() {
	return BUILTIN_KEYS.map(key => ({ id: key, key, name: '', url: `${BUILTIN_BASE}${key}.svg`, cids: [], active: true }));
}

/**
 * Settings of a fresh installation, in the stored (string) form.
 *
 * @returns {object}
 */
function defaults() {
	return {
		chooser: 'all',
		chooserGroup: '',
		showInList: 'on',
		showInTopic: 'on',
		defaultIcon: '',
		categoryDefaults: '{}',
		icons: JSON.stringify(builtinIcons()),
	};
}

/**
 * @param {*} entry raw library entry
 * @returns {object|null} normalised icon, or null when it has no valid id or URL
 */
function normalizeIcon(entry) {
	if (!entry || typeof entry !== 'object') return null;
	const id = cleanId(entry.id);
	const url = cleanUrl(entry.url);
	if (!id || !url) return null;
	const key = BUILTIN_KEYS.includes(entry.key) ? entry.key : '';
	return {
		id,
		key,
		name: cleanText(entry.name, MAX_NAME),
		url,
		cids: cleanCids(entry.cids),
		active: entry.active === undefined ? true : toBool(entry.active, true),
	};
}

/**
 * Turns stored settings into the config. Lenient: invalid entries are dropped, not reported.
 * A library that was never saved is the built-in set; a saved empty list stays empty.
 *
 * @param {object} [raw] settings as returned by meta.settings.get()
 * @returns {object} config, see the shape at the top of this file
 */
function normalize(raw) {
	raw = raw || {};
	const list = parseJson(raw.icons, null);
	const icons = [];
	(Array.isArray(list) ? list : builtinIcons()).forEach((entry) => {
		const icon = normalizeIcon(entry);
		if (icon && icons.length < MAX_ICONS && !icons.some(i => i.id === icon.id)) icons.push(icon);
	});
	const known = new Set(icons.map(i => i.id));
	const categoryDefaults = {};
	const map = parseJson(raw.categoryDefaults, {});
	if (map && typeof map === 'object' && !Array.isArray(map)) {
		Object.keys(map).forEach((cid) => {
			const id = cleanId(map[cid]);
			if (cleanCid(cid) && id && known.has(id)) categoryDefaults[cleanCid(cid)] = id;
		});
	}
	const defaultIcon = cleanId(raw.defaultIcon);
	return {
		chooser: CHOOSERS.includes(raw.chooser) ? raw.chooser : 'all',
		chooserGroup: cleanText(raw.chooserGroup, 120),
		showInList: toBool(raw.showInList, true),
		showInTopic: toBool(raw.showInTopic, true),
		defaultIcon: known.has(defaultIcon) ? defaultIcon : '',
		categoryDefaults,
		icons,
	};
}

/**
 * Strict check run before the settings are saved (library.js onSettingsSave) and in the ACP
 * before sending. Errors are translation tokens of the ACP namespace; their arguments are row
 * numbers only, never admin-typed text.
 *
 * @param {object} raw settings from the ACP form
 * @returns {{errors: string[], settings: object}} cleaned settings in the stored form
 */
function validateSettings(raw) {
	raw = raw || {};
	const errors = [];
	const t = (key, ...args) => `[[${ACP_NAMESPACE}:${key}${args.length ? `, ${args.join(', ')}` : ''}]]`;
	const list = parseJson(raw.icons, undefined);
	if (!Array.isArray(list)) errors.push(t('error.icons-json'));
	const icons = [];
	const ids = new Set();
	const seen = new Set();
	(Array.isArray(list) ? list : []).forEach((entry, i) => {
		const row = i + 1;
		if (!entry || typeof entry !== 'object') {
			errors.push(t('error.row-invalid', row));
			return;
		}
		const id = cleanId(entry.id);
		if (!id) errors.push(t('error.row-id', row));
		else if (seen.has(id)) errors.push(t('error.row-duplicate', row));
		seen.add(id);
		if (!cleanUrl(entry.url)) errors.push(t('error.row-url', row));
		if (String(entry.name == null ? '' : entry.name).trim().length > MAX_NAME) errors.push(t('error.row-name', row, MAX_NAME));
		if (!BUILTIN_KEYS.includes(entry.key) && !cleanText(entry.name, MAX_NAME)) errors.push(t('error.row-no-name', row));
		const icon = normalizeIcon(entry);
		if (icon && !ids.has(icon.id)) {
			ids.add(icon.id);
			icons.push(icon);
		}
	});
	if (Array.isArray(list) && list.length > MAX_ICONS) errors.push(t('error.too-many', MAX_ICONS));

	const chooser = raw.chooser === undefined || raw.chooser === '' ? 'all' : raw.chooser;
	if (!CHOOSERS.includes(chooser)) errors.push(t('error.chooser'));
	const chooserGroup = cleanText(raw.chooserGroup, 120);
	if (chooser === 'group' && !chooserGroup) errors.push(t('error.chooser-group'));

	const defaultIcon = String(raw.defaultIcon == null ? '' : raw.defaultIcon).trim();
	if (defaultIcon && !ids.has(defaultIcon)) errors.push(t('error.default-unknown'));

	const map = parseJson(raw.categoryDefaults, {});
	const categoryDefaults = {};
	if (!map || typeof map !== 'object' || Array.isArray(map)) {
		errors.push(t('error.category-defaults'));
	} else {
		Object.keys(map).forEach((cid) => {
			const id = String(map[cid] == null ? '' : map[cid]).trim();
			if (!id) return;
			if (!cleanCid(cid) || !ids.has(id)) errors.push(t('error.category-default-unknown', cleanCid(cid) || 0));
			else categoryDefaults[cleanCid(cid)] = id;
		});
	}

	return {
		errors,
		settings: Object.assign({}, raw, {
			chooser: CHOOSERS.includes(chooser) ? chooser : 'all',
			chooserGroup,
			showInList: toBool(raw.showInList, true) ? 'on' : 'off',
			showInTopic: toBool(raw.showInTopic, true) ? 'on' : 'off',
			defaultIcon: ids.has(defaultIcon) ? defaultIcon : '',
			categoryDefaults: JSON.stringify(categoryDefaults),
			icons: JSON.stringify(icons),
		}),
	};
}

/**
 * @param {object} icon normalised icon
 * @param {number|string} cid
 * @returns {boolean} whether the icon may be offered in the category (active and listed there,
 *   or not limited to any category)
 */
function isOffered(icon, cid) {
	if (!icon || !icon.active) return false;
	return !icon.cids.length || icon.cids.includes(cleanCid(cid));
}

/**
 * @param {object} config normalised config
 * @param {number|string} cid
 * @returns {Array<object>} icons offered in the category, in library order
 */
function iconsFor(config, cid) {
	return config.icons.filter(icon => isOffered(icon, cid));
}

/**
 * @param {object} config normalised config
 * @param {string} id
 * @returns {object|null}
 */
function findIcon(config, id) {
	const clean = cleanId(id);
	return (clean && config.icons.find(i => i.id === clean)) || null;
}

/**
 * Default icon of a category: its own default, otherwise the forum-wide one. A default that is
 * inactive is skipped, so switching an icon off also takes it off topics that only had it as a
 * default.
 *
 * @param {object} config normalised config
 * @param {number|string} cid
 * @returns {object|null}
 */
function defaultFor(config, cid) {
	const own = findIcon(config, config.categoryDefaults[cleanCid(cid)]);
	if (own && own.active) return own;
	const forum = findIcon(config, config.defaultIcon);
	return forum && forum.active ? forum : null;
}

/**
 * Icon shown for a topic: the one its author picked while it is still in the library (also
 * when it was switched off later, so existing topics keep their look), otherwise the default of
 * the topic's category.
 *
 * @param {object} config normalised config
 * @param {string} iconId value of the topic field (may be empty)
 * @param {number|string} cid category of the topic
 * @returns {{icon: object, isDefault: boolean}|null}
 */
function effectiveIcon(config, iconId, cid) {
	const own = findIcon(config, iconId);
	if (own) return { icon: own, isDefault: false };
	const fallback = defaultFor(config, cid);
	return fallback ? { icon: fallback, isDefault: true } : null;
}

/**
 * Where the displayed name comes from: the admin-typed name, the translation of a built-in key,
 * or a generic label.
 *
 * @param {object} icon normalised icon
 * @returns {{text: string}|{token: string}}
 */
function nameSource(icon) {
	if (icon.name) return { text: icon.name };
	if (icon.key) return { token: `[[${NAMESPACE}:icon.${icon.key}]]` };
	return { token: `[[${NAMESPACE}:icon-generic]]` };
}

/**
 * Site-relative URLs are stored without the forum's relative_path (e.g. "/forum") and get it
 * on output, unless the admin already typed it.
 *
 * @param {string} url normalised URL
 * @param {string} [relativePath]
 * @returns {string}
 */
function withRelativePath(url, relativePath) {
	if (!url || !relativePath || url.charAt(0) !== '/' || url.startsWith(`${relativePath}/`)) return url;
	return relativePath + url;
}

/**
 * Icon markup. The name (plain text, already translated) is escaped here and becomes the alt
 * text and the tooltip; the markup contains no translation tokens. SVG files are only ever
 * shown through <img>, where scripts inside them do not run.
 *
 * @param {object} icon normalised icon
 * @param {string} name plain-text name
 * @param {{relativePath?: string, lang?: string, isDefault?: boolean}} [opts]
 * @returns {string} HTML
 */
function buildHtml(icon, name, opts) {
	opts = opts || {};
	const src = withRelativePath(icon.url, opts.relativePath || '');
	const n = escape(name);
	const cls = `topic-icon${opts.isDefault ? ' topic-icon--default' : ''}`;
	return `<span class="${cls}" data-topic-icon="${escape(icon.id)}" data-ti-lang="${escape(opts.lang || '')}">` +
		`<img class="topic-icon__img" src="${escape(src)}" alt="${n}" title="${n}" width="40" height="40" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>`;
}

module.exports = {
	NAMESPACE,
	ACP_NAMESPACE,
	CHOOSERS,
	MAX_ICONS,
	MAX_NAME,
	IMAGE_EXTENSIONS,
	BUILTIN_BASE,
	BUILTIN_KEYS,
	escape,
	cleanText,
	cleanId,
	cleanUrl,
	cleanCid,
	cleanCids,
	builtinIcons,
	defaults,
	normalize,
	validateSettings,
	isOffered,
	iconsFor,
	findIcon,
	defaultFor,
	effectiveIcon,
	nameSource,
	withRelativePath,
	buildHtml,
};
