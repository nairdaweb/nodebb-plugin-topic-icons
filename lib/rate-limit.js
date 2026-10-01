'use strict';

/*
 * Shared settings of the request limits on the plugin's routes. The limiters themselves are
 * created with express-rate-limit (its memory store) where the routes are defined. Each NodeBB
 * process counts on its own, so with several processes the effective limit is a multiple of the
 * configured one.
 *
 * A client is the logged-in user (uid) or, for guests, the IP address as Express reports it
 * (NodeBB's "trust_proxy" setting decides whether X-Forwarded-For is used). IPv6 addresses are
 * grouped by /56 subnet (ipKeyGenerator), so a guest cannot dodge the limit by changing the
 * address inside one allocation.
 */

const { ipKeyGenerator } = require('express-rate-limit');

/** Length of a limit window: one minute. */
const WINDOW_MS = 60 * 1000;

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
	return `ip:${ip ? ipKeyGenerator(String(ip)) : 'unknown'}`;
}

/**
 * Answer of a page limiter once the limit is reached: JSON for /api/ paths, plain text otherwise.
 * The status (429) and the Retry-After header are set by express-rate-limit.
 *
 * @param {object} req
 * @param {object} res
 * @returns {void}
 */
function onPageLimit(req, res) {
	const url = String((req && (req.originalUrl || req.url)) || '');
	res.status(429);
	if (url.includes('/api/')) {
		res.json({ error: '[[error:api.429]]' });
	} else {
		res.type('text/plain').send('Too many requests, please try again later.');
	}
}

/** Options shared by every limiter: window, client key and standard RateLimit headers. */
const BASE_OPTIONS = Object.freeze({
	windowMs: WINDOW_MS,
	keyGenerator: clientKey,
	standardHeaders: 'draft-8',
	legacyHeaders: false,
});

module.exports = { WINDOW_MS, BASE_OPTIONS, clientKey, onPageLimit };
