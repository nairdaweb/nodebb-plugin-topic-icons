'use strict';

/*
 * nodebb-plugin-topic-icons: forum-side script, bundled into NodeBB's client JS through
 * "scripts" in plugin.json (runs on every forum page, not in the ACP).
 *
 * 1. Composer (nodebb-plugin-composer-default): a "Choose icon" button next to the title of a
 *    new topic or of the first post being edited. It opens a grid of the icons offered in the
 *    selected category (GET /api/v3/plugins/topic-icons/choices) with a preview of the topic
 *    row. The choice is sent with the post as `iconId` (filter:composer.submit) and validated by
 *    the server; nothing here is trusted. The choice is kept in the composer draft.
 * 2. Themes without a slot for the icon: the server-rendered icon (topic.topicIcon.html) is put
 *    in front of the topic title in topic lists and in the topic header. Themes that print
 *    {{./topicIcon.html}} themselves are left alone.
 * 3. Topic lists loaded from routes that do not know the viewer's language (e.g. infinite scroll
 *    of guests) get their icons again in the viewer's language.
 * 4. Topic thumbnails (NodeBB's and the covers added by the server) get the topic title as their
 *    alt text and are decoded asynchronously.
 *
 * Icon names are inserted with textContent or come escaped from the server, so no text typed by
 * an admin is ever parsed as HTML or as a translation token. Escaped text is decoded with
 * decodeEntities() from lib/icons.js, a string operation that never parses HTML.
 */
