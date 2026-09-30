'use strict';

/*
 * Unit tests for lib/config-store.js: a config loaded or used across a save must not be cached
 * under the new generation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ConfigStore = require('../lib/config-store');

test('get() caches the config and tags it with its generation', async () => {
	let loads = 0;
	const store = new ConfigStore(async () => ({ n: ++loads }));
	const a = await store.get();
	const b = await store.get();
	assert.equal(a, b);
	assert.equal(loads, 1);
	assert.equal(a.generation, 0);
	assert.deepEqual(Object.keys(a), ['n'], 'generation is not enumerable');
	assert.equal(store.isCurrent(a), true);
});

test('a config handed out before a save is no longer current', async () => {
	let cleared = 0;
	const store = new ConfigStore(async () => ({}), () => { cleared += 1; });
	const old = await store.get();
	store.invalidate();
	assert.equal(cleared, 1);
	assert.equal(store.isCurrent(old), false);
	const fresh = await store.get();
	assert.notEqual(fresh, old);
	assert.equal(fresh.generation, 1);
	assert.equal(store.isCurrent(fresh), true);
});

test('a save during loading: the result is returned but neither cached nor current', async () => {
	let release;
	let loads = 0;
	const store = new ConfigStore(() => {
		loads += 1;
		return new Promise((resolve) => { release = () => resolve({ v: 'old' }); });
	});
	const pending = store.get();
	store.invalidate();
	release();
	const config = await pending;
	assert.equal(config.v, 'old');
	assert.equal(store.isCurrent(config), false, 'derived data must not be stored for it');
	store.load = async () => ({ v: 'new' });
	assert.equal((await store.get()).v, 'new', 'the stale config was not cached');
	assert.equal(loads, 1);
});

test('the race from the audit: render keyed by the config generation, not by the counter at render time', async () => {
	// Mirrors renderTopicIcon() in library.js: the key uses config.generation and the entry is
	// stored only while that generation is current.
	const cache = new Map();
	const store = new ConfigStore(async () => ({ name: 'old' }), () => cache.clear());
	const render = async (config, waitBeforeRender) => {
		await waitBeforeRender();
		const key = `${config.generation}|x`;
		if (!cache.has(key) && store.isCurrent(config)) cache.set(key, config.name);
		return cache.get(key) || config.name;
	};
	const config = await store.get();
	// A save lands while the request awaits the viewer's language.
	await render(config, async () => {
		store.load = async () => ({ name: 'new' });
		store.invalidate();
	});
	assert.equal(cache.size, 0, 'nothing rendered from the old config was stored');
	const next = await store.get();
	assert.equal(await render(next, async () => {}), 'new');
	assert.equal(cache.get('1|x'), 'new');
});
