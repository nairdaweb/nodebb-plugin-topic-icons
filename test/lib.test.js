'use strict';

/*
 * Unit tests for the helpers taken out of library.js: language choice (lib/lang.js) and the
 * LRU cache (lib/lru.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { pickLang, isLangCode } = require('../lib/lang');
const LRU = require('../lib/lru');

test('pickLang: ?lang= → user setting → forum default → en-GB ', () => {
	assert.equal(pickLang({ query: 'de', userLang: 'pl', defaultLang: 'en-GB' }), 'de');
	assert.equal(pickLang({ userLang: 'pl', defaultLang: 'en-GB' }), 'pl');
	assert.equal(pickLang({ query: '', userLang: undefined, defaultLang: 'pl' }), 'pl');
	assert.equal(pickLang({}), 'en-GB');
	assert.equal(pickLang(), 'en-GB');
	// Invalid values are skipped, never passed on.
	assert.equal(pickLang({ query: '../../etc', userLang: ['pl'], defaultLang: 'fr' }), 'fr');
	assert.equal(pickLang({ query: 'x', defaultLang: '' }), 'en-GB');
});

test('isLangCode accepts NodeBB language folder names only', () => {
	['en-GB', 'pl', 'zh-CN', 'pt-BR', 'sr-Latn', 'fa-IR', 'en-x-pirate'].forEach(c => assert.equal(isLangCode(c), true, c));
	['', 'e', 'english-language', 'pl/../x', 'pl.json', null, 5].forEach(c => assert.equal(isLangCode(c), false, String(c)));
});

test('LRU evicts the least recently used entry', () => {
	const c = new LRU(3);
	c.set('a', 1).set('b', 2).set('c', 3);
	assert.equal(c.get('a'), 1, 'a is now the most recent');
	c.set('d', 4);
	assert.equal(c.has('b'), false, 'b was the oldest');
	assert.deepEqual([...c.map.keys()], ['c', 'a', 'd']);
	c.set('c', 30);
	c.set('e', 5);
	assert.equal(c.has('a'), false);
	assert.equal(c.get('c'), 30);
	assert.equal(c.size, 3);
	assert.equal(c.get('missing'), undefined);
	c.delete('c');
	assert.equal(c.size, 2);
	c.clear();
	assert.equal(c.size, 0);
});

test('LRU: a burst of new keys does not drop entries that keep being used', () => {
	const c = new LRU(10);
	c.set('icon-in-use', 'x');
	for (let i = 0; i < 100; i += 1) {
		c.set(`lang-${i}`, i);
		c.get('icon-in-use');
	}
	assert.equal(c.get('icon-in-use'), 'x');
	assert.equal(c.size, 10);
	assert.equal(new LRU(0).max, 1);
});

test('LRU with a time to live: expired entries are gone', () => {
	let now = 1000;
	const c = new LRU(5, { ttl: 100, now: () => now });
	c.set('uid:1', 'pl');
	assert.equal(c.get('uid:1'), 'pl');
	now += 99;
	assert.equal(c.has('uid:1'), true);
	now += 1;
	assert.equal(c.get('uid:1'), undefined);
	assert.equal(c.size, 0);
	c.set('uid:2', '');
	assert.equal(c.get('uid:2'), '', 'an empty value is a hit, not a miss');
});
