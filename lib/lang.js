'use strict';

/*
 * Choice of the viewer's language for icon names. Pure functions, used by
 * library.js and the unit tests.
 *
 * Where NodeBB 4 keeps the viewer's language:
 * - req.query.lang: set from ?lang= or, for guests with "auto-detect language" on, from the
 *   Accept-Language header by the core autoLocale middleware, which also replaces unknown codes
 *   with the forum default. It runs on page routes, their /api twins (ajaxify) and API v3 routes.
 * - user settings (userLang): logged-in users.
 * - meta.config.defaultLang: everyone else.
 */

/** Language codes as NodeBB names its language folders: "pl", "en-GB", "zh-CN", "en-x-pirate". */
const LANG_RE = /^[a-zA-Z]{2,3}([-_@][a-zA-Z0-9]{1,8}){0,2}$/;

/**
 * @param {*} value
 * @returns {boolean} true for a string that looks like a language code
 */
function isLangCode(value) {
	return typeof value === 'string' && LANG_RE.test(value);
}

/**
 * First valid language code in the order of preference:
 * ?lang= (query) → the user's own setting → the forum default → "en-GB".
 *
 * @param {{query?: *, userLang?: *, defaultLang?: *}} sources
 * @returns {string} language code
 */
function pickLang(sources) {
	sources = sources || {};
	const candidates = [sources.query, sources.userLang, sources.defaultLang];
	return candidates.find(isLangCode) || 'en-GB';
}

module.exports = { isLangCode, pickLang };
