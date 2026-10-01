'use strict';

/*
 * Update notices from updates.wirelab.pl. The same file is copied into every wirelab plugin;
 * keep the copies identical. No dependencies (Node 18+ fetch).
 *
 * At most once a day the forum fetches https://updates.wirelab.pl/api/<plugin id>.json with a
 * plain GET: no query string, no cookies, no data about the forum, User-Agent "<plugin>/<version>".
 * The answer is cached (memory and database), so opening the ACP page uses the cache and only
 * fetches when the cache is older than a day (an hour after a failed attempt). When the
 * "Check for updates" setting is off, nothing is fetched at all. Network errors are logged at
 * debug level only.
 *
 * Testing against a local catalogue: with NODE_ENV=development (NodeBB dev mode) the base URL
 * can be replaced by WIRELAB_UPDATES_URL, e.g. http://127.0.0.1:8000/api/. Ignored in production.
 */

const DEFAULT_BASE = 'https://updates.wirelab.pl/api/';
const DAY = 24 * 60 * 60 * 1000;
const RETRY_AFTER_ERROR = 60 * 60 * 1000;
const TIMER_INTERVAL = 60 * 60 * 1000;
const FIRST_CHECK_DELAY = 2 * 60 * 1000;
const TIMEOUT = 5000;
const MAX_BYTES = 64 * 1024;

const SEMVER = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseVersion(value) {
	const m = SEMVER.exec(String(value == null ? '' : value).trim());
	if (!m) {
		return null;
	}
	return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** -1, 0 or 1 like a sort comparator (semver precedence); null when either is not a version. */
function compareVersions(a, b) {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) {
		return null;
	}
	for (let i = 0; i < 3; i += 1) {
		if (x.nums[i] !== y.nums[i]) {
			return x.nums[i] < y.nums[i] ? -1 : 1;
		}
	}
	if (!x.pre.length || !y.pre.length) {
		return x.pre.length === y.pre.length ? 0 : (x.pre.length ? -1 : 1);
	}
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined || q === undefined) {
			return p === undefined ? -1 : 1;
		}
		if (p === q) {
			continue;
		}
		const pn = /^\d+$/.test(p);
		const qn = /^\d+$/.test(q);
		if (pn && qn) {
			return Number(p) < Number(q) ? -1 : 1;
		}
		if (pn !== qn) {
			return pn ? -1 : 1;
		}
		return p < q ? -1 : 1;
	}
	return 0;
}

function isNewer(latest, current) {
	return compareVersions(latest, current) === 1;
}

