'use strict';

/*
 * nodebb-plugin-topic-icons: server entry point (declared as "library" in plugin.json).
 *
 * Wires the pure modules in lib/ (icon library, upload checks, language choice, LRU cache) into
 * NodeBB 4.x hooks:
 * - the icon library and its settings live in the plugin settings hash (meta.settings), so the
 *   plugin needs no tables of its own and works with Redis, MongoDB and PostgreSQL;
 * - the icon picked for a topic is one field of the topic object: topic:<tid> → iconId;
 * - the choice is validated on the server when a topic is posted (also from the post queue) and
 *   when its first post is edited: the icon must exist, be active, be offered in the category,
 *   and the user must be allowed to choose (only the author or a moderator may change it);
 * - lists of topics get `topicIcon` from fields NodeBB has already loaded (no extra query), the
 *   topic page gets it too; everything is rendered in the viewer's language (see "Language").
 *
 * Every exported method below is referenced by name from plugin.json.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
const file = require.main.require('./src/file');
const middleware = require.main.require('./src/middleware');
const uploadMiddleware = require.main.require('./src/middleware/multer');
const routeHelpers = require.main.require('./src/routes/helpers');
const controllerHelpers = require.main.require('./src/controllers/helpers');

const icons = require('./lib/icons');
const upload = require('./lib/upload');
const LRU = require('./lib/lru');
const { pickLang, isLangCode } = require('./lib/lang');

/** Hash under which meta.settings stores the plugin configuration (also used by public/admin.js). */
const SETTINGS_KEY = 'topic-icons';
/** Sub-folder of NodeBB's upload_path for icons uploaded from the ACP. */
const UPLOAD_FOLDER = 'topic-icons';
/** Topic field that holds the picked icon id. */
const TOPIC_FIELD = 'iconId';
/** Name of the field in the composer / API payload (topics.post and posts.edit). */
const PAYLOAD_FIELD = 'iconId';

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
 * Both call invalidate().
 */
let cached = null;
/*
 * Bumped by invalidate(). Caches are written only when the generation is still the one seen
 * before the first await, so a request that started with the old settings cannot store a
 * result built from them after a save. Rendered icons also carry the generation in their key.
 */
let generation = 0;

/**
 * @returns {Promise<object>} normalised config, see lib/icons.js
 */
async function getConfig() {
	if (cached) return cached;
	const started = generation;
	const config = icons.normalize(await meta.settings.get(SETTINGS_KEY));
	if (started === generation) cached = config;
	return config;
}

/*
 * Rendered icons (name and HTML) per (generation, language, icon, default flag). A forum has a
 * few dozen icons, so after warm-up a page of topics costs no translation work. LRU with a cap,
 * so many distinct ?lang= values evict only the least recently used entries.
 */
const htmlCache = new LRU(2000);

/**
 * Drops the cached config and everything rendered from it.
 *
 * @returns {void}
 */
function invalidate() {
	generation += 1;
	cached = null;
	htmlCache.clear();
}

// ---------------------------------------------------------------- language

/**
 * @param {*} uid
 * @returns {boolean} true for a positive integer uid (not guests, system or remote users)
 */
function isLocalUid(uid) {
	return /^\d+$/.test(String(uid)) && parseInt(uid, 10) > 0;
}

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
		const settings = await user.getSettings(uid);
		userLang = settings && settings.userLang;
	}
	return pickLang({ userLang, defaultLang: meta.config.defaultLang });
}

/**
 * Language of the viewer of a request: ?lang= (also set for guests from the browser language by
 * the core autoLocale middleware, on page, ajaxify and API routes) → the user's setting (from
 * res.locals.config on full page loads, from the database otherwise) → the forum default.
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
	return getLang(req && req.uid);
}

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
 * @param {object} config normalised config
 * @param {string} iconId value of the topic field
 * @param {number|string} cid category of the topic
 * @param {string} lang
 * @returns {Promise<{id: string, name: string, url: string, isDefault: boolean, html: string}|null>}
 */
