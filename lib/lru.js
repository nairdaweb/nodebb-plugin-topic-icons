'use strict';

/*
 * Minimal least-recently-used cache on top of Map, which keeps insertion order: a hit is
 * re-inserted at the end, and when the cache is full the first (oldest) key is evicted.
 * Used by library.js for rendered icons and permission answers, so that a burst of rare keys
 * (e.g. many ?lang= values) evicts only old entries instead of emptying the whole cache.
 */

class LRU {
	/**
	 * @param {number} max maximum number of entries (at least 1)
	 */
	constructor(max) {
		this.max = Math.max(1, parseInt(max, 10) || 1);
		this.map = new Map();
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
		if (!this.map.has(key)) return undefined;
		const value = this.map.get(key);
		this.map.delete(key);
		this.map.set(key, value);
		return value;
	}

	/**
	 * @param {*} key
	 * @returns {boolean} whether the key is present (does not change the order)
	 */
	has(key) {
		return this.map.has(key);
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
		this.map.set(key, value);
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