/** Base URL of the catalogue; the environment override works only in development mode. */
function baseUrl(env) {
	env = env || process.env;
	const custom = env.WIRELAB_UPDATES_URL;
	if (env.NODE_ENV === 'development' && custom && /^https?:\/\/[^\s?#]+$/.test(custom)) {
		return custom.endsWith('/') ? custom : `${custom}/`;
	}
	return DEFAULT_BASE;
}

/** Keeps only what the notice needs from the catalogue entry; null when it is not usable. */
function readEntry(doc, id) {
	if (!doc || typeof doc !== 'object' || doc.id !== id || !parseVersion(doc.version)) {
		return null;
	}
	const notesUrl = typeof doc.notes_url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(doc.notes_url) && doc.notes_url.length <= 500 ?
		doc.notes_url : null;
	return {
		version: String(doc.version).trim().replace(/^v/, ''),
		date: typeof doc.date === 'string' && DATE.test(doc.date) ? doc.date : null,
		notesUrl,
	};
}

/**
 * @param {object} opts
 * @param {string} opts.id plugin id, also the catalogue file name
 * @param {string} opts.version installed version (package.json)
 * @param {boolean} [opts.isPrivate] private plugins get "update with the deployment script" instead of a link
 * @param {Function} opts.isEnabled async () => boolean, asked before every fetch
 * @param {{get: Function, set: Function}} [opts.store] async persistent cache (one object)
 * @param {Function} [opts.fetch] fetch implementation (tests)
 * @param {Function} [opts.now] clock (tests)
 * @param {Function} [opts.log] debug logger
 * @param {object} [opts.env] environment (tests)
 */
function createChecker(opts) {
	const { id, version } = opts;
	const fetchImpl = opts.fetch || globalThis.fetch;
	const now = opts.now || Date.now;
	const log = opts.log || (() => {});
	const store = opts.store || { get: async () => null, set: async () => {} };
	const isEnabled = opts.isEnabled || (async () => true);
	let cache = null;
	let inflight = null;
	let timer = null;
	let firstTimer = null;

	async function download() {
		const url = baseUrl(opts.env) + encodeURIComponent(id) + '.json';
		const res = await fetchImpl(url, {
			method: 'GET',
			headers: { 'User-Agent': `${id}/${version}`, Accept: 'application/json' },
			credentials: 'omit',
			redirect: 'follow',
			signal: AbortSignal.timeout(TIMEOUT),
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
		const length = Number(res.headers && res.headers.get && res.headers.get('content-length'));
		if (length > MAX_BYTES) {
			throw new Error('response too large');
		}
		const text = await res.text();
		if (text.length > MAX_BYTES) {
			throw new Error('response too large');
		}
		const entry = readEntry(JSON.parse(text), id);
		if (!entry) {
			throw new Error('unexpected catalogue entry');
		}
		return entry;
	}

	async function refresh(previous) {
		let next;
		try {
			next = { checkedAt: now(), ok: true, latest: await download() };
		} catch (err) {
			log(`[${id}] update check failed: ${err && err.message}`);
			next = { checkedAt: now(), ok: false, latest: previous ? previous.latest : null };
		}
		cache = next;
		try {
			await store.set(next);
		} catch (err) {
			log(`[${id}] update check cache: ${err && err.message}`);
		}
		return next;
	}

	async function loadCache() {
		if (cache) {
			return cache;
		}
		try {
			const saved = await store.get();
			if (saved && Number.isFinite(saved.checkedAt)) {
				cache = { checkedAt: saved.checkedAt, ok: !!saved.ok, latest: saved.latest ? readEntry({ ...saved.latest, id, notes_url: saved.latest.notesUrl }, id) : null };
			}
		} catch (err) {
			log(`[${id}] update check cache: ${err && err.message}`);
		}
		return cache;
	}

	function isFresh(entry) {
		if (!entry) {
			return false;
		}
		const age = now() - entry.checkedAt;
		return age >= 0 && age < (entry.ok ? DAY : RETRY_AFTER_ERROR);
	}

	/** Cached result, fetching first when the cache is stale; null when checks are off. */
	async function check() {
		if (!(await isEnabled())) {
			return null;
		}
		let entry = cache;
		if (!isFresh(entry)) {
			// another NodeBB process may have refreshed the shared cache meanwhile
			cache = null;
			entry = await loadCache();
		}
		if (isFresh(entry)) {
			return entry;
		}
		if (!inflight) {
			inflight = refresh(entry).finally(() => {
				inflight = null;
			});
		}
		return inflight;
	}

	/** {version, date, notesUrl, isPrivate} when a newer version is available, otherwise null. */
	async function notice() {
		const entry = await check();
		if (!entry || !entry.latest || !isNewer(entry.latest.version, version)) {
			return null;
		}
		return {
			version: entry.latest.version,
			date: entry.latest.date,
			notesUrl: opts.isPrivate ? null : entry.latest.notesUrl,
			isPrivate: !!opts.isPrivate,
		};
	}

	function tick() {
		check().catch(err => log(`[${id}] update check: ${err && err.message}`));
	}

	/** Background checks: hourly ticks that fetch only when the cache is a day old. */
	function start() {
		if (timer) {
			return;
		}
		firstTimer = setTimeout(tick, FIRST_CHECK_DELAY);
		timer = setInterval(tick, TIMER_INTERVAL);
		[firstTimer, timer].forEach(t => t && t.unref && t.unref());
	}

	function stop() {
		clearTimeout(firstTimer);
		clearInterval(timer);
		firstTimer = null;
		timer = null;
	}

	return { check, notice, start, stop };
}

function isOn(value) {
	return !(value === false || value === 0 || ['off', 'false', '0'].includes(String(value).toLowerCase()));
}

/**
 * NodeBB wiring: setting "checkUpdates" in the meta.settings hash `settingsHash` (on unless saved
 * as off), cache in the database object `<id>:update-check`, debug log through winston.
 */
function forNodeBB({ id, version, isPrivate, settingsHash }) {
	const db = require.main.require('./src/database');
	const meta = require.main.require('./src/meta');
	const nconf = require.main.require('nconf');
	const winston = require.main.require('winston');
	const key = `${id}:update-check`;
	const checker = createChecker({
		id,
		version,
		isPrivate,
		isEnabled: async () => {
			const value = await meta.settings.getOne(settingsHash, 'checkUpdates');
			return value === undefined || value === null || value === '' ? true : isOn(value);
		},
		store: {
			get: async () => {
				const raw = await db.getObjectField(key, 'data');
				return raw ? JSON.parse(raw) : null;
			},
			set: async value => db.setObjectField(key, 'data', JSON.stringify(value)),
		},
		log: msg => winston.verbose(msg),
	});
	return {
		...checker,
		settingsHash,
		start() {
			if (nconf.get('isPrimary')) {
				checker.start();
			}
		},
		/** Template data for the ACP page; never throws. */
		async templateData() {
			let n = null;
			try {
				n = await checker.notice();
			} catch (err) {
				winston.verbose(`[${id}] update check: ${err && err.message}`);
			}
			return {
				updateAvailable: !!n,
				updateVersion: n ? n.version : '',
				updateNotesUrl: n && n.notesUrl ? n.notesUrl : '',
				updateIsPrivate: !!(n && n.isPrivate),
				updateSettingsHash: settingsHash,
			};
		},
	};
}

module.exports = {
	DEFAULT_BASE,
	DAY,
	RETRY_AFTER_ERROR,
	parseVersion,
	compareVersions,
	isNewer,
	baseUrl,
	readEntry,
	createChecker,
	isOn,
	forNodeBB,
};
