'use strict';

/*
 * Unit tests for lib/rules.js: who may set which icon on posting, queueing, approving, editing,
 * and what a move does to the icon. NodeBB's access checks are replaced by a fake.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const I = require('../lib/icons');
const R = require('../lib/rules');

const config = (extra) => I.normalize(Object.assign({
	icons: JSON.stringify([
		{ id: 'question', key: 'question', url: '/q.svg', cids: [] },
		{ id: 'linux', name: 'Linux', url: '/l.png', cids: [2] },
		{ id: 'old', name: 'Old', url: '/o.png', cids: [], active: false },
	]),
}, extra));

/** uid 1: author; uid 2: moderator of every category; uid 3: member of "helpers"; uid 4: nobody. */
const access = {
	isAdminOrMod: async (cid, uid) => String(uid) === '2',
	isMember: async (uid, group) => String(uid) === '3' && group === 'helpers',
};

const token = key => `[[topic-icons:error.${key}]]`;
const rejects = (promise, key) => assert.rejects(promise, { message: token(key) });

test('canChoose follows "who can choose"; moderators always may', async () => {
	const all = config({ chooser: 'all' });
	const group = config({ chooser: 'group', chooserGroup: 'helpers' });
	const mods = config({ chooser: 'mods' });
	assert.equal(await R.canChoose(all, 0, 1, access), true, 'guests too, when they can post');
	assert.equal(await R.canChoose(group, 3, 1, access), true);
	assert.equal(await R.canChoose(group, 1, 1, access), false);
	assert.equal(await R.canChoose(group, 2, 1, access), true);
	assert.equal(await R.canChoose(mods, 1, 1, access), false);
	assert.equal(await R.canChoose(mods, 2, 1, access), true);
	assert.equal(await R.canChoose(mods, 0, 1, access), false);
});

test('checkChoice: existing, active, offered in the category, allowed', async () => {
	const c = config();
	assert.equal(await R.checkChoice(c, 1, 2, 'linux', access), 'linux');
	assert.equal(await R.checkChoice(c, 1, 1, ' question ', access), 'question');
	await rejects(R.checkChoice(c, 1, 1, 'linux', access), 'not-in-category');
	await rejects(R.checkChoice(c, 1, 1, 'old', access), 'unknown-icon');
	await rejects(R.checkChoice(c, 1, 1, 'nope', access), 'unknown-icon');
	await rejects(R.checkChoice(c, 1, 1, ['question'], access), 'unknown-icon');
	await rejects(R.checkChoice(config({ chooser: 'mods' }), 1, 1, 'question', access), 'no-privileges');
});

test('checkChoice: an empty id (remove the icon) needs the right to choose as well', async () => {
	const mods = config({ chooser: 'mods' });
	await rejects(R.checkChoice(mods, 1, 1, '', access), 'no-privileges');
	assert.equal(await R.checkChoice(mods, 2, 1, '', access), '');
	assert.equal(await R.checkChoice(config(), 1, 1, '', access), '');
});

test('checkNewTopic: no icon needs no check; a bad one is refused (also when queueing)', async () => {
	const mods = config({ chooser: 'mods' });
	assert.equal(await R.checkNewTopic(mods, { uid: 1, cid: 1, iconId: '' }, access), '');
	assert.equal(await R.checkNewTopic(mods, { uid: 1, cid: 1 }, access), '');
	await rejects(R.checkNewTopic(mods, { uid: 1, cid: 1, iconId: 'question' }, access), 'no-privileges');
	await rejects(R.checkNewTopic(config(), { uid: 1, cid: 1, iconId: 'x' }, access), 'unknown-icon');
	assert.equal(await R.checkNewTopic(config(), { uid: 1, cid: 2, iconId: 'linux' }, access), 'linux');
});

test('settleQueued: approval never fails because of the icon; an invalid one is dropped', async () => {
	assert.deepEqual(await R.settleQueued(config(), { uid: 1, cid: 2, iconId: 'linux' }, access), { id: 'linux', dropped: '' });
	// Moved to another category in the queue, or the icon was switched off meanwhile.
	assert.deepEqual(await R.settleQueued(config(), { uid: 1, cid: 1, iconId: 'linux' }, access), { id: '', dropped: token('not-in-category') });
	assert.deepEqual(await R.settleQueued(config(), { uid: 1, cid: 1, iconId: 'old' }, access), { id: '', dropped: token('unknown-icon') });
	// The author is no longer allowed to choose.
	assert.deepEqual(await R.settleQueued(config({ chooser: 'mods' }), { uid: 1, cid: 1, iconId: 'question' }, access),
		{ id: '', dropped: token('no-privileges') });
});

test('planEdit: sending the current icon again is no change, even when it is no longer offered', async () => {
	const c = config();
	const topic = { cid: 1, uid: 1, iconId: 'linux' }; // linux is limited to category 2
	assert.deepEqual(await R.planEdit({ config: c, topic, uid: 1, value: 'linux', access }), { change: false });
	assert.deepEqual(await R.planEdit({ config: c, topic: { cid: 1, uid: 1, iconId: 'old' }, uid: 1, value: 'old', access }), { change: false });
	assert.deepEqual(await R.planEdit({ config: c, topic: { cid: 1, uid: 1 }, uid: 4, value: '', access }), { change: false },
		'a co-editor sending no icon for a topic without one changes nothing');
	await rejects(R.planEdit({ config: c, topic, uid: 1, value: 'old', access }), 'unknown-icon');
	assert.deepEqual(await R.planEdit({ config: c, topic, uid: 1, value: 'question', access }), { change: true, id: 'question' });
	assert.deepEqual(await R.planEdit({ config: c, topic, uid: 1, value: '', access }), { change: true, id: '' });
});

test('planEdit: only the author or a moderator; with "moderators only" the author cannot remove the icon', async () => {
	const c = config();
	const topic = { cid: 1, uid: 1, iconId: 'question' };
	await rejects(R.planEdit({ config: c, topic, uid: 4, value: '', access }), 'no-privileges');
	assert.deepEqual(await R.planEdit({ config: c, topic, uid: 2, value: '', access }), { change: true, id: '' });
	const mods = config({ chooser: 'mods' });
	await rejects(R.planEdit({ config: mods, topic, uid: 1, value: '', access }), 'no-privileges');
	assert.deepEqual(await R.planEdit({ config: mods, topic, uid: 1, value: 'question ', access }), { change: false },
		'the author may still save the post with the icon unchanged');
	assert.deepEqual(await R.planEdit({ config: mods, topic, uid: 2, value: '', access }), { change: true, id: '' });
});

test('clearOnMove: an icon limited to other categories (or gone) is cleared; switched-off icons stay', () => {
	const c = config();
	assert.equal(R.clearOnMove(c, 'linux', 1), true);
	assert.equal(R.clearOnMove(c, 'linux', '2'), false);
	assert.equal(R.clearOnMove(c, 'question', 5), false);
	assert.equal(R.clearOnMove(c, 'old', 5), false, 'switched off, not limited');
	assert.equal(R.clearOnMove(c, 'removed', 5), true);
	assert.equal(R.clearOnMove(c, '', 5), false);
	assert.equal(R.clearOnMove(c, undefined, 5), false);
});

test('isLocalUid', () => {
	assert.equal(R.isLocalUid(1), true);
	assert.equal(R.isLocalUid('12'), true);
	[0, -1, '0', 'https://remote/u/1', null, undefined, 1.5].forEach(v => assert.equal(R.isLocalUid(v), false, String(v)));
});
