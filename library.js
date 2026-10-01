'use strict';

/*
 * nodebb-plugin-topic-icons: server entry point (declared as "library" in plugin.json).
 *
 * Wires the pure modules in lib/ (icon library, rules, upload checks, language choice, caches)
 * into NodeBB 4.x hooks:
 * - the icon library and its settings live in the plugin settings hash (meta.settings);
 * - the icon picked for a topic is one field of the topic object: topic:<tid> → iconId, and the
 *   topic is listed in a per-icon sorted set, so that removing an icon from the library can clear
 *   it from its topics; nothing else is stored, so it works with Redis, MongoDB and PostgreSQL;
 * - the choice is validated on the server when a topic is posted, when it is put in the post
 *   queue, and when its first post is edited (lib/rules.js); a topic moved to a category where
 *   its icon is not available loses it;
 * - lists of topics get `topicIcon` from fields NodeBB has already loaded (no extra topic query),
 *   the topic page gets it too; everything is rendered in the viewer's language (see "Language");
 * - topic covers (lib/covers.js): a topic without NodeBB thumbnails gets the first image of its
 *   first post or the default cover of its category as a thumbnail at display time (see
 *   "Covers").
 *
 * The hook handlers below are referenced by name from plugin.json; getTopicIcons is an API for
 * other plugins and themes.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rateLimit } = require('express-rate-limit');

const nconf = require.main.require('nconf');
const winston = require.main.require('winston');
const db = require.main.require('./src/database');
const meta = require.main.require('./src/meta');
const groups = require.main.require('./src/groups');
const user = require.main.require('./src/user');
const topics = require.main.require('./src/topics');
const posts = require.main.require('./src/posts');
const categories = require.main.require('./src/categories');
const privileges = require.main.require('./src/privileges');
const pubsub = require.main.require('./src/pubsub');
const translator = require.main.require('./src/translator');
const languages = require.main.require('./src/languages');
const utils = require.main.require('./src/utils');
const file = require.main.require('./src/file');
const middleware = require.main.require('./src/middleware');
const uploadMiddleware = require.main.require('./src/middleware/multer');
const routeHelpers = require.main.require('./src/routes/helpers');
const controllerHelpers = require.main.require('./src/controllers/helpers');
const batch = require.main.require('./src/batch');

const icons = require('./lib/icons');
const covers = require('./lib/covers');
const rules = require('./lib/rules');
const upload = require('./lib/upload');
const LRU = require('./lib/lru');
const ConfigStore = require('./lib/config-store');
const { BASE_OPTIONS: RATE_LIMIT, onPageLimit } = require('./lib/rate-limit');
const { fileInFolder, MULTER_NAME } = require('./lib/safe-path');
const updateCheck = require('./lib/update-check');
const { pickLang, isLangCode } = require('./lib/lang');

const { isLocalUid } = rules;

/** Hash under which meta.settings stores the plugin configuration (also used by public/admin.js). */
const SETTINGS_KEY = 'topic-icons';

// Update notices on the ACP page (lib/update-check.js); public plugin, with a link to the release notes.
const updates = updateCheck.forNodeBB({
	id: 'nodebb-plugin-topic-icons',
	version: require('./package.json').version,
	isPrivate: false,
	settingsHash: `${SETTINGS_KEY}-update-check`,
});
/** Sub-folder of NodeBB's upload_path for icons uploaded from the ACP. */
const UPLOAD_FOLDER = 'topic-icons';
/**
 * Topic field that holds the picked icon id; the composer / API payload (topics.post and
 * posts.edit) uses the same name, and lib/rules.js reads it as data.iconId.
 */
const TOPIC_FIELD = 'iconId';
/**
 * Topic field with the first image of the first post, found once per first post (JSON, see
 * lib/covers.js parseScan). Written when it is missing or belongs to another post, and when the
 * first post is edited.
 */
const COVER_FIELD = 'coverScan';
/** Most topics getTopicIcons() renders in one call. */
const MAX_TIDS = 500;
/** Most topics the /topic-icons/icons route renders in one request. */
const MAX_RELOCALIZE = 100;

const plugin = module.exports;

// ---------------------------------------------------------------- settings cache

/*
 * Normalised configuration, kept in memory for the life of the process: every list of topics
 * needs it, and meta.settings.get() would otherwise hit the database on each request.
 *
 * Invalidation has two paths because NodeBB may run several processes:
 * - the local process gets the "action:settings.set" hook (plugin.onSettingsSet);
 * - the other processes get the "action:settings.set.<hash>" pubsub message that
 *   meta.settings.set() publishes (subscribed in plugin.init).
 * Both call store.invalidate(). Each config carries its generation (lib/config-store.js), and
 * rendered icons are cached under that generation only while it is current.
 */

/*
 * Rendered icons (name and HTML) per (generation, language, icon, default flag). A forum has a
 * few dozen icons, so after warm-up a page of topics costs no translation work. LRU with a cap,
 * so many distinct ?lang= values evict only the least recently used entries.
 */
const htmlCache = new LRU(2000);

const store = new ConfigStore(
	async () => {
		const raw = await meta.settings.get(SETTINGS_KEY);
		const config = icons.normalize(raw);
		config.covers = covers.normalize(raw);
		return config;
	},
	() => htmlCache.clear()
);

// ---------------------------------------------------------------- language

/*
 * Language setting per uid ('' = none). Topic lists call getLang() on every request, and
 * user.getSettings() has no cache in NodeBB; entries are dropped when the user saves their
 * settings in this process (action:user.saveSettings) and expire after a minute, so a change
 * made through another process shows up soon as well.
 */
const langCache = new LRU(5000, { ttl: 60 * 1000 });