async function renderTopicIcon(config, iconId, cid, lang) {
	const found = icons.effectiveIcon(config, iconId, cid);
	if (!found) return null;
	const started = generation;
	const key = `${started}|${lang}|${found.icon.id}|${found.isDefault ? 1 : 0}`;
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
		if (started === generation) htmlCache.set(key, rendered);
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
 * Icons for many topics at once, for other plugins and themes (e.g. a "recent topics" widget):
 * `require.main.require('nodebb-plugin-topic-icons').getTopicIcons(tids, { lang: 'pl' })`.
 * One database call for all topics (db.getObjectsFields). Not bound to a hook.
 *
 * @param {Array<number|string>} tids
 * @param {{lang?: string}} [opts]
 * @returns {Promise<Array<object|null>>} rendered icons aligned with `tids`
 */
plugin.getTopicIcons = async function (tids, opts) {
	opts = opts || {};
	if (!Array.isArray(tids) || !tids.length) return [];
	const config = await getConfig();
	const lang = pickLang({ query: opts.lang, defaultLang: meta.config.defaultLang });
	const data = await db.getObjectsFields(tids.map(tid => `topic:${tid}`), ['cid', TOPIC_FIELD]);
	return Promise.all(data.map(t => (t && t.cid ? renderTopicIcon(config, t[TOPIC_FIELD], t.cid, lang) : null)));
};

// ---------------------------------------------------------------- permissions

/**
 * Whether the user may pick an icon in a category, according to "Who can choose an icon".
 * Administrators and moderators of the category always may.
 *
 * @param {object} config normalised config
 * @param {number|string} uid
 * @param {number|string} cid
 * @returns {Promise<boolean>}
 */
async function canChoose(config, uid, cid) {
	if (config.chooser === 'all') return true;
	if (!isLocalUid(uid)) return false;
	if (await privileges.categories.isAdminOrMod(cid, uid)) return true;
	if (config.chooser === 'group' && config.chooserGroup) return groups.isMember(uid, config.chooserGroup);
	return false;
}

/**
 * Validates an icon picked by a user for a topic in a category. Throws an error with a
 * translation token that the composer shows as is.
 *
 * @param {object} config normalised config
 * @param {number|string} uid
 * @param {number|string} cid
 * @param {*} value icon id from the request
 * @returns {Promise<string>} the clean icon id
 */
async function checkChoice(config, uid, cid, value) {
	const icon = icons.findIcon(config, typeof value === 'string' ? value : '');
	if (!icon || !icon.active) throw new Error(`[[${icons.NAMESPACE}:error.unknown-icon]]`);
	if (!icons.isOffered(icon, cid)) throw new Error(`[[${icons.NAMESPACE}:error.not-in-category]]`);
	if (!(await canChoose(config, uid, cid))) throw new Error(`[[${icons.NAMESPACE}:error.no-privileges]]`);
	return icon.id;
}

/*
 * Icon ids validated in filter:topic.post / filter:post.edit, keyed by the payload object that
 * NodeBB passes on to filter:topic.create / filter:topic.edit. A WeakMap, so nothing leaks when
 * a request fails in between.
 */
const validated = new WeakMap();

/**
 * @param {object} data topics.post or posts.edit payload
 * @returns {boolean} whether the payload carries an icon choice ('' = remove the icon)
 */
function hasChoice(data) {
	return !!data && data[PAYLOAD_FIELD] !== undefined && data[PAYLOAD_FIELD] !== null;
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
	routeHelpers.setupAdminPageRoute(router, '/admin/plugins/topic-icons', [], async (req, res) => {
		const cids = await categories.getAllCidsFromSet('categories:cid');
		const cats = (await categories.getCategoriesFields(cids, ['cid', 'name', 'parentCid', 'disabled']))
			.filter(c => c && parseInt(c.cid, 10) > 0);
		const groupNames = (await groups.getNonPrivilegeGroups('groups:createtime', 0, -1, { ephemeral: false }))
			.map(g => g.name);
		res.render('admin/plugins/topic-icons', {
			title: `[[${icons.ACP_NAMESPACE}:title]]`,
			defaults: icons.defaults(),
			categoryList: cats.map(c => ({ cid: c.cid, name: c.name, disabled: !!c.disabled })),
			groupList: groupNames,
			maxUploadKb: Math.floor(upload.MAX_BYTES / 1024),
		});
	});

	// Icon upload. Administrators only (checked again in the handler), with the CSRF token of the
	// ACP session; type, content and size are checked by lib/upload.js, and the file is stored
	// under a new unique name.
	router.post(
		'/api/admin/plugins/topic-icons/upload',
		middleware.ensureLoggedIn,
		middleware.applyCSRF,
		uploadMiddleware.single('file'),
		routeHelpers.tryRoute(plugin._uploadIcon, (err, res) => res.status(400).json({ error: err.message }))
	);

	try {
		await fs.promises.mkdir(path.join(nconf.get('upload_path'), UPLOAD_FOLDER), { recursive: true });
	} catch (err) {
		winston.warn(`[topic-icons] Cannot create upload folder: ${err.message}`);
	}

	pubsub.on(`action:settings.set.${SETTINGS_KEY}`, invalidate);
};

/**
 * Handler of POST /api/admin/plugins/topic-icons/upload (multipart, field "file").
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>} responds with { url } or { error } (a translation token)
 */
plugin._uploadIcon = async function (req, res) {
	const fail = (status, key) => {
		const arg = key === 'upload-size' ? `, ${Math.floor(upload.MAX_BYTES / 1024)}` : '';
		res.status(status).json({ error: `[[${icons.ACP_NAMESPACE}:${key}${arg}]]` });
	};
	if (!(await user.isAdministrator(req.uid))) return fail(403, 'upload-forbidden');
	const f = req.file;
	if (!f || !f.path) return fail(400, 'upload-missing');
	if (f.size > upload.MAX_BYTES) return fail(400, 'upload-size');
	const content = await fs.promises.readFile(f.path);
	const result = upload.checkUpload(f, content);
	if (result.error) return fail(400, result.error);
	if (result.ext === 'svg' && !upload.isSafeSvg(content.toString('utf8'))) return fail(400, 'upload-svg-unsafe');
	const name = upload.uniqueName(result.ext, crypto.randomBytes(8).toString('hex'));
	const stored = await file.saveFileToLocal(name, UPLOAD_FOLDER, f.path);
	res.json({ url: stored.url });
};

/**
 * What the composer's picker needs, at
 * GET /api/v3/plugins/topic-icons/choices?cid=<cid> (new topic) or ?tid=<tid> (editing the first
 * post). Icons offered in the category, the category default and, when editing, the current
 * icon; `canChoose` is false when the viewer may not pick (the picker is then not shown).
 * Names are plain text in the viewer's language; URLs include relative_path.
 *
 * Hook: static:api.routes
 *
 * @param {{router: import('express').Router}} params
 * @returns {Promise<void>}
 */
plugin.addApiRoutes = async function ({ router }) {
	routeHelpers.setupApiRoute(router, 'get', '/topic-icons/choices', [], async (req, res) => {
		const config = await getConfig();
		const lang = await viewerLang(req);
		const uid = req.uid;
		let cid = icons.cleanCid(req.query.cid);
		let current = '';
		let allowed;

		const tid = icons.cleanCid(req.query.tid);
		if (tid) {
			const topic = await topics.getTopicFields(tid, ['cid', 'uid', TOPIC_FIELD]);
			if (!topic || !topic.cid || !(await privileges.topics.can('topics:read', tid, uid))) {
				return controllerHelpers.formatApiResponse(404, res);
			}
			cid = topic.cid;
			current = icons.cleanId(topic[TOPIC_FIELD]);
			allowed = isLocalUid(uid) && (String(topic.uid) === String(uid) || await privileges.categories.isAdminOrMod(cid, uid));
		} else {
			if (!cid) return controllerHelpers.formatApiResponse(400, res);
			allowed = await privileges.categories.can('topics:create', cid, uid);
		}
		allowed = allowed && await canChoose(config, uid, cid);

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
			// Shown in the picker when editing a topic whose icon is no longer offered.
			currentIcon: currentIcon && !list.includes(currentIcon) ? await describe(currentIcon) : null,
			defaultIcon: fallback ? await describe(fallback) : null,
		});
	});
};

