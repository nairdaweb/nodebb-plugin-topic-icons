'use strict';

/*
 * Unit tests for lib/rate-limit.js: client keys, the page answer, and an express-rate-limit
 * limiter built with the shared options.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { rateLimit } = require('express-rate-limit');

const { WINDOW_MS, BASE_OPTIONS, clientKey, onPageLimit } = require('../lib/rate-limit');

function fakeRes() {
	const res = new EventEmitter();
	Object.assign(res, { statusCode: 200, headers: {}, body: undefined, contentType: '', headersSent: false, writableEnded: false });
	res.status = (code) => { res.statusCode = code; return res; };
	res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; return res; };
	res.append = res.setHeader;
	res.set = res.setHeader;
	res.type = (t) => { res.contentType = t; return res; };
	res.json = (body) => { res.body = body; res.writableEnded = true; return res; };
	res.send = (body) => { res.body = body; res.writableEnded = true; return res; };
	return res;
}

function fakeReq(props) {
	return Object.assign({ headers: {}, originalUrl: '/x', socket: {}, app: { get: () => false } }, props);
}

test('clientKey: uid for logged-in users, IP for guests', () => {
	assert.equal(clientKey({ uid: 5, ip: '1.2.3.4' }), 'uid:5');
	assert.equal(clientKey({ uid: '7' }), 'uid:7');
	assert.equal(clientKey({ uid: 0, ip: '1.2.3.4' }), 'ip:1.2.3.4');
	assert.equal(clientKey({ ip: '', socket: { remoteAddress: '5.6.7.8' } }), 'ip:5.6.7.8');
	assert.equal(clientKey({}), 'ip:unknown');
	assert.equal(clientKey(undefined), 'ip:unknown');
});

test('clientKey groups IPv6 guests by subnet and unwraps mapped IPv4', () => {
	const a = clientKey({ ip: '2001:db8:1:2:aaaa::1' });
	const b = clientKey({ ip: '2001:db8:1:2:bbbb::2' });
	assert.equal(a, b);
	assert.notEqual(a, clientKey({ ip: '2001:db8:2:2::1' }));
	assert.equal(clientKey({ ip: '::ffff:1.2.3.4' }), 'ip:1.2.3.4');
});

test('shared options: one-minute window, client key, standard headers', () => {
	assert.equal(WINDOW_MS, 60000);
	assert.equal(BASE_OPTIONS.windowMs, WINDOW_MS);
	assert.equal(BASE_OPTIONS.keyGenerator, clientKey);
	assert.equal(BASE_OPTIONS.legacyHeaders, false);
	assert.ok(Object.isFrozen(BASE_OPTIONS));
});

test('a limiter with the shared options refuses the request over the limit', async () => {
	const limiter = rateLimit({ ...BASE_OPTIONS, limit: 2, handler: onPageLimit });
	const run = async (req) => {
		const res = fakeRes();
		let passed = false;
		await limiter(req, res, (err) => { if (err) throw err; passed = true; });
		return { res, passed };
	};
	assert.equal((await run(fakeReq({ uid: 1 }))).passed, true);
	assert.equal((await run(fakeReq({ uid: 1 }))).passed, true);
	const refused = await run(fakeReq({ uid: 1 }));
	assert.equal(refused.passed, false);
	assert.equal(refused.res.statusCode, 429);
	assert.ok(Number(refused.res.headers['retry-after']) > 0);
	assert.equal(refused.res.body, 'Too many requests, please try again later.');
	// Other clients are counted separately.
	assert.equal((await run(fakeReq({ uid: 2 }))).passed, true);
	assert.equal((await run(fakeReq({ ip: '9.9.9.9' }))).passed, true);
	const api = await run(fakeReq({ uid: 1, originalUrl: '/api/admin/plugins/x' }));
	assert.equal(api.res.statusCode, 429);
	assert.deepEqual(api.res.body, { error: '[[error:api.429]]' });
});