/**
 * Language of a user: their own setting, otherwise the forum default. Used where only a uid is
 * known (topic hooks); see viewerLang() for requests.
 *
 * @param {number|string} uid viewer uid (0 for guests)
 * @returns {Promise<string>}
 */
async function getLang(uid) {
	let userLang;
	if (isLocalUid(uid)) {
		const key = String(uid);
		userLang = langCache.get(key);
		if (userLang === undefined) {
			const settings = await user.getSettings(uid);
			userLang = (settings && isLangCode(settings.userLang) && settings.userLang) || '';
			langCache.set(key, userLang);
		}
	}
	return pickLang({ userLang, defaultLang: meta.config.defaultLang });
}

/**
 * Languages installed on the forum; guests' browser language is matched against them.
 *
 * @returns {Promise<string[]>}
 */
async function installedLangs() {
	try {
		return await languages.listCodes();
	} catch {
		return [];
	}
}

/**
 * Language of the viewer of a request: ?lang= (validated against the installed languages by
 * the core autoLocale middleware, which also sets it for guests from the browser language on
 * page and ajaxify routes) → the user's setting (from res.locals.config on full page loads,
 * from the (cached) settings otherwise) → for guests on API v3 routes, where autoLocale runs
 * before the user is known, the browser language when "auto-detect language" is on → the forum
 * default.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} [res]
 * @returns {Promise<string>}
 */
async function viewerLang(req, res) {
	const query = req && req.query && req.query.lang;
	if (isLangCode(query)) return query;
	const localConfig = res && res.locals && res.locals.config;
	if (localConfig && isLangCode(localConfig.userLang)) return localConfig.userLang;
	const uid = req && req.uid;
	if (!isLocalUid(uid) && req && typeof req.acceptsLanguages === 'function' && meta.config.autoDetectLang) {
		const codes = await installedLangs();
		const detected = codes.length ? req.acceptsLanguages(codes) : false;
		if (isLangCode(detected)) return detected;
	}
	return getLang(uid);
}

/**
 * Drops the cached language of a user who saved their settings.
 *
 * Hook: action:user.saveSettings
 *
 * @param {{uid: number}} data
 * @returns {Promise<void>}
 */
plugin.onUserSaveSettings = async function (data) {
	if (data && data.uid !== undefined) langCache.delete(String(data.uid));
};

// ---------------------------------------------------------------- rendering

/**
 * Plain-text name of an icon in one language.
 *
 * @param {object} icon normalised icon
 * @param {string} lang
 * @returns {Promise<string>}
 */
async function iconName(icon, lang) {
	const source = icons.nameSource(icon);
	if (source.text) return source.text;
	// Language-file strings are plain text; lib/icons.js escapes the result.
	return translator.translate(source.token, lang);
}

/**
 * Rendered icon for a topic, or null when neither the topic nor its category has one.
 * The returned object is a copy; `_lang`, `_iconId` and `_cid` are non-enumerable (not sent to
 * the browser) and let relocalize() re-render it in another language.
 *
 * @param {object} config normalised config (from store.get(), with its generation)
 * @param {string} iconId value of the topic field
 * @param {number|string} cid category of the topic
 * @param {string} lang
 * @returns {Promise<{id: string, name: string, url: string, isDefault: boolean, html: string}|null>}
 */
async function renderTopicIcon(config, iconId, cid, lang) {
	const found = icons.effectiveIcon(config, iconId, cid);
	if (!found) return null;
	const key = `${config.generation}|${lang}|${found.icon.id}|${found.isDefault ? 1 : 0}`;
	let rendered = htmlCache.get(key);
	if (!rendered) {
		const relativePath = nconf.get('relative_path') || '';
		const name = await iconName(found.icon, lang);
		rendered = {
			id: found.icon.id,
			name,
			url: icons.withRelativePath(found.icon.url, relativePath),
			isDefault: found.isDefault,
			html: icons.buildHtml(found.icon, name, { relativePath, lang, isDefault: found.isDefault }),
		};
		if (store.isCurrent(config)) htmlCache.set(key, rendered);
	}
	const copy = Object.assign({}, rendered);
	Object.defineProperty(copy, '_lang', { value: lang, enumerable: false });
	Object.defineProperty(copy, '_iconId', { value: iconId || '', enumerable: false });
	Object.defineProperty(copy, '_cid', { value: cid, enumerable: false });
	return copy;
}

/**
 * Puts `obj.topicIcon` into another language, if it was rendered in a different one.
 *
 * @param {object} config
 * @param {object} obj topic object
 * @param {string} lang
 * @returns {Promise<void>}
 */
async function relocalize(config, obj, lang) {
	const current = obj && obj.topicIcon;
	if (!current || current._lang === undefined || current._lang === lang) return;
	obj.topicIcon = (await renderTopicIcon(config, current._iconId, current._cid, lang)) || current;
}

/**
 * Rendered icons of topics, aligned with `tids`, in one database call.
 *
 * @param {object} config
 * @param {number[]} tids clean topic ids
 * @param {string} lang
 * @returns {Promise<Array<object|null>>}
 */
async function renderTopics(config, tids, lang) {
	if (!tids.length) return [];
	const data = await db.getObjectsFields(tids.map(tid => `topic:${tid}`), ['cid', TOPIC_FIELD]);
	return Promise.all(data.map(t => (t && t.cid ? renderTopicIcon(config, t[TOPIC_FIELD], t.cid, lang) : null)));
}

/**
 * Icons for many topics at once, for other plugins and themes (e.g. a "recent topics" widget):
 * `require.main.require('nodebb-plugin-topic-icons').getTopicIcons(tids, { lang: 'pl' })`.
 * One database call for all topics (db.getObjectsFields). Not bound to a hook and without
 * privilege checks: pass only topics the viewer may see.
 *
 * At most MAX_TIDS topics per call; invalid ids and entries past the limit get null. `lang`
 * must be an installed language, otherwise the forum default is used.
 *
 * @param {Array<number|string>} tids
 * @param {{lang?: string}} [opts]
 * @returns {Promise<Array<object|null>>} rendered icons aligned with `tids`
 */
