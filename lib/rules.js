'use strict';

/*
 * Who may set which icon, and what happens to a topic's icon on posting, queueing, editing and
 * moving. Access checks come in through `access`, so the rules can be unit-tested without
 * NodeBB (test/rules.test.js); library.js passes NodeBB's privileges and groups:
 *
 *   access = {
 *     isAdminOrMod(cid, uid): Promise<boolean>,  administrator or moderator of the category
 *     isMember(uid, groupName): Promise<boolean>,
 *   }
 *
 * Errors are thrown with translation tokens of the forum namespace; the composer shows them as
 * they are.
 */

const I = require('./icons');

/**
 * @param {string} key key under "error." in languages/<lang>/topic-icons.json
 * @returns {Error}
 */
function iconError(key) {
	return new Error(`[[${I.NAMESPACE}:error.${key}]]`);
}

/**
 * @param {*} uid
 * @returns {boolean} true for a positive integer uid (not guests, system or remote users)
 */
function isLocalUid(uid) {
	return /^\d+$/.test(String(uid)) && parseInt(uid, 10) > 0;
}

/**
 * @param {*} value icon id from a request
 * @returns {*} the trimmed string, or the value as is when it is not a string
 */
function requestedId(value) {
	return typeof value === 'string' ? value.trim() : value;
}

/**
 * Whether the user may pick an icon in a category, according to "Who can choose an icon".
 * Administrators and moderators of the category always may.
 *
 * @param {object} config normalised config
 * @param {number|string} uid
 * @param {number|string} cid
 * @param {object} access
 * @returns {Promise<boolean>}
 */
async function canChoose(config, uid, cid, access) {
	if (config.chooser === 'all') return true;
	if (!isLocalUid(uid)) return false;
	if (await access.isAdminOrMod(cid, uid)) return true;
	if (config.chooser === 'group' && config.chooserGroup) return !!(await access.isMember(uid, config.chooserGroup));
	return false;
}

/**
 * Validates an icon set by a user for a topic in a category. An empty value (remove the icon)
 * needs the same right to choose as any other value, so that with "moderators only" an author
 * cannot take off an icon a moderator gave the topic.
 *
 * @param {object} config normalised config
 * @param {number|string} uid
 * @param {number|string} cid
 * @param {*} value icon id from the request ('' = no icon)
 * @param {object} access
 * @returns {Promise<string>} the clean icon id, or ''
 */
async function checkChoice(config, uid, cid, value, access) {
	value = requestedId(value);
	if (value === '') {
		if (!(await canChoose(config, uid, cid, access))) throw iconError('no-privileges');
		return '';
	}
	const icon = I.findIcon(config, typeof value === 'string' ? value : '');
	if (!icon || !icon.active) throw iconError('unknown-icon');
	if (!I.isOffered(icon, cid)) throw iconError('not-in-category');
	if (!(await canChoose(config, uid, cid, access))) throw iconError('no-privileges');
	return icon.id;
}

/**
 * Icon of a new topic, from its payload (topics.post, also when it goes to the post queue).
 * An empty value means "no icon" and needs no check.
 *
 * @param {object} config
 * @param {{uid: *, cid: *, iconId: *}} data topic payload
 * @param {object} access
 * @returns {Promise<string>} the clean icon id, or '' for none
 */
async function checkNewTopic(config, data, access) {
	const value = requestedId(data.iconId);
	if (value === undefined || value === null || value === '') return '';
	return checkChoice(config, data.uid, data.cid, value, access);
}

/**
 * Icon of a queued topic that a moderator approves. It was checked when the topic was queued;
 * if it is no longer valid (icon removed or switched off, topic moved to another category,
 * author no longer allowed), the topic is posted without it instead of blocking the approval.
 *
 * @param {object} config
 * @param {object} data topic payload from the queue
 * @param {object} access
 * @returns {Promise<{id: string, dropped: string}>} `dropped` is the error token when the icon
 *   was dropped
 */
async function settleQueued(config, data, access) {
	try {
		return { id: await checkNewTopic(config, data, access), dropped: '' };
	} catch (err) {
		return { id: '', dropped: err.message };
	}
}

/**
 * Icon change when the first post of a topic is edited.
 * - A value equal to the topic's current icon is no change and is ignored, also when that icon
 *   is no longer offered (switched off, limited to other categories): re-sending it must not
 *   fail the whole edit.
 * - Otherwise only the topic author or a moderator of the category may change it, and the new
 *   value ('' included) must pass checkChoice().
 *
 * @param {{config: object, topic: {cid: *, uid: *, iconId?: *}, uid: *, value: *, access: object}} args
 * @returns {Promise<{change: false}|{change: true, id: string}>}
 */
async function planEdit({ config, topic, uid, value, access }) {
	value = requestedId(value);
	const current = I.cleanId(topic.iconId);
	if (typeof value === 'string' && value === current) return { change: false };
	const isOwner = isLocalUid(uid) && String(topic.uid) === String(uid);
	if (!isOwner && !(await access.isAdminOrMod(topic.cid, uid))) throw iconError('no-privileges');
	return { change: true, id: await checkChoice(config, uid, topic.cid, value, access) };
}

/**
 * Whether a topic moved to another category loses its icon: yes when the icon is limited to
 * categories that do not include the new one, or when it is no longer in the library. A
 * switched-off icon stays (as it does everywhere else); the category default of the new
 * category is shown for a topic without an icon.
 *
 * @param {object} config
 * @param {*} iconId icon of the topic
 * @param {*} toCid new category
 * @returns {boolean}
 */
function clearOnMove(config, iconId, toCid) {
	const id = I.cleanId(iconId);
	if (!id) return false;
	const icon = I.findIcon(config, id);
	if (!icon) return true;
	return icon.cids.length > 0 && !icon.cids.includes(I.cleanCid(toCid));
}

module.exports = {
	isLocalUid,
	canChoose,
	checkChoice,
	checkNewTopic,
	settleQueued,
	planEdit,
	clearOnMove,
};
