'use strict';

/*
 * In-memory copy of the plugin configuration with a generation counter. No NodeBB imports, so
 * it can be unit-tested (test/config-store.test.js).
 *
 * Every config returned by get() carries the generation it was loaded in (non-enumerable
 * `generation`). Anything derived from a config (rendered icons, see library.js) is keyed and
 * stored under that generation, and only while it is still the current one. A request that
 * started with the old settings therefore never stores a result built from them after a save,
 * even when the save lands between two awaits of that request.
 */

class ConfigStore {
	/**
	 * @param {function(): Promise<object>} load reads and normalises the settings
	 * @param {function(): void} [onInvalidate] called after each invalidation (e.g. to clear
	 *   caches of derived data)
	 */
	constructor(load, onInvalidate) {
		this.load = load;
		this.onInvalidate = onInvalidate || function () {};
		this.generation = 0;
		this.cached = null;
	}

	/**
	 * @returns {Promise<object>} the config, with a non-enumerable `generation`
	 */
	async get() {
		if (this.cached) return this.cached;
		const started = this.generation;
		const config = await this.load();
		Object.defineProperty(config, 'generation', { value: started, enumerable: false });
		if (started === this.generation) this.cached = config;
		return config;
	}

	/**
	 * @param {object} config a config returned by get()
	 * @returns {boolean} whether it still belongs to the current generation
	 */
	isCurrent(config) {
		return !!config && config.generation === this.generation;
	}

	/**
	 * Drops the cached config; configs handed out before are no longer current.
	 *
	 * @returns {void}
	 */
	invalidate() {
		this.generation += 1;
		this.cached = null;
		this.onInvalidate();
	}
}

module.exports = ConfigStore;