plugin.getTopicIcons = async function (tids, opts) {
	opts = opts || {};
	if (!Array.isArray(tids) || !tids.length) return [];
	const config = await store.get();
	const wanted = isLangCode(opts.lang) && (await installedLangs()).includes(opts.lang) ? opts.lang : undefined;
	const lang = pickLang({ query: wanted, defaultLang: meta.config.defaultLang });
	const clean = tids.map((tid, i) => (i < MAX_TIDS ? icons.cleanCid(tid) : 0));
	const valid = clean.filter(Boolean);
	const rendered = await renderTopics(config, valid, lang);
	let next = 0;
	return clean.map((tid) => {
		if (!tid) return null;
		const out = rendered[next];
		next += 1;
		return out || null;
	});
};

// ---------------------------------------------------------------- covers

/*
 * Covers are added at display time to topics that have no NodeBB thumbnails (lib/covers.js
 * pickCover): first image of the first post → default cover of the category → none. They go into
 * `thumbs`, so themes show them where they show thumbnails and NodeBB's own viewer opens them on
 * the topic page; nothing is written into the topic's thumbnails.
 *
 * The first image is found once per first post and kept in the topic field COVER_FIELD together
 * with the pid it belongs to: written when the first post is edited (action:post.edit), and for
 * topics without it (older topics, new topics) the first time they are listed, with one post
 * query for the whole list. Lists of topics that were already scanned cost no extra query; an
 * edit that removes the image clears the cover right away.
 */

/**
 * Where NodeBB serves uploads, for lib/covers.js.
 *
 * @returns {{uploadUrl: string, relativePath: string, baseUrl: string}}
 */
function siteInfo() {
	return {
		uploadUrl: nconf.get('upload_url') || '/assets/uploads',
		relativePath: nconf.get('relative_path') || '',
		baseUrl: String(nconf.get('base_url') || nconf.get('url') || '').replace(/(^https?:\/\/[^/]+).*$/i, '$1'),
	};
}

/**
 * Scan results for topics, aligned with `list`: stored ones when they belong to the current first
 * post, otherwise the first posts are read (one query) and the results stored.
 *
 * @param {Array<object>} list topic objects (tid, mainPid and COVER_FIELD as loaded by NodeBB)
 * @returns {Promise<Array<{local: string, any: string}|null>>}
 */
async function scansFor(list) {
	const out = list.map((t) => {
		const scan = covers.parseScan(t[COVER_FIELD]);
		return scan && t.mainPid && scan.pid === String(t.mainPid) ? scan : null;
	});
	const missing = list.map((t, i) => (out[i] || !t.mainPid ? -1 : i)).filter(i => i !== -1);
	if (!missing.length) return out;
	const postData = await posts.getPostsFields(missing.map(i => list[i].mainPid), ['pid', 'content', 'sourceContent']);
	const site = siteInfo();
	const writes = [];
	missing.forEach((i, n) => {
		const p = postData[n];
		if (!p || !p.pid) return;
		const scan = covers.scanPost(p.sourceContent || p.content, site);
		out[i] = scan;
		writes.push([`topic:${list[i].tid}`, { [COVER_FIELD]: covers.serializeScan(list[i].mainPid, scan) }]);
	});
	if (writes.length) {
		try {
			await db.setObjectBulk(writes);
		} catch (err) {
			winston.warn(`[topic-icons] Cannot store cover scans: ${err.message}`);
		}
	}
	return out;
}

/**
 * Gives topics without thumbnails their cover (see the section comment) and sets `topicCover`
 * { url, source: 'own'|'auto'|'category' } on every topic that shows one, for themes.
 *
 * @param {object} config normalised config (with `covers`)
 * @param {Array<object>} list topic objects with `thumbs` (NodeBB's)
 * @param {number|string} uid viewer
 * @returns {Promise<void>}
 */
async function addCovers(config, list, uid) {
	const c = config.covers;
	const own = t => Array.isArray(t.thumbs) && t.thumbs.length > 0;
	const candidates = list.filter(t => t && t.tid && t.cid);
	if (!candidates.length) return;
	const needScan = c.auto ? candidates.filter(t => !own(t)) : [];
	const scans = needScan.length ? await scansFor(needScan) : [];
	const scanByTid = new Map(needScan.map((t, i) => [String(t.tid), scans[i]]));
	const site = siteInfo();
	const guest = !isLocalUid(uid);
	const privateUploads = meta.config.privateUploads === 1 || meta.config.privateUploads === '1';
	candidates.forEach((t) => {
		// Internal bookkeeping, not sent to the browser.
		delete t[COVER_FIELD];
		const picked = covers.pickCover(c, {
			hasThumbs: own(t),
			cid: t.cid,
			scan: scanByTid.get(String(t.tid)) || null,
			guest,
			privateUploads,
		});
		if (!picked) return;
		if (picked.source === 'own') {
			t.topicCover = { url: t.thumbs[0].url, source: 'own' };
			return;
		}
		const thumb = covers.toThumb(picked, t.tid, site);
		t.thumbs = [thumb];
		t.topicCover = { url: thumb.url, source: picked.source };
	});
}

/**
 * Keeps the stored first image of a topic in step with its first post: an edit of the first
 * post scans the new content, so an image added or removed shows (or goes) right away.
 *
 * Hook: action:post.edit
 *
 * @param {{post: object, data: object}} hookData
 * @returns {Promise<void>}
 */
