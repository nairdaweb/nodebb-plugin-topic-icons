'use strict';

/*
 * Unit tests for lib/update-check.js: version comparison, the request that is sent, the cache
 * (memory and store), the disabled setting and the development-only URL override.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const uc = require('../lib/update-check');

const ID = 'nodebb-plugin-example';
const DOC = { id: ID, version: '1.3.0', date: '2026-10-10', notes_url: 'https://updates.wirelab.pl/#nodebb-plugin-example' };

function fakeFetch(answers) {
	const calls = [];
	const fn = async (url, init) => {
		calls.push({ url, init });
		const next = answers.length > 1 ? answers.shift() : answers[0];
		if (next instanceof Error) {
			throw next;
		}
		const body = typeof next === 'string' ? next : JSON.stringify(next);
		return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
	};
	fn.calls = calls;
	return fn;
}

function memoryStore() {
	let value = null;
	return { get: async () => value, set: async (v) => { value = JSON.parse(JSON.stringify(v)); }, peek: () => value };
}

function setup(over = {}) {
	let clock = 1_000_000;
	const fetch = over.fetch || fakeFetch([DOC]);
	const store = over.store || memoryStore();
	const checker = uc.createChecker({
		id: ID, version: '1.2.0', fetch, store, now: () => clock, env: {},
		isEnabled: over.isEnabled, isPrivate: over.isPrivate,
	});
	return { checker, fetch, store, advance: (ms) => { clock += ms; } };
}

test('compareVersions follows semver precedence', () => {
	assert.equal(uc.compareVersions('1.2.0', '1.2.0'), 0);
	assert.equal(uc.compareVersions('1.10.0', '1.9.9'), 1);
	assert.equal(uc.compareVersions('1.2.0', '1.2.1'), -1);
	assert.equal(uc.compareVersions('2.0.0', '10.0.0'), -1);
	assert.equal(uc.compareVersions('1.2.0-beta.1', '1.2.0'), -1);
	assert.equal(uc.compareVersions('1.2.0-beta.10', '1.2.0-beta.2'), 1);
	assert.equal(uc.compareVersions('1.2.0-alpha', '1.2.0-alpha.1'), -1);
	assert.equal(uc.compareVersions('1.2.0-1', '1.2.0-alpha'), -1);
	assert.equal(uc.compareVersions('v1.2.0', '1.2.0+build.5'), 0);
	assert.equal(uc.compareVersions('1.2', '1.2.0'), null);
	assert.equal(uc.compareVersions(null, '1.2.0'), null);
	assert.equal(uc.isNewer('1.3.0', '1.2.0'), true);
	assert.equal(uc.isNewer('1.2.0', '1.2.0'), false);
	assert.equal(uc.isNewer('garbage', '1.2.0'), false);
});

test('readEntry keeps only safe fields', () => {
	assert.deepEqual(uc.readEntry(DOC, ID), { version: '1.3.0', date: '2026-10-10', notesUrl: DOC.notes_url });
	assert.equal(uc.readEntry({ ...DOC, id: 'other' }, ID), null);
	assert.equal(uc.readEntry({ ...DOC, version: '1.3' }, ID), null);
	assert.equal(uc.readEntry({ ...DOC, notes_url: 'javascript:alert(1)' }, ID).notesUrl, null);
	assert.equal(uc.readEntry({ ...DOC, notes_url: 'http://example.com/' }, ID).notesUrl, null);
	assert.equal(uc.readEntry({ ...DOC, date: '<b>' }, ID).date, null);
	assert.equal(uc.readEntry('x', ID), null);
});

test('a plain GET without parameters or cookies, with the plugin as User-Agent', async () => {
	const { checker, fetch } = setup();
	const n = await checker.notice();
	assert.deepEqual(n, { version: '1.3.0', date: '2026-10-10', notesUrl: DOC.notes_url, isPrivate: false });
	assert.equal(fetch.calls.length, 1);
	const { url, init } = fetch.calls[0];
	assert.equal(url, 'https://updates.wirelab.pl/api/nodebb-plugin-example.json');
	assert.equal(init.method, 'GET');
	assert.equal(init.body, undefined);
	assert.equal(init.credentials, 'omit');
	assert.deepEqual(Object.keys(init.headers).sort(), ['Accept', 'User-Agent']);
	assert.equal(init.headers['User-Agent'], 'nodebb-plugin-example/1.2.0');
	assert.ok(init.signal);
});

test('cache: one request per day, reused across calls and restarts', async () => {
	const { checker, fetch, store, advance } = setup();
	await checker.notice();
	advance(uc.DAY - 1);
	await checker.notice();
	await checker.check();
	assert.equal(fetch.calls.length, 1);

	// a restarted process reads the stored result instead of fetching again
	const again = uc.createChecker({ id: ID, version: '1.2.0', fetch, store, now: () => 1_000_000 + uc.DAY - 1, env: {} });
	assert.equal((await again.notice()).version, '1.3.0');
	assert.equal(fetch.calls.length, 1);

	advance(1);
	await checker.notice();
	assert.equal(fetch.calls.length, 2);
	assert.equal(store.peek().ok, true);
});

test('concurrent checks share one request', async () => {
	const { checker, fetch } = setup();
	await Promise.all([checker.notice(), checker.notice(), checker.check()]);
	assert.equal(fetch.calls.length, 1);
});

test('errors are quiet, keep the last result and retry after an hour', async () => {
	const fetch = fakeFetch([DOC, new Error('offline'), new Error('offline'), '{not json']);
	const { checker, advance } = setup({ fetch });
	assert.equal((await checker.notice()).version, '1.3.0');
	advance(uc.DAY);
	assert.equal((await checker.notice()).version, '1.3.0', 'last good result is kept');
	assert.equal(fetch.calls.length, 2);
	advance(uc.RETRY_AFTER_ERROR - 1);
	await checker.notice();
	assert.equal(fetch.calls.length, 2);
	advance(1);
	await checker.notice();
	assert.equal(fetch.calls.length, 3);
	advance(uc.RETRY_AFTER_ERROR);
	await assert.doesNotReject(checker.notice());
	assert.equal(fetch.calls.length, 4);
});

test('no notice for the same or an older version', async () => {
	for (const version of ['1.2.0', '1.1.9', '1.2.0-rc.1']) {
		const { checker } = setup({ fetch: fakeFetch([{ ...DOC, version }]) });
		assert.equal(await checker.notice(), null, version);
	}
});

test('private plugins get no link', async () => {
	const { checker } = setup({ isPrivate: true });
	assert.deepEqual(await checker.notice(), { version: '1.3.0', date: '2026-10-10', notesUrl: null, isPrivate: true });
});

test('switched off: no request at all', async () => {
	const { checker, fetch } = setup({ isEnabled: async () => false });
	assert.equal(await checker.notice(), null);
	assert.equal(await checker.check(), null);
	assert.equal(fetch.calls.length, 0);
});

test('isOn reads saved switches', () => {
	assert.equal(uc.isOn('on'), true);
	assert.equal(uc.isOn('off'), false);
	assert.equal(uc.isOn('false'), false);
	assert.equal(uc.isOn(false), false);
	assert.equal(uc.isOn('0'), false);
});

test('URL override only in development mode', () => {
	assert.equal(uc.baseUrl({ WIRELAB_UPDATES_URL: 'http://127.0.0.1:8000/api' }), uc.DEFAULT_BASE);
	assert.equal(uc.baseUrl({ NODE_ENV: 'production', WIRELAB_UPDATES_URL: 'http://127.0.0.1:8000/api' }), uc.DEFAULT_BASE);
	assert.equal(uc.baseUrl({ NODE_ENV: 'development', WIRELAB_UPDATES_URL: 'http://127.0.0.1:8000/api' }), 'http://127.0.0.1:8000/api/');
	assert.equal(uc.baseUrl({ NODE_ENV: 'development', WIRELAB_UPDATES_URL: 'file:///etc/passwd' }), uc.DEFAULT_BASE);
});