/**
 * Validates the plugin settings before they are stored; a bad library is refused with an error
 * shown in the ACP instead of being saved. The ACP runs the same checks before sending.
 *
 * Hook: filter:settings.set
 *
 * @param {{plugin: string, settings: object}} data
 * @returns {Promise<object>} the same data, with cleaned settings
 */
plugin.onSettingsSave = async function (data) {
	if (!data || data.plugin !== SETTINGS_KEY) return data;
	const { errors, settings } = icons.validateSettings(data.settings);
	if (errors.length) throw new Error(errors[0]);
	data.settings = settings;
	return data;
};

/**
 * Drops the caches when this plugin's settings are saved in this process (other processes are
 * notified through pubsub, see plugin.init).
 *
 * Hook: action:settings.set
 *
 * @param {{plugin: string}} data
 * @returns {Promise<void>}
 */
plugin.onSettingsSet = async function ({ plugin: hash }) {
	if (hash === SETTINGS_KEY) invalidate();
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
 * New topic (also a queued topic being approved, which comes back here with fromQueue): checks
 * the picked icon for the author and the category. An empty value means "no icon".
 *
 * Hook: filter:topic.post
 *
 * @param {object} data topic payload (uid, cid, title, content, iconId, …)
 * @returns {Promise<object>} the same payload
 */
plugin.onTopicPost = async function (data) {
	if (!hasChoice(data)) return data;
	if (data[PAYLOAD_FIELD] === '') {
		delete data[PAYLOAD_FIELD];
		return data;
	}
	const config = await getConfig();
	validated.set(data, await checkChoice(config, data.uid, data.cid, data[PAYLOAD_FIELD]));
	return data;
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
	if (!hasChoice(data) || data[PAYLOAD_FIELD] === '') return hookData;
	let id = validated.get(data);
	if (!id) id = await checkChoice(await getConfig(), data.uid, data.cid, data[PAYLOAD_FIELD]);
	topic[TOPIC_FIELD] = id;
	return hookData;
};

/**
 * Edit of a post: when it is the first post of a topic and the payload carries an icon, only
 * the topic author or a moderator of the category may change it, and a new icon must pass the
 * same checks as on posting. Runs before anything is written, so a refused icon leaves the
 * post unchanged. Replies ignore the field.
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
	const topic = await topics.getTopicFields(tid, ['cid', 'uid', 'mainPid']);
	if (!topic || String(topic.mainPid) !== String(data.pid)) return hookData;
	const uid = hookData.uid;
	const isOwner = isLocalUid(uid) && String(topic.uid) === String(uid);
	if (!isOwner && !(await privileges.categories.isAdminOrMod(topic.cid, uid))) {
		throw new Error(`[[${icons.NAMESPACE}:error.no-privileges]]`);
	}
	const value = data[PAYLOAD_FIELD] === '' ? '' : await checkChoice(await getConfig(), uid, topic.cid, data[PAYLOAD_FIELD]);
	validated.set(data, value);
	return hookData;
};

/**
 * Writes the icon checked in onPostEdit into the topic ('' removes it; the category default is
 * then shown).
 *
 * Hook: filter:topic.edit
 *
 * @param {{topic: object, data: object}} hookData
 * @returns {Promise<object>}
 */
plugin.onTopicEdit = async function (hookData) {
	if (hookData && validated.has(hookData.data)) hookData.topic[TOPIC_FIELD] = validated.get(hookData.data);
	return hookData;
};

/**
 * Lists of topics (category, recent, unread, popular, tags, search and their API routes):
 * attaches `topicIcon` { id, name, url, isDefault, html }. The icon id is part of the topic
 * object NodeBB has just loaded, so this costs no database call.
 *
 * Hook: filter:topics.get
 *
 * @param {{topics: Array<object>, uid: number}} hookData
 * @returns {Promise<object>}
 */
plugin.onTopicsGet = async function (hookData) {
	const list = hookData && hookData.topics;
	if (!Array.isArray(list) || !list.length) return hookData;
	const config = await getConfig();
	if (!config.showInList || !config.icons.length) return hookData;
	const lang = await getLang(hookData.uid);
	await Promise.all(list.map(async (t) => {
		if (t && t.cid) t.topicIcon = await renderTopicIcon(config, t[TOPIC_FIELD], t.cid, lang);
	}));
	return hookData;
};

/**
 * Topic page: attaches `topicIcon` to the topic data (public/client.js puts it in the header).
 *
 * Hook: filter:topic.get
 *
 * @param {{topic: object, uid: number}} hookData
 * @returns {Promise<object>}
 */
plugin.onTopicGet = async function (hookData) {
	const t = hookData && hookData.topic;
	if (!t || !t.cid) return hookData;
	const config = await getConfig();
	if (!config.showInTopic || !config.icons.length) return hookData;
	t.topicIcon = await renderTopicIcon(config, t[TOPIC_FIELD], t.cid, await getLang(hookData.uid));
	return hookData;
};

/**
 * Last pass before render or JSON, on full page loads and on the /api routes used by ajaxify:
 * icons in the language of the request (?lang=, browser language of guests, user setting).
 *
 * Hook: filter:middleware.render (priority 20)
 *
 * @param {{req: object, res: object, templateData: object}} hookData
 * @returns {Promise<object>}
 */
plugin.onRender = async function (hookData) {
	const { req, res, templateData } = hookData;
	if (!templateData) return hookData;
	const list = Array.isArray(templateData.topics) ? templateData.topics.filter(t => t && t.topicIcon) : [];
	if (!list.length && !templateData.topicIcon) return hookData;
	const lang = await viewerLang(req, res);
	const config = await getConfig();
	await Promise.all(list.map(t => relocalize(config, t, lang)));
	await relocalize(config, templateData, lang);
	return hookData;
};

/** Internal functions exposed for tests only; not a public API. */
plugin._test = { getConfig, invalidate, viewerLang, canChoose, checkChoice };