plugin.onPostEdited = async function (hookData) {
	const post = hookData && hookData.post;
	if (!post || !post.tid || !post.topic || !post.topic.isMainPost) return;
	try {
		const data = hookData.data || {};
		const content = [data.sourceContent, post.newContent, data.content, post.content].find(v => typeof v === 'string');
		if (content === undefined) {
			await topics.deleteTopicField(post.tid, COVER_FIELD);
			return;
		}
		await topics.setTopicField(post.tid, COVER_FIELD, covers.serializeScan(post.pid, covers.scanPost(content, siteInfo())));
	} catch (err) {
		winston.warn(`[topic-icons] Cannot update the cover of topic ${post.tid}: ${err.message}`);
	}
};

// ---------------------------------------------------------------- permissions

/** Access checks used by lib/rules.js. */
const access = {
	isAdminOrMod: (cid, uid) => privileges.categories.isAdminOrMod(cid, uid),
	isMember: (uid, groupName) => groups.isMember(uid, groupName),
};

/*
 * Icon changes validated in filter:topic.post / filter:post.edit, keyed by the payload object
 * that NodeBB passes on to filter:topic.create / filter:topic.edit. A WeakMap, so nothing leaks
 * when a request fails in between.
 */
const validated = new WeakMap();

/**
 * @param {object} data topics.post or posts.edit payload
 * @returns {boolean} whether the payload carries an icon choice ('' = remove the icon)
 */
function hasChoice(data) {
	return !!data && data[TOPIC_FIELD] !== undefined && data[TOPIC_FIELD] !== null;
}

/**
 * Sorted set of the topics that use an icon (score: time), so that removing the icon from the
 * library can clear it from those topics without scanning all topics.
 *
 * @param {string} id clean icon id
 * @returns {string}
 */
function indexKey(id) {
	return `${SETTINGS_KEY}:icon:${id}:tids`;
}

// ---------------------------------------------------------------- hooks

/**
 * Registers the ACP page and the ACP upload route, creates the upload folder and subscribes to
 * settings changes made in other NodeBB processes.
 *
 * Hook: static:app.load
 *
 * @param {{router: import('express').Router}} params
 * @returns {Promise<void>}
 */
plugin.init = async function ({ router }) {
	// setupAdminPageRoute adds NodeBB's admin middleware, so only administrators reach this page.
	routeHelpers.setupAdminPageRoute(router, '/admin/plugins/topic-icons', [limits.adminPage], async (req, res) => {
		const cids = await categories.getAllCidsFromSet('categories:cid');
		const cats = (await categories.getCategoriesFields(cids, ['cid', 'name', 'parentCid', 'order', 'disabled']))
			.filter(c => c && parseInt(c.cid, 10) > 0);
		const groupNames = (await groups.getNonPrivilegeGroups('groups:createtime', 0, -1, { ephemeral: false }))
			.map(g => g && g.name)
			.filter(name => name && !icons.EXCLUDED_GROUPS.includes(name));
		res.render('admin/plugins/topic-icons', {
			title: `[[${icons.ACP_NAMESPACE}:title]]`,
			defaults: Object.assign(icons.defaults(), covers.defaults()),
			// Tree order with depth; names as plain text (public/admin.js escapes them).
			categoryList: icons.categoryTree(cats).map(c => ({
				cid: c.cid,
				name: utils.decodeHTMLEntities(String(c.name || '')),
				depth: c.depth,
				disabled: !!c.disabled,
			})),
			groupList: groupNames,
			maxUploadKb: Math.floor(upload.MAX_BYTES / 1024),
			maxCoverKb: Math.floor(upload.COVER_MAX_BYTES / 1024),
			// Cover switches as they apply now (keys never saved take their defaults).
			coverState: covers.normalize(await meta.settings.get(SETTINGS_KEY)),
			// The page is open to admin:settings, uploads to administrators only.
			canUpload: await user.isAdministrator(req.uid),
			...(await updates.templateData()),
		});
	});

	// Icon upload. Administrators only, checked before multer so that nobody else can write
	// files to the temporary folder; with the CSRF token of the ACP session. Type, content and
	// size are checked by lib/upload.js, and the file is stored under a new unique name. The
	// request limiter also runs before multer, so the body is not read once the limit is hit.
	router.post(
		'/api/admin/plugins/topic-icons/upload',
		middleware.ensureLoggedIn,
		middleware.applyCSRF,
		ensureAdmin,
		limits.upload,
		uploadMiddleware.single('file'),
		routeHelpers.tryRoute(plugin._uploadIcon, (err, res) => res.status(400).json({ error: err.message }))
	);
	// Category cover upload: the same guards, with the cover types and size (lib/upload.js).
	router.post(
		'/api/admin/plugins/topic-icons/upload-cover',
		middleware.ensureLoggedIn,
		middleware.applyCSRF,
		ensureAdmin,
		limits.upload,
		uploadMiddleware.single('file'),
		routeHelpers.tryRoute(plugin._uploadCover, (err, res) => res.status(400).json({ error: err.message }))
	);

	try {
		await fs.promises.mkdir(path.join(nconf.get('upload_path'), UPLOAD_FOLDER), { recursive: true });
	} catch (err) {
		winston.warn(`[topic-icons] Cannot create upload folder: ${err.message}`);
	}

	pubsub.on(`action:settings.set.${SETTINGS_KEY}`, () => store.invalidate());
	updates.start();
};

/*
 * Request limits per user (guests: per IP address) per minute, with express-rate-limit
 * (lib/rate-limit.js). Generous for normal use; they only stop scripted floods.
 */
const limits = {
	adminPage: rateLimit({ ...RATE_LIMIT, limit: 60, handler: onPageLimit }),
	upload: rateLimit({
		...RATE_LIMIT,
		limit: 20,
		handler: (req, res) => res.status(429).json({ error: `[[${icons.ACP_NAMESPACE}:upload-rate-limit]]` }),
	}),
	api: rateLimit({
		...RATE_LIMIT,
		limit: 300,
		handler: (req, res) => controllerHelpers.formatApiResponse(429, res),
	}),
};

