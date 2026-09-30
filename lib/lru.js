'use strict';

/*
 * Minimal least-recently-used cache on top of Map, which keeps insertion order: a hit is
 * re-inserted at the end, and when the cache is full the first (oldest) key is evicted.
 * Used by library.js for rendered icons and users' languages, so that a burst of rare keys
 * (e.g. many ?lang= values) evicts only old entries instead of emptying the whole cache.
 * An optional time to live makes entries expire, for values that other processes may change.
 */

class LRU {
	/**
	 * @param {number} max maximum number of entries (at least 1)
	 * @param {{ttl?: number, now?: function(): number}} [opts] ttl: lifetime of an entry in ms
	 *   (0 = no expiry); now: clock, for tests
	 */
	constructor(max, opts) {
		opts = opts || {};
		this.max = Math.max(1, parseInt(max, 10) || 1);
		this.ttl = Math.max(0, parseInt(opts.ttl, 10) || 0);
		this.now = opts.now || Date.now;
		this.map = new Map();
	}

	/**
	 * @param {*} key
	 * @returns {boolean} whether the entry exists and has not expired (an expired one is removed)
	 */
	alive(key) {
		const entry = this.map.get(key);
		if (!entry) return false;
		if (entry.expires && entry.expires <= this.now()) {
			this.map.delete(key);
			return false;
		}
		return true;
	}

	/** @returns {number} number of entries */
	get size() {
		return this.map.size;
	}

	/**
	 * @param {*} key
	 * @returns {*} the value, or undefined; a hit marks the entry as recently used
	 */
	get(key) {
		if (!this.alive(key)) return undefined;
		const entry = this.map.get(key);
		this.map.delete(key);
		this.map.set(key, entry);
		return entry.value;
	}

	/**
	 * @param {*} key
	 * @returns {boolean} whether the key is present (does not change the order)
	 */
	has(key) {
		return this.alive(key);
	}

	/**
	 * Stores a value, evicting the least recently used entries when the cache is full.
	 *
	 * @param {*} key
	 * @param {*} value
	 * @returns {LRU} this
	 */
	set(key, value) {
		if (this.map.has(key)) this.map.delete(key);
		this.map.set(key, { value, expires: this.ttl ? this.now() + this.ttl : 0 });
		while (this.map.size > this.max) {
			this.map.delete(this.map.keys().next().value);
		}
		return this;
	}

	/**
	 * @param {*} key
	 * @returns {boolean} whether an entry was removed
	 */
	delete(key) {
		return this.map.delete(key);
	}

	/** @returns {void} */
	clear() {
		this.map.clear();
	}
}

module.exports = LRU;
