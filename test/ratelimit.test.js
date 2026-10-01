'use strict';

/*
 * Unit tests for lib/ratelimit.js: window counting, client keys, memory bound and the
 * middleware answers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLimiter, clientKey } = require('../lib/ratelimit');

function fakeRes() {
	const res = { statusCode: 200, headers: {}, body: undefined, contentType: '' };
	res.status = (code) => { res.statusCode = code; return res; };
	res.set = (name, value) => { res.headers[name] = value; return res; };
	res.type = (t) => { res.contentType = t; return res; };
	res.json = (body) => { res.body = body; return res; };
	res.send = (body) => { res.body = body; return res; };
	return res;
}

test('allows max requests per window, then refuses until the window ends', () => {
	let t = 1000;
	const limit = createLimiter({ windowMs: 10000, max: 3, now: () => t });
	assert.deepEqual([1, 2, 3].map(() => limit.hit('a').allowed), [true, true, true]);
	const refused = limit.hit('a');
	assert.equal(refused.allowed, false);
	assert.equal(refused.retryAfter, 10);
	assert.equal(limit.hit('b').allowed, true, 'other clients are counted separately');
	t += 10000;
	assert.equal(limit.hit('a').allowed, true, 'a new window starts');
});

test('expired windows are swept and the number of tracked clients is bounded', () => {
	let t = 0;
	const limit = createLimiter({ windowMs: 1000, max: 5, maxKeys: 3, now: () => t });
	['a', 'b', 'c'].forEach(k => limit.hit(k));
	assert.equal(limit.size(), 3);
	limit.hit('d');
	assert.equal(limit.size(), 3, 'the oldest client is dropped');
	t = 5000;
	limit.hit('e');
	assert.equal(limit.size(), 1, 'expired windows are removed');
	limit.clear();
	assert.equal(limit.size(), 0);
});

test('clientKey uses the uid for users and the IP address for guests', () => {
	assert.equal(clientKey({ uid: 5, ip: '1.2.3.4' }), 'uid:5');
	assert.equal(clientKey({ uid: 0, ip: '1.2.3.4' }), 'ip:1.2.3.4');
	assert.equal(clientKey({ uid: -1, socket: { remoteAddress: '::1' } }), 'ip:::1');
	assert.equal(clientKey({}), 'ip:unknown');
});

test('middleware calls next() while allowed and answers 429 afterwards', () => {
	const limit = createLimiter({ windowMs: 60000, max: 1 });
	let passed = 0;
	const apiReq = { uid: 1, originalUrl: '/api/admin/plugins/x/upload' };
	limit(apiReq, fakeRes(), () => { passed += 1; });
	const res = fakeRes();
	limit(apiReq, res, () => { passed += 1; });
	assert.equal(passed, 1);
	assert.equal(res.statusCode, 429);
	assert.equal(res.headers['Retry-After'], '60');
	assert.deepEqual(res.body, { error: '[[error:api.429]]' });

	const page = fakeRes();
	limit({ uid: 1, originalUrl: '/admin/plugins/x' }, page, () => { passed += 1; });
	assert.equal(page.statusCode, 429);
	assert.equal(page.contentType, 'text/plain');
});

test('custom key and onLimit are used', () => {
	const seen = [];
	const limit = createLimiter({ max: 1, key: req => req.who, onLimit: (req, res, result) => seen.push(result.allowed) });
	limit({ who: 'x' }, fakeRes(), () => {});
	limit({ who: 'x' }, fakeRes(), () => assert.fail('must not pass'));
	limit({ who: 'y' }, fakeRes(), () => seen.push('y'));
	assert.deepEqual(seen, [false, 'y']);
});