/*
 * Folder where NodeBB's multer middleware (disk storage without a destination) writes uploads:
 * the system temporary folder, fixed when the plugin loads. Temporary paths are rebuilt from this
 * folder and multer's file name, never taken from the request as they are.
 */
const TEMP_DIR = path.resolve(os.tmpdir());

/**
 * Refuses the upload route to everyone but administrators, before the body is read.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {function} next
 * @returns {void}
 */
function ensureAdmin(req, res, next) {
	user.isAdministrator(req.uid).then((isAdmin) => {
		if (isAdmin) return next();
		res.status(403).json({ error: `[[${icons.ACP_NAMESPACE}:upload-forbidden]]` });
	}, next);
}

/**
 * Handler of POST /api/admin/plugins/topic-icons/upload (multipart, field "file"), behind
 * ensureAdmin.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>} responds with { url } or { error } (a translation token)
 */
plugin._uploadIcon = async function (req, res) {
	await storeUpload(req, res, { maxBytes: upload.MAX_BYTES, check: upload.checkUpload, prefix: 'ti', typeKey: 'upload-type' });
};

/**
 * Handler of POST /api/admin/plugins/topic-icons/upload-cover (multipart, field "file"), behind
 * ensureAdmin: a category cover (PNG, JPEG, WebP, GIF or SVG).
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>} responds with { url } or { error } (a translation token)
 */
plugin._uploadCover = async function (req, res) {
	await storeUpload(req, res, { maxBytes: upload.COVER_MAX_BYTES, check: upload.checkCoverUpload, prefix: 'tc', typeKey: 'cover-upload-type' });
};

/**
 * Checks an ACP upload (type, content, size; SVGs without scripts) and stores it under a new
 * unique name in the plugin's upload folder.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{maxBytes: number, check: function, prefix: string, typeKey: string}} opts
 * @returns {Promise<void>}
 */
async function storeUpload(req, res, opts) {
	const fail = (key) => {
		const arg = key === 'upload-size' ? `, ${Math.floor(opts.maxBytes / 1024)}` : '';
		res.status(400).json({ error: `[[${icons.ACP_NAMESPACE}:${key === 'upload-type' ? opts.typeKey : key}${arg}]]` });
	};
	const f = req.file;
	// Only multer's temporary file is read, copied and deleted. Its path is rebuilt from the fixed
	// temporary folder and the bare file name, which must look like a multer name (32 hex digits);
	// the file must be a regular file there, never a symbolic link.
	let tempPath = null;
	try {
		if (!f || !f.path) return fail('upload-missing');
		const tempName = path.basename(String(f.path));
		const candidate = path.join(TEMP_DIR, tempName);
		if (!MULTER_NAME.test(tempName) || !path.resolve(candidate).startsWith(TEMP_DIR + path.sep) ||
			path.resolve(String(f.path)) !== candidate) {
			winston.warn('[topic-icons] Upload refused: the temporary file is not in the temporary folder');
			return fail('upload-missing');
		}
		const stat = await fs.promises.lstat(candidate).catch(() => null);
		if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
			winston.warn('[topic-icons] Upload refused: the temporary file is not a regular file');
			return fail('upload-missing');
		}
		tempPath = candidate;
		if (f.size > opts.maxBytes) return fail('upload-size');
		const content = await fs.promises.readFile(tempPath);
		const result = opts.check(f, content);
		if (result.error) return fail(result.error);
		if (result.ext === 'svg' && !upload.isSafeSvg(content.toString('utf8'))) return fail('upload-svg-unsafe');
		const name = upload.uniqueName(result.ext, crypto.randomBytes(8).toString('hex'), undefined, opts.prefix);
		const stored = await file.saveFileToLocal(name, UPLOAD_FOLDER, tempPath);
		res.json({ url: stored.url });
	} finally {
		// Newer NodeBB versions delete multer's temporary file themselves; doing it here as well
		// keeps refused uploads from piling up in the temporary folder on any version.
		if (tempPath) fs.promises.unlink(tempPath).catch(() => {});
	}
}

/**
 * Topic whose icon the picker edits, from ?pid= (the post being edited; composer-default does not
 * give the composer a tid when editing) or ?tid=. The post must be the first post of the topic.
 *
 * @param {object} query req.query
 * @returns {Promise<{tid: number, topic: object}|null>} null when there is no such topic
 */
async function topicForPicker(query) {
	let tid = icons.cleanCid(query.tid);
	const pid = icons.cleanCid(query.pid);
	if (pid) {
		const postTid = icons.cleanCid(await posts.getPostField(pid, 'tid'));
		if (!postTid || (tid && tid !== postTid)) return null;
		tid = postTid;
	}
	if (!tid) return null;
	const topic = await topics.getTopicFields(tid, ['cid', 'uid', 'mainPid', TOPIC_FIELD]);
	if (!topic || !icons.cleanCid(topic.cid)) return null;
	if (pid && String(topic.mainPid) !== String(pid)) return null;
	return { tid, topic };
}

/**
 * Routes under /api/v3/plugins (NodeBB's API v3 conventions and middleware):
 *
 * GET /topic-icons/choices?cid=<cid> (new topic), ?pid=<pid> or ?tid=<tid> (editing the first
 * post): what the composer's picker needs. Icons offered in the category, the category default
 * and, when editing, the current icon (`currentIcon` when it is no longer offered, so the picker
 * can show it as unavailable) and the author's display name for the preview. `canChoose` is
 * false when the viewer may not pick (the picker is then not shown). Names are plain text in the
 * viewer's language; URLs include relative_path.
 *
 * GET /topic-icons/icons?tids=1,2,3: rendered icons of up to MAX_RELOCALIZE readable topics in
 * the viewer's language, for topic lists that came from a route without the viewer's language
 * (infinite scroll of guests, see public/client.js).
 *
 * Hook: static:api.routes
 *
 * @param {{router: import('express').Router}} params
 * @returns {Promise<void>}
 */
