'use strict';

/*
 * Small in-memory request limiter (fixed window per client), used as Express middleware in front
 * of the plugin's routes. No dependencies and no I/O, so it can be unit-tested without NodeBB.
 *
 * A client is the logged-in user (uid) or, for guests, the IP address as Express reports it
 * (NodeBB's "trust_proxy" setting decides whether X-Forwarded-For is used). Each NodeBB process
 * counts on its own, so with several processes the effective limit is a multiple of `max`.
 *
 * Memory stays bounded: expired windows are swept at most once per window, and when `maxKeys`
 * clients are being tracked the oldest one is dropped before a new one is added.
 */

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX = 60;
const DEFAULT_MAX_KEYS = 10000;

/**
 * @param {*} value
 * @param {number} fallback
 * @returns {number} a positive integer
 */
function positive(value, fallback) {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Key of the client making a request: "uid:<uid>" for logged-in users, "ip:<address>" otherwise.
 *
 * @param {object} req Express request
 * @returns {string}
 */
function clientKey(req) {
	const uid = parseInt(req && req.uid, 10);
	if (uid > 0) return `uid:${uid}`;
	const ip = req && (req.ip || (req.socket && req.socket.remoteAddress));
	return `ip:${ip ? String(ip) : 'unknown'}`;
}

/**
 * Default answer once the limit is reached: 429, JSON for API paths, plain text for pages.
 *
 * @param {object} req
 * @param {object} res
 * @returns {void}
 */
function defaultOnLimit(req, res) {
	const url = String((req && (req.originalUrl || req.url)) || '');
	res.status(429);
	if (url.includes('/api/')) {
		res.json({ error: '[[error:api.429]]' });
	} else {
		res.type('text/plain').send('Too many requests, please try again later.');
	}
}

/**
 * Creates a limiter.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs=60000] length of a window
 * @param {number} [opts.max=60] requests allowed per client and window
 * @param {number} [opts.maxKeys=10000] clients tracked at most
 * @param {function(object): string} [opts.key] client key of a request (default: clientKey)
 * @param {function(object, object, object): void} [opts.onLimit] answer for refused requests
 *   (req, res, result); the Retry-After header is already set
 * @param {function(): number} [opts.now] clock, for tests
 * @returns {function(object, object, function): void} Express middleware, with `hit(key)`,
 *   `size()` and `clear()` attached
 */
function createLimiter(opts) {
	opts = opts || {};
	const windowMs = positive(opts.windowMs, DEFAULT_WINDOW_MS);
	const max = positive(opts.max, DEFAULT_MAX);
	const maxKeys = positive(opts.maxKeys, DEFAULT_MAX_KEYS);
	const keyOf = typeof opts.key === 'function' ? opts.key : clientKey;
	const onLimit = typeof opts.onLimit === 'function' ? opts.onLimit : defaultOnLimit;
	const now = typeof opts.now === 'function' ? opts.now : Date.now;
	/** key → { count, reset }; insertion order = age, so the first key is the oldest. */
	const hits = new Map();
	let nextSweep = 0;

	function sweep(t) {
		for (const [key, entry] of hits) {
			if (entry.reset <= t) hits.delete(key);
		}
		nextSweep = t + windowMs;
	}

	/**
	 * Counts one request of a client.
	 *
	 * @param {string} key
	 * @returns {{allowed: boolean, remaining: number, retryAfter: number}} retryAfter in seconds
	 */
	function hit(key) {
		const t = now();
		if (t >= nextSweep) sweep(t);
		let entry = hits.get(key);
		if (!entry || entry.reset <= t) {
			hits.delete(key);
			if (hits.size >= maxKeys) sweep(t);
			while (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
			entry = { count: 0, reset: t + windowMs };
			hits.set(key, entry);
		}
		if (entry.count <= max) entry.count += 1;
		return {
			allowed: entry.count <= max,
			remaining: Math.max(0, max - entry.count),
			retryAfter: Math.max(1, Math.ceil((entry.reset - t) / 1000)),
		};
	}

	function middleware(req, res, next) {
		const result = hit(String(keyOf(req)));
		if (result.allowed) return next();
		res.set('Retry-After', String(result.retryAfter));
		onLimit(req, res, result);
	}

	middleware.hit = hit;
	middleware.size = () => hits.size;
	middleware.clear = () => hits.clear();
	return middleware;
}

module.exports = { createLimiter, clientKey, DEFAULT_WINDOW_MS, DEFAULT_MAX, DEFAULT_MAX_KEYS };