(function () {
	const NS = 'topic-icons';

	/**
	 * @returns {Promise<object>} lib/icons.js (exposed as "topic-icons/icons" in plugin.json)
	 */
	function lib() {
		return new Promise(function (resolve) {
			require(['topic-icons/icons'], resolve);
		});
	}

	/**
	 * @param {Array<string>} keys keys of the forum namespace
	 * @returns {Promise<Object<string, string>>} key → translated plain text
	 */
	function strings(keys) {
		return lib().then(function (I) {
			return new Promise(function (resolve) {
				require(['translator'], function (translator) {
					Promise.all(keys.map(function (k) { return translator.translate('[[' + NS + ':' + k + ']]'); })).then(function (list) {
						const out = {};
						keys.forEach(function (k, i) { out[k] = I.decodeEntities(list[i]); });
						resolve(out);
					});
				});
			});
		});
	}

	/**
	 * @param {string} path route under /api/v3
	 * @param {object} params query parameters
	 * @returns {Promise<object>} response
	 */
	function apiGet(path, params) {
		return new Promise(function (resolve, reject) {
			require(['api'], function (api) {
				api.get(path, params).then(resolve, reject);
			});
		});
	}

	/**
	 * @param {string} template text with "%1"
	 * @param {string} value plain text, inserted as is ("$&" and the like are not special)
	 * @returns {string}
	 */
	function fill(template, value) {
		return String(template).split('%1').join(value);
	}

	/**
	 * @param {string} url
	 * @param {string} alt
	 * @returns {HTMLImageElement}
	 */
	function img(url, alt) {
		const el = document.createElement('img');
		el.src = url;
		el.alt = alt || '';
		el.width = 40;
		el.height = 40;
		el.decoding = 'async';
		el.referrerPolicy = 'no-referrer';
		el.className = 'topic-icon__img';
		return el;
	}

	/**
	 * @param {object} choices response of the choices route
	 * @param {string} id
	 * @returns {object|null} icon { id, name, url } offered for that id, or the current icon
	 */
	function findChoice(choices, id) {
		if (!id) return null;
		const list = choices.icons.concat(choices.currentIcon ? [choices.currentIcon] : []);
		return list.find(function (i) { return i.id === id; }) || null;
	}

	/**
	 * @param {object} choices
	 * @param {string} id
	 * @returns {boolean} whether the id is the topic's current icon that is no longer offered
	 */
	function isUnavailable(choices, id) {
		return !!id && !!choices.currentIcon && choices.currentIcon.id === id;
	}

	/**
	 * Icon currently selected in a composer: the user's pick in this session, otherwise the
	 * stored icon of the topic being edited.
	 *
	 * @param {object} postData composer post data
	 * @returns {string}
	 */
	function selectedId(postData) {
		const state = postData.topicIcons;
		if (state.choice !== undefined) return state.choice;
		return state.choices ? state.choices.current : '';
	}

	/**
	 * @returns {Storage|null} where composer-default keeps drafts of this user
	 */
	function draftStorage() {
		try {
			return window.app && app.user && parseInt(app.user.uid, 10) > 0 ? window.localStorage : window.sessionStorage;
		} catch {
			return null;
		}
	}

	/**
	 * Keeps the pick in the composer's saved draft, if there is one already (later saves add it
	 * through filter:composer.drafts.save).
	 *
	 * @param {object} postData
	 * @returns {void}
	 */
	function rememberInDraft(postData) {
		const storage = draftStorage();
		if (!storage || !postData.save_id) return;
		try {
			const raw = storage.getItem(postData.save_id);
			if (!raw) return;
			const draft = JSON.parse(raw);
			if (!draft || typeof draft !== 'object') return;
			if (postData.topicIcons.choice === undefined) delete draft.topicIconId;
			else draft.topicIconId = postData.topicIcons.choice;
			storage.setItem(postData.save_id, JSON.stringify(draft));
		} catch {
			// Storage full or blocked: the pick is kept for this composer only.
		}
	}

	/**
	 * @param {object} postData
	 * @returns {string|undefined} icon id kept in the draft this composer was opened from
	 */
	function pickFromDraft(postData) {
		const storage = draftStorage();
		if (!storage || !postData.fromDraft || !postData.save_id) return undefined;
		try {
			const draft = JSON.parse(storage.getItem(postData.save_id));
			return draft && typeof draft.topicIconId === 'string' ? draft.topicIconId : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Updates the composer button: the chosen icon (or the category default, faded), and the
	 * accessible name "Topic icon: …".
	 *
	 * @param {object} postData
	 * @returns {void}
	 */
	function updateButton(postData) {
		const state = postData.topicIcons;
		const btn = state.button;
		const choices = state.choices;
		if (!btn) return;
		// Without choices (loading failed) the button stays, so that a click can retry and say so.
		btn.classList.toggle('hidden', !!choices && !choices.canChoose);
		const chosen = choices ? findChoice(choices, selectedId(postData)) : null;
		const shown = chosen || (choices && choices.defaultIcon);
		const visual = btn.querySelector('.topic-icons-btn__visual');
		visual.textContent = '';
		if (shown) {
			visual.appendChild(img(shown.url, ''));
			visual.classList.toggle('topic-icons-btn__visual--default', !chosen);
		} else {
			const i = document.createElement('i');
			i.className = 'fa fa-image';
			i.setAttribute('aria-hidden', 'true');
			visual.appendChild(i);
		}
		strings(['choose', 'choose-current']).then(function (s) {
			const text = chosen ? fill(s['choose-current'], chosen.name) : s.choose;
			btn.setAttribute('title', text);
			btn.setAttribute('aria-label', text);
			btn.querySelector('.topic-icons-btn__label').textContent = s.choose;
		});
	}

	/**
	 * Parameters of the choices route for a composer: the category of a new topic, or the post
	 * being edited (composer-default gives an edit composer a pid but no tid).
	 *
	 * @param {object} postData
	 * @returns {object|null}
	 */
	function choiceParams(postData) {
		const state = postData.topicIcons;
		if (state.isEdit) {
			if (postData.pid) return { pid: postData.pid };
			return postData.tid ? { tid: postData.tid } : null;
		}
		return postData.cid ? { cid: postData.cid } : null;
	}

	/**
	 * (Re)loads the icons for the composer's category or topic. Only the answer to the latest
	 * request is used, so a quick change of category cannot leave the icons of the previous one.
	 *
	 * @param {object} postData
	 * @returns {Promise<boolean>} whether the icons were loaded
	 */
	function refresh(postData) {
		const state = postData.topicIcons;
		const params = choiceParams(postData);
		state.seq = (state.seq || 0) + 1;
		const seq = state.seq;
		if (!params) {
			state.choices = { canChoose: false, icons: [], current: '', currentIcon: null, defaultIcon: null };
			updateButton(postData);
			return Promise.resolve(false);
		}
		return apiGet('/plugins/topic-icons/choices', params).then(function (choices) {
			if (seq !== state.seq) return false;
			state.choices = choices;
			// A pick that the new category does not offer is dropped.
			if (state.choice && !findChoice(choices, state.choice)) state.choice = undefined;
			updateButton(postData);
			return true;
		}, function () {
			if (seq !== state.seq) return false;
			state.choices = null;
			updateButton(postData);
			return false;
		});
	}

	/**
	 * Row preview in the picker: icon, the title typed in the composer, the topic author (the
	 * current user for a new topic) and "just now".
	 *
	 * @param {HTMLElement} box preview container
	 * @param {object|null} icon
	 * @param {boolean} isDefault
	 * @param {string} title
	 * @param {string} author plain text ('' = not shown)
	 * @param {object} s translated strings
	 * @returns {void}
	 */
	function renderPreview(box, icon, isDefault, title, author, s) {
		box.textContent = '';
		const row = document.createElement('div');
		row.className = 'topic-icons-preview d-flex align-items-center gap-2 p-2 border rounded-1';
		if (icon) {
			const wrap = document.createElement('span');
			wrap.className = 'topic-icon' + (isDefault ? ' topic-icon--default' : '');
			wrap.appendChild(img(icon.url, icon.name));
			row.appendChild(wrap);
		}
		const text = document.createElement('div');
		text.className = 'd-flex flex-column text-truncate';
		const t = document.createElement('span');
		t.className = 'fw-semibold text-truncate';
		t.textContent = title || s['picker-preview-title'];
		const meta = document.createElement('span');
		meta.className = 'text-muted text-xs';
		meta.textContent = author ? author + ' • ' + s['picker-just-now'] : s['picker-just-now'];
		text.appendChild(t);
		text.appendChild(meta);
		row.appendChild(text);
		box.appendChild(row);
	}

	/**
	 * @param {object} postData
	 * @param {object} I lib/icons.js
	 * @returns {string} plain-text name of the topic author for the preview
	 */
	function previewAuthor(postData, I) {
		const choices = postData.topicIcons.choices;
		if (postData.topicIcons.isEdit) return (choices && choices.author) || '';
		const u = window.app && app.user;
		return u && parseInt(u.uid, 10) > 0 ? I.decodeEntities(u.displayname || u.username || '') : '';
	}

	/**
	 * Opens the picker dialog for a composer. A second click while it is opening or open does
	 * nothing; if the icons could not be loaded, they are loaded again and an error is shown when
	 * that fails too.
	 *
	 * @param {object} postData
	 * @param {jQuery} postContainer
	 * @returns {void}
	 */
	function openPicker(postData, postContainer) {
		const state = postData.topicIcons;
		if (state.opening) return;
		state.opening = true;
		const ready = state.choices ? Promise.resolve(true) : refresh(postData);
		ready.then(function (ok) {
			if (!ok || !state.choices) {
				state.opening = false;
				require(['alerts'], function (alerts) { alerts.error('[[' + NS + ':picker-load-error]]'); });
				return;
			}
			if (!state.choices.canChoose) {
				state.opening = false;
				return;
			}
			showPicker(postData, postContainer);
		});
	}

	/**
	 * Builds and shows the picker dialog (see openPicker).
	 *
	 * @param {object} postData
	 * @param {jQuery} postContainer
	 * @returns {void}
	 */
	function showPicker(postData, postContainer) {
		const state = postData.topicIcons;
		const choices = state.choices;
		const keys = ['picker-title', 'picker-help', 'picker-none', 'picker-default', 'picker-preview', 'picker-preview-title',
			'picker-just-now', 'picker-empty', 'picker-cancel', 'picker-select', 'picker-unavailable', 'picker-unavailable-help'];
		Promise.all([strings(keys), lib()]).then(function (loaded) {
			const s = loaded[0];
			const I = loaded[1];
			require(['bootbox'], function (bootbox) {
				let current = selectedId(postData);
				const author = previewAuthor(postData, I);
				const body = document.createElement('div');
				body.className = 'topic-icons-picker';
				const help = document.createElement('p');
				help.className = 'form-text mt-0';
				help.textContent = s['picker-help'];
				const grid = document.createElement('div');
				grid.className = 'topic-icons-picker__grid';
				grid.setAttribute('role', 'radiogroup');
				grid.setAttribute('aria-label', s['picker-title']);
				const warning = document.createElement('p');
				warning.className = 'text-warning-emphasis text-sm mt-2 mb-0 d-none';
				warning.id = 'topic-icons-unavailable-' + Date.now().toString(36);
				warning.setAttribute('role', 'status');
				warning.textContent = s['picker-unavailable-help'];
				const previewLabel = document.createElement('div');
				previewLabel.className = 'fw-semibold text-sm mt-3 mb-1';
				previewLabel.textContent = s['picker-preview'];
				const preview = document.createElement('div');
				body.appendChild(help);
				body.appendChild(grid);
				body.appendChild(warning);
				body.appendChild(previewLabel);
				body.appendChild(preview);

				const title = String(postContainer.find('input.title').val() || '').trim();
				const options = [{ id: '', name: choices.defaultIcon ? s['picker-default'] : s['picker-none'], url: choices.defaultIcon && choices.defaultIcon.url }]
					.concat(choices.currentIcon ? [choices.currentIcon] : [])
					.concat(choices.icons);
				let okButton = null;

				/** @returns {void} */
				function sync() {
					grid.querySelectorAll('[role="radio"]').forEach(function (b) {
						const on = b.getAttribute('data-id') === current;
						b.setAttribute('aria-checked', on ? 'true' : 'false');
						b.tabIndex = on ? 0 : -1;
					});
					const unavailable = isUnavailable(choices, current);
					warning.classList.toggle('d-none', !unavailable);
					if (okButton) {
						okButton.prop('disabled', unavailable);
						if (unavailable) okButton.attr('aria-describedby', warning.id);
						else okButton.removeAttr('aria-describedby');
					}
					const icon = current ? findChoice(choices, current) : choices.defaultIcon;
					renderPreview(preview, icon, !current, title, author, s);
				}

				options.forEach(function (o) {
					const b = document.createElement('button');
					b.type = 'button';
					b.className = 'topic-icons-picker__opt';
					b.setAttribute('role', 'radio');
					b.setAttribute('data-id', o.id);
					if (o.url) {
						const wrap = document.createElement('span');
						wrap.className = 'topic-icon' + (o.id ? '' : ' topic-icon--default');
						wrap.appendChild(img(o.url, ''));
						b.appendChild(wrap);
					} else {
						const i = document.createElement('i');
						i.className = 'fa fa-ban topic-icons-picker__none';
						i.setAttribute('aria-hidden', 'true');
						b.appendChild(i);
					}
					const cap = document.createElement('span');
					cap.className = 'topic-icons-picker__name';
					cap.textContent = o.name;
					b.appendChild(cap);
					if (isUnavailable(choices, o.id)) {
						b.classList.add('topic-icons-picker__opt--unavailable');
						const badge = document.createElement('span');
						badge.className = 'topic-icons-picker__badge badge text-bg-warning';
						badge.textContent = s['picker-unavailable'];
						b.appendChild(badge);
					}
					b.addEventListener('click', function () {
						current = o.id;
						sync();
					});
					grid.appendChild(b);
				});
				if (!choices.icons.length) {
					const empty = document.createElement('p');
					empty.className = 'text-muted mb-0';
					empty.textContent = s['picker-empty'];
					grid.appendChild(empty);
				}
				// Arrow keys, Home and End move the selection, as in a native radio group.
				grid.addEventListener('keydown', function (ev) {
					const radios = Array.prototype.slice.call(grid.querySelectorAll('[role="radio"]'));
					const idx = radios.indexOf(document.activeElement);
					if (idx === -1) return;
					const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
					let next;
					if (ev.key === 'Home') next = radios[0];
					else if (ev.key === 'End') next = radios[radios.length - 1];
					else if (step) next = radios[(idx + step + radios.length) % radios.length];
					if (!next) return;
					ev.preventDefault();
					current = next.getAttribute('data-id');
					sync();
					next.focus();
				});

				const dialog = bootbox.dialog({
					title: $('<div>').text(s['picker-title']).html(),
					message: '<div class="topic-icons-picker-mount"></div>',
					className: 'topic-icons-modal',
					onEscape: true,
					buttons: {
						cancel: { label: $('<div>').text(s['picker-cancel']).html(), className: 'btn-light' },
						ok: {
							label: $('<div>').text(s['picker-select']).html(),
							className: 'btn-primary topic-icons-picker__ok',
							callback: function () {
								// The current icon that is no longer offered cannot be confirmed.
								if (isUnavailable(choices, current)) return false;
								state.choice = current;
								updateButton(postData);
								rememberInDraft(postData);
							},
						},
					},
				});
				dialog.find('.topic-icons-picker-mount').append(body);
				okButton = dialog.find('.topic-icons-picker__ok');
				sync();
				state.button.setAttribute('aria-expanded', 'true');
				dialog.on('shown.bs.modal', function () {
					state.opening = false;
					const checked = grid.querySelector('[aria-checked="true"]');
					if (checked) checked.focus();
				});
				dialog.on('hidden.bs.modal', function () {
					state.opening = false;
					state.button.setAttribute('aria-expanded', 'false');
					// Dialogs created by bootbox do not give the focus back.
					if (document.body.contains(state.button)) state.button.focus();
				});
			});
		}).catch(function () {
			state.opening = false;
		});
	}

	/**
	 * Adds the picker button to a composer for a new topic or for the first post being edited.
	 *
	 * @param {{postContainer: jQuery, postData: object}} data payload of action:composer.enhanced
	 * @returns {void}
	 */
	function onComposer(data) {
		const postData = data && data.postData;
		const postContainer = data && data.postContainer;
		if (!postData || !postContainer || !postContainer.length) return;
		const isNew = postData.action === 'topics.post';
		const isEdit = postData.action === 'posts.edit' && !!postData.isMain;
		if (!isNew && !isEdit) return;
		if (postContainer.find('[component="topic-icons/pick"]').length) return;
		const titleBox = postContainer.find('[data-component="composer/title"]');
		if (!titleBox.length) return;

		postData.topicIcons = postData.topicIcons || { choice: pickFromDraft(postData) };
		const state = postData.topicIcons;
		state.isEdit = isEdit;
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'btn btn-light topic-icons-btn hidden';
		btn.setAttribute('component', 'topic-icons/pick');
		btn.setAttribute('aria-haspopup', 'dialog');
		btn.setAttribute('aria-expanded', 'false');
		btn.innerHTML = '<span class="topic-icons-btn__visual" aria-hidden="true"></span><span class="topic-icons-btn__label d-none d-xl-inline"></span>';
		btn.addEventListener('click', function () { openPicker(postData, postContainer); });
		titleBox.before(btn);
		state.button = btn;
		refresh(postData);
	}

	/**
	 * Themes without their own slot: puts the icon of each listed topic in front of its title,
	 * using the data the page (or the infinite-scroll batch) was rendered from.
	 *
	 * @param {Array<object>} [list] topics with topicIcon
	 * @returns {void}
	 */
	function decorateList(list) {
		const byTid = {};
		(list || []).forEach(function (t) {
			if (t && t.tid && t.topicIcon && t.topicIcon.html) byTid[t.tid] = t.topicIcon.html;
		});
		document.querySelectorAll('[component="category/topic"][data-tid]').forEach(function (li) {
			const html = byTid[li.getAttribute('data-tid')];
			if (!html || li.querySelector('.topic-icon')) return;
			const header = li.querySelector('[component="topic/header"]');
			if (!header) return;
			const wrap = document.createElement('span');
			wrap.className = 'topic-icons-inline';
			wrap.innerHTML = html; // server-built, admin input escaped
			header.prepend(wrap);
		});
	}

	/**
	 * Icons in topic lists rendered in another language than the viewer's (lists that came from
	 * an API route, which does not know a guest's language) are fetched again in the right one.
	 *
	 * @returns {void}
	 */
	function relocalizeList() {
		const lang = window.config && config.userLang;
		if (!lang) return;
		const stale = {};
		document.querySelectorAll('[component="category/topic"][data-tid] .topic-icon[data-ti-lang]').forEach(function (el) {
			const elLang = el.getAttribute('data-ti-lang');
			if (elLang && elLang !== lang) {
				const tid = el.closest('[data-tid]').getAttribute('data-tid');
				(stale[tid] = stale[tid] || []).push(el);
			}
		});
		const tids = Object.keys(stale).slice(0, 100);
		if (!tids.length) return;
		Promise.all([apiGet('/plugins/topic-icons/icons', { tids: tids.join(','), lang: lang }), lib()]).then(function (results) {
			const found = (results[0] && results[0].icons) || {};
			const I = results[1];
			tids.forEach(function (tid) {
				const icon = found[tid];
				if (!icon) return;
				stale[tid].forEach(function (el) {
					if (!el.parentNode) return;
					// Built from the icon data with DOM methods; the HTML in the response is not used.
					const fresh = I.buildElement(document, icon, { lang: lang });
					if (fresh) el.replaceWith(fresh);
				});
			});
		}, function () {
			// The icons stay in the language they were rendered in.
		});
	}

	/**
	 * Topic page: puts the icon in front of the title, unless the theme already shows it.
	 *
	 * @returns {void}
	 */
	function decorateTopic() {
		const data = window.ajaxify && ajaxify.data;
		if (!data || !data.topicIcon || !data.topicIcon.html) return;
		const title = document.querySelector('[component="topic/title"]');
		if (!title || !title.parentNode || title.parentNode.querySelector('.topic-icon')) return;
		const wrap = document.createElement('span');
		wrap.className = 'topic-icons-inline topic-icons-inline--header';
		wrap.innerHTML = data.topicIcon.html; // server-built, admin input escaped
		title.before(wrap);
	}

	/**
	 * Gives topic thumbnails the topic title as alt text (themes based on Harmony print alt="").
	 * The title is set as text through the DOM, never parsed as HTML.
	 *
	 * @returns {void}
	 */
	function describeThumbs() {
		document.querySelectorAll('[component="category/topic"][data-tid]').forEach(function (li) {
			const img = li.querySelector('.topic-thumbs img');
			if (!img || img.getAttribute('alt')) return;
			const link = li.querySelector('[component="topic/header"] a');
			const title = link ? link.textContent.trim() : '';
			if (title) img.alt = title;
			img.decoding = 'async';
		});
		const data = window.ajaxify && ajaxify.data;
		const title = data && data.tid && (data.titleRaw || data.title);
		if (!title) return;
		require(['topic-icons/icons'], function (I) {
			document.querySelectorAll('[component="topic/thumb/list"] img').forEach(function (img) {
				if (!img.getAttribute('alt')) img.alt = I.decodeEntities(String(title));
				img.decoding = 'async';
			});
		});
	}

	if (window.jQuery) {
		const $w = window.jQuery(window);
		$w.on('action:ajaxify.end', function () {
			decorateList(window.ajaxify && ajaxify.data && ajaxify.data.topics);
			decorateTopic();
			relocalizeList();
			describeThumbs();
		});
		$w.on('action:topics.loaded', function (ev, data) {
			decorateList(data && data.topics);
			relocalizeList();
			describeThumbs();
		});
		$w.on('action:composer.changeCategory', function (ev, data) {
			if (data && data.postData && data.postData.topicIcons) refresh(data.postData);
		});
	}

	require(['hooks'], function (hooks) {
		hooks.on('action:composer.enhanced', onComposer);
		hooks.on('filter:composer.submit', function (payload) {
			const postData = payload && payload.postData;
			const state = postData && postData.topicIcons;
			if (!state || state.choice === undefined) return payload;
			if (payload.action !== 'topics.post' && payload.action !== 'posts.edit') return payload;
			// Editing without a change sends nothing, so the icon cannot fail the edit.
			if (payload.action === 'posts.edit' && state.choices && state.choice === state.choices.current) return payload;
			payload.composerData.iconId = state.choice;
			return payload;
		});
		hooks.on('filter:composer.drafts.save', function (payload) {
			const state = payload && payload.postData && payload.postData.topicIcons;
			if (state && state.choice !== undefined && payload.draft) payload.draft.topicIconId = state.choice;
			return payload;
		});
	});
}());