plugin.addApiRoutes = async function ({ router }) {
	routeHelpers.setupApiRoute(router, 'get', '/topic-icons/choices', [limits.api], async (req, res) => {
		const config = await store.get();
		const uid = req.uid;
		let cid;
		let current = '';
		let author = '';
		let allowed;

		if (req.query.pid !== undefined || req.query.tid !== undefined) {
			const found = await topicForPicker(req.query);
			if (!found || !(await privileges.topics.canRead(found.tid, uid))) {
				return controllerHelpers.formatApiResponse(404, res);
			}
			const { topic } = found;
			cid = icons.cleanCid(topic.cid);
			current = icons.cleanId(topic[TOPIC_FIELD]);
			allowed = isLocalUid(uid) && (String(topic.uid) === String(uid) || await privileges.categories.isAdminOrMod(cid, uid));
			if (isLocalUid(topic.uid)) {
				const u = await user.getUserFields(topic.uid, ['username', 'displayname']);
				author = utils.decodeHTMLEntities(String((u && (u.displayname || u.username)) || ''));
			}
		} else {
			cid = icons.cleanCid(req.query.cid);
			if (!cid) return controllerHelpers.formatApiResponse(400, res);
			const [canRead, canCreate] = await privileges.categories.can(['topics:read', 'topics:create'], cid, uid);
			if (!canRead) return controllerHelpers.formatApiResponse(404, res);
			allowed = canCreate;
		}
		allowed = allowed && await rules.canChoose(config, uid, cid, access);

		const lang = await viewerLang(req);
		const describe = async icon => ({
			id: icon.id,
			name: await iconName(icon, lang),
			url: icons.withRelativePath(icon.url, nconf.get('relative_path') || ''),
		});
		const list = allowed ? icons.iconsFor(config, cid) : [];
		const currentIcon = icons.findIcon(config, current);
		const fallback = icons.defaultFor(config, cid);
		controllerHelpers.formatApiResponse(200, res, {
			canChoose: !!allowed,
			cid,
			current: currentIcon ? currentIcon.id : '',
			icons: await Promise.all(list.map(describe)),
			// The current icon when it is no longer offered here: shown as unavailable.
			currentIcon: currentIcon && !list.includes(currentIcon) ? await describe(currentIcon) : null,
			defaultIcon: fallback ? await describe(fallback) : null,
			author,
		});
	});

	routeHelpers.setupApiRoute(router, 'get', '/topic-icons/icons', [limits.api], async (req, res) => {
		const raw = String(req.query.tids || '').split(',').slice(0, MAX_RELOCALIZE);
		const tids = raw.map(icons.cleanCid).filter(Boolean);
		if (!tids.length) return controllerHelpers.formatApiResponse(400, res);
		const config = await store.get();
		if (!config.showInList || !config.icons.length) return controllerHelpers.formatApiResponse(200, res, { icons: {} });
		const readable = await privileges.topics.filterTids('topics:read', tids, req.uid);
		const rendered = await renderTopics(config, readable, await viewerLang(req));
		const out = {};
		readable.forEach((tid, i) => {
			if (rendered[i]) out[tid] = rendered[i];
		});
		controllerHelpers.formatApiResponse(200, res, { icons: out });
	});
};

/*
 * Clean-up planned by onSettingsSave and carried out by onSettingsSet once the settings are
 * stored: icons removed from the library and uploaded files no icon uses any more. Both hooks
 * run in the process that saves, one right after the other (meta.settings.set).
 */
let pendingCleanup = null;

/**
 * Validates the plugin settings before they are stored; a bad library is refused with an error
 * shown in the ACP instead of being saved. The ACP runs the same checks before sending.
 *
 * A partial save (meta.settings.setOne, or a script sending only some keys) is merged with the
 * stored settings first, so it neither fails nor resets the other keys.
 *
 * Hook: filter:settings.set
 *
 * @param {{plugin: string, settings: object}} data
 * @returns {Promise<object>} the same data, with cleaned settings
 */
plugin.onSettingsSave = async function (data) {
	if (!data || data.plugin !== SETTINGS_KEY) return data;
	const stored = (await meta.settings.get(SETTINGS_KEY)) || {};
	const merged = Object.assign({}, icons.defaults(), covers.defaults(), stored, data.settings || {});
	const chooserGroup = icons.cleanText(merged.chooserGroup, 120);
	const groupExists = merged.chooser === 'group' && chooserGroup ? !!(await groups.exists(chooserGroup)) : undefined;
	const { errors, settings } = icons.validateSettings(merged, { groupExists });
	const coverResult = covers.validateSettings(merged);
	errors.push(...coverResult.errors);
	if (errors.length) throw new Error(errors[0]);
	const before = icons.normalize(stored).icons;
	const after = icons.normalize(settings).icons;
	pendingCleanup = icons.libraryChanges(before, after);
	// Category covers that were removed or replaced: their uploaded files go too.
	pendingCleanup.files.push(...covers.unusedFiles(
		covers.normalize(stored).categoryCovers,
		covers.normalize(coverResult.settings).categoryCovers
	));
	data.settings = Object.assign(settings, coverResult.settings);
	return data;
};

/**
 * Takes icons removed from the library off their topics (through the per-icon index, in
 * batches), so that an icon added again later under the same id does not come back on old
 * topics, and deletes uploaded files no icon uses any more.
 *
 * @param {{ids: string[], files: string[]}} changes see lib/icons.js libraryChanges
 * @returns {Promise<void>}
 */
async function cleanUp(changes) {
	for (const id of changes.ids) {
		const key = indexKey(id);
		await batch.processSortedSet(key, async (tids) => {
			const data = await db.getObjectsFields(tids.map(tid => `topic:${tid}`), [TOPIC_FIELD]);
			const stale = tids.filter((tid, i) => data[i] && data[i][TOPIC_FIELD] === id);
			await Promise.all(stale.map(tid => topics.deleteTopicField(tid, TOPIC_FIELD)));
		}, { batch: 500 });
		await db.delete(key);
	}
	const folder = path.join(nconf.get('upload_path'), UPLOAD_FOLDER);
	await Promise.all(changes.files.map(async (name) => {
		const target = fileInFolder(folder, name);
		if (!target) return;
		try {
			await fs.promises.unlink(target);
		} catch (err) {
			if (err.code !== 'ENOENT') winston.warn(`[topic-icons] Cannot delete ${name}: ${err.message}`);
		}
	}));
}

/**
 * Drops the caches when this plugin's settings are saved in this process (other processes are
 * notified through pubsub, see plugin.init) and runs the clean-up planned in onSettingsSave.
 *
 * Hook: action:settings.set
 *
 * @param {{plugin: string}} data
 * @returns {Promise<void>}
 */
plugin.onSettingsSet = async function ({ plugin: hash }) {
	if (hash !== SETTINGS_KEY) return;
	store.invalidate();
	const changes = pendingCleanup;
	pendingCleanup = null;
	if (changes && (changes.ids.length || changes.files.length)) {
		try {
			await cleanUp(changes);
		} catch (err) {
			winston.error(`[topic-icons] Clean-up after saving the library failed: ${err.stack || err.message}`);
		}
	}
};

/**
 * Adds "Topic icons" to the ACP Plugins menu.
 *
 * Hook: filter:admin.header.build
 *
 * @param {{plugins: Array<object>}} header
 * @returns {Promise<object>}
 */
plugin.addAdminNavigation = async function (header) {
	header.plugins.push({ route: '/plugins/topic-icons', icon: 'fa-icons', name: `[[${icons.ACP_NAMESPACE}:title]]` });
	return header;
};

/**
 * New topic: checks the picked icon for the author and the category, after the author's right
 * to post there (so that the answer does not tell which icons a hidden category has). An empty
 * value means "no icon".
 *
 * A queued topic being approved comes back here with `fromQueue`: its icon was checked when it
 * was queued (onQueueSave); if it is no longer valid, the topic is posted without it rather than
 * blocking the approval.
 *
 * Hook: filter:topic.post
 *
 * @param {object} data topic payload (uid, cid, title, content, iconId, …)
 * @returns {Promise<object>} the same payload
 */
plugin.onTopicPost = async function (data) {
	if (!hasChoice(data)) return data;
	const config = await store.get();
	if (data.fromQueue) {
		const { id, dropped } = await rules.settleQueued(config, data, access);
		if (dropped) winston.warn(`[topic-icons] Queued topic by uid ${data.uid}: icon "${String(data[TOPIC_FIELD]).slice(0, 40)}" dropped (${dropped})`);
		if (id) validated.set(data, id);
		else delete data[TOPIC_FIELD];
		return data;
	}
	if (data[TOPIC_FIELD] === '') {
		delete data[TOPIC_FIELD];
		return data;
	}
	if (!(await privileges.categories.can('topics:create', data.cid, data.uid))) throw new Error('[[error:no-privileges]]');
	const id = await rules.checkNewTopic(config, data, access);
	if (id) validated.set(data, id);
	else delete data[TOPIC_FIELD];
	return data;
};

/**
 * A topic about to be put in the post queue: its icon gets the same checks as on posting, so the
 * author learns about a refused icon now and not the moderator on approval.
 *
 * Hook: filter:post-queue.save
 *
 * @param {{type: string, data: object}} payload
 * @returns {Promise<object>}
 */
plugin.onQueueSave = async function (payload) {
	const data = payload && payload.data;
	if (!payload || payload.type !== 'topic' || !hasChoice(data)) return payload;
	const id = await rules.checkNewTopic(await store.get(), data, access);
	if (id) data[TOPIC_FIELD] = id;
	else delete data[TOPIC_FIELD];
	return payload;
};

/**
 * Stores the validated icon in the new topic object. A payload that reached Topics.create
 * without filter:topic.post (another plugin calling it directly) is validated here.
 *
 * Hook: filter:topic.create
 *
 * @param {{topic: object, data: object}} hookData
 * @returns {Promise<object>}
 */
plugin.onTopicCreate = async function (hookData) {
	const { topic, data } = hookData;
	if (!hasChoice(data) || data[TOPIC_FIELD] === '') return hookData;
	let id = validated.get(data);
	if (!id) id = await rules.checkNewTopic(await store.get(), data, access);
	if (id) topic[TOPIC_FIELD] = id;
	return hookData;
};

/**
 * Adds a new topic with an icon to the index of its icon.
 *
 * Hook: action:topic.save
 *
 * @param {{topic: object}} hookData
 * @returns {Promise<void>}
 */
plugin.onTopicSave = async function ({ topic }) {
	const id = topic && icons.cleanId(topic[TOPIC_FIELD]);
	if (id) await db.sortedSetAdd(indexKey(id), topic.timestamp || Date.now(), topic.tid);
};

/**
 * Edit of a post: when it is the first post of a topic and the payload carries an icon, applies
 * the rules of lib/rules.js planEdit (the current icon sent again is no change; otherwise only the
 * topic author or a moderator, and the value must pass the same checks as on posting). Runs
 * before anything is written, so a refused icon leaves the post unchanged. Replies ignore the
 * field.
 *
 * Hook: filter:post.edit
 *
 * @param {{post: object, data: object, uid: number}} hookData
 * @returns {Promise<object>}
 */
plugin.onPostEdit = async function (hookData) {
	const { data } = hookData;
	if (!hasChoice(data)) return hookData;
	const tid = await posts.getPostField(data.pid, 'tid');
	const topic = await topics.getTopicFields(tid, ['cid', 'uid', 'mainPid', TOPIC_FIELD]);
	if (!topic || String(topic.mainPid) !== String(data.pid)) return hookData;
	const plan = await rules.planEdit({
		config: await store.get(),
		topic: { cid: topic.cid, uid: topic.uid, iconId: topic[TOPIC_FIELD] },
		uid: hookData.uid,
		value: data[TOPIC_FIELD],
		access,
	});
	if (plan.change) validated.set(data, { tid, id: plan.id, previous: icons.cleanId(topic[TOPIC_FIELD]) });
	return hookData;
};

/**
 * Writes the icon checked in onPostEdit into the topic ('' removes it; the category default is
 * then shown) and moves the topic between icon indexes.
 *
 * Hook: filter:topic.edit
 *
 * @param {{topic: object, data: object}} hookData
 * @returns {Promise<object>}
 */
plugin.onTopicEdit = async function (hookData) {
	const change = hookData && validated.get(hookData.data);
	if (!change) return hookData;
	hookData.topic[TOPIC_FIELD] = change.id;
	if (change.previous) await db.sortedSetRemove(indexKey(change.previous), change.tid);
	if (change.id) await db.sortedSetAdd(indexKey(change.id), Date.now(), change.tid);
	return hookData;
};

/**
 * A topic moved to a category where its icon is not available loses the icon; the default of
 * the new category is shown instead (lib/rules.js clearOnMove).
 *
 * Hook: action:topic.move
 *
 * @param {{tid: number, toCid: number}} data
 * @returns {Promise<void>}
 */
plugin.onTopicMove = async function (data) {
	if (!data || !data.tid) return;
	const iconId = await topics.getTopicField(data.tid, TOPIC_FIELD);
	if (!rules.clearOnMove(await store.get(), iconId, data.toCid)) return;
	await topics.deleteTopicField(data.tid, TOPIC_FIELD);
	const id = icons.cleanId(iconId);
	if (id) await db.sortedSetRemove(indexKey(id), data.tid);
};

/**
 * Removes purged topics from the icon indexes.
 *
 * Hook: action:topics.purge
 *
 * @param {{topics: Array<object>}} data
 * @returns {Promise<void>}
 */
plugin.onTopicsPurge = async function (data) {
	const list = (data && Array.isArray(data.topics) ? data.topics : []).filter(t => t && icons.cleanId(t[TOPIC_FIELD]));
	await Promise.all(list.map(t => db.sortedSetRemove(indexKey(icons.cleanId(t[TOPIC_FIELD])), t.tid)));
};

/**
 * Lists of topics (category, recent, unread, popular, tags, user profile and their API routes;
 * not search results, which are posts): attaches `topicIcon` { id, name, url, isDefault, html }
 * and gives topics without thumbnails their cover (addCovers).
 * The icon id is part of the topic object NodeBB has just loaded, so this costs no topic query;
 * the viewer's language comes from a short-lived cache (getLang).
 *
 * Hook: filter:topics.get
 *
 * @param {{topics: Array<object>, uid: number}} hookData
 * @returns {Promise<object>}
 */
plugin.onTopicsGet = async function (hookData) {
	const list = hookData && hookData.topics;
	if (!Array.isArray(list) || !list.length) return hookData;
	const config = await store.get();
	await addCovers(config, list, hookData.uid);
	if (!config.showInList || !config.icons.length) return hookData;
	const lang = await getLang(hookData.uid);
	await Promise.all(list.map(async (t) => {
		if (t && t.cid) t.topicIcon = await renderTopicIcon(config, t[TOPIC_FIELD], t.cid, lang);
	}));
	return hookData;
};

/**
 * Topic page: attaches `topicIcon` to the topic data (public/client.js puts it in the header) and
 * gives a topic without thumbnails its cover (shown with NodeBB's thumbnail viewer).
 *
 * Hook: filter:topic.get
 *
 * @param {{topic: object, uid: number}} hookData
 * @returns {Promise<object>}
 */
plugin.onTopicGet = async function (hookData) {
	const t = hookData && hookData.topic;
	if (!t || !t.cid) return hookData;
	const config = await store.get();
	await addCovers(config, [t], hookData.uid);
	if (!config.showInTopic || !config.icons.length) return hookData;
	t.topicIcon = await renderTopicIcon(config, t[TOPIC_FIELD], t.cid, await getLang(hookData.uid));
	return hookData;
};

/**
 * Last pass before render or JSON, on full page loads and on the /api routes used by ajaxify:
 * icons in the language of the request (?lang=, browser language of guests, user setting), and
 * the body classes that switch on the cover styles (scss/topic-icons.scss).
 *
 * Hook: filter:middleware.render (priority 20)
 *
 * @param {{req: object, res: object, templateData: object}} hookData
 * @returns {Promise<object>}
 */
plugin.onRender = async function (hookData) {
	const { req, res, templateData } = hookData;
	if (!templateData) return hookData;
	const coverClasses = covers.bodyClasses((await store.get()).covers);
	if (coverClasses.length && typeof templateData.bodyClass === 'string') {
		templateData.bodyClass = `${templateData.bodyClass} ${coverClasses.join(' ')}`.trim();
	}
	const list = Array.isArray(templateData.topics) ? templateData.topics.filter(t => t && t.topicIcon) : [];
	if (!list.length && !templateData.topicIcon) return hookData;
	const lang = await viewerLang(req, res);
	const config = await store.get();
	await Promise.all(list.map(t => relocalize(config, t, lang)));
	await relocalize(config, templateData, lang);
	return hookData;
};
