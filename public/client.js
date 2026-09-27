'use strict';

/*
 * nodebb-plugin-topic-icons: forum-side script, bundled into NodeBB's client JS through
 * "scripts" in plugin.json (runs on every forum page, not in the ACP).
 *
 * 1. Composer (nodebb-plugin-composer-default): a "Choose icon" button next to the title of a
 *    new topic or of the first post being edited. It opens a grid of the icons offered in the
 *    selected category (GET /api/v3/plugins/topic-icons/choices) with a preview of the topic
 *    row. The choice is sent with the post as `iconId` (filter:composer.submit) and validated by
 *    the server; nothing here is trusted.
 * 2. Themes without a slot for the icon: the server-rendered icon (topic.topicIcon.html) is put
 *    in front of the topic title in topic lists and in the topic header. Themes that print
 *    {{./topicIcon.html}} themselves are left alone.
 *
 * Icon names are inserted with textContent or come escaped from the server, so no text typed by
 * an admin is ever parsed as HTML or as a translation token.
 */
(function () {
	const NS = 'topic-icons';

	/**
	 * @param {Array<string>} keys keys of the forum namespace
	 * @returns {Promise<Object<string, string>>} key → translated text
	 */
	function strings(keys) {
		return new Promise(function (resolve) {
			require(['translator'], function (translator) {
				Promise.all(keys.map(function (k) { return translator.translate('[[' + NS + ':' + k + ']]'); })).then(function (list) {
					const out = {};
					keys.forEach(function (k, i) { out[k] = $('<div>').html(list[i]).text(); });
					resolve(out);
				});
			});
		});
	}

	/**
	 * @param {{cid?: number|string, tid?: number|string}} params
	 * @returns {Promise<object>} response of the choices route
	 */
	function loadChoices(params) {
		return new Promise(function (resolve, reject) {
			require(['api'], function (api) {
				api.get('/plugins/topic-icons/choices', params).then(resolve, reject);
			});
		});
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
	 * @returns {object|null} icon { id, name, url } offered for that id
	 */
	function findChoice(choices, id) {
		if (!id) return null;
		const list = choices.icons.concat(choices.currentIcon ? [choices.currentIcon] : []);
		return list.find(function (i) { return i.id === id; }) || null;
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
		if (!btn || !choices) return;
		btn.classList.toggle('hidden', !choices.canChoose);
		const chosen = findChoice(choices, selectedId(postData));
		const shown = chosen || choices.defaultIcon;
		const visual = btn.querySelector('.topic-icons-btn__visual');
		visual.textContent = '';
		if (shown) {
			const image = img(shown.url, '');
			visual.appendChild(image);
			visual.classList.toggle('topic-icons-btn__visual--default', !chosen);
		} else {
			const i = document.createElement('i');
			i.className = 'fa fa-image';
			i.setAttribute('aria-hidden', 'true');
			visual.appendChild(i);
		}
		strings(['choose', 'choose-current']).then(function (s) {
			const text = chosen ? s['choose-current'].replace('%1', chosen.name) : s.choose;
			btn.setAttribute('title', text);
			btn.setAttribute('aria-label', text);
			btn.querySelector('.topic-icons-btn__label').textContent = s.choose;
		});
	}

	/**
	 * (Re)loads the icons for the composer's category or topic.
	 *
	 * @param {object} postData
	 * @returns {void}
	 */
	function refresh(postData) {
		const state = postData.topicIcons;
		const params = state.isEdit ? { tid: postData.tid } : { cid: postData.cid };
		if (!params.tid && !params.cid) {
			if (state.button) state.button.classList.add('hidden');
			return;
		}
		loadChoices(params).then(function (choices) {
			state.choices = choices;
			// A pick that the new category does not offer is dropped.
			if (state.choice && !findChoice(choices, state.choice)) state.choice = undefined;
			updateButton(postData);
		}, function () {
			if (state.button) state.button.classList.add('hidden');
		});
	}

	/**
	 * Row preview in the picker: icon, the title typed in the composer, the user and "just now".
	 *
	 * @param {HTMLElement} box preview container
	 * @param {object|null} icon
	 * @param {boolean} isDefault
	 * @param {string} title
	 * @param {object} s translated strings
	 * @returns {void}
	 */
	function renderPreview(box, icon, isDefault, title, s) {
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
		meta.textContent = ((window.app && window.app.user && window.app.user.username) || '') + ' • ' + s['picker-just-now'];
		text.appendChild(t);
		text.appendChild(meta);
		row.appendChild(text);
		box.appendChild(row);
	}

	/**
	 * Opens the picker dialog for a composer.
	 *
	 * @param {object} postData
	 * @param {jQuery} postContainer
	 * @returns {void}
	 */
	function openPicker(postData, postContainer) {
		const state = postData.topicIcons;
		const choices = state.choices;
		if (!choices || !choices.canChoose) return;
		const keys = ['picker-title', 'picker-help', 'picker-none', 'picker-default', 'picker-preview', 'picker-preview-title',
			'picker-just-now', 'picker-empty', 'picker-cancel', 'picker-select'];
		strings(keys).then(function (s) {
			require(['bootbox'], function (bootbox) {
				let current = selectedId(postData);
				const body = document.createElement('div');
				body.className = 'topic-icons-picker';
				const help = document.createElement('p');
				help.className = 'form-text mt-0';
				help.textContent = s['picker-help'];
				const grid = document.createElement('div');
				grid.className = 'topic-icons-picker__grid';
				grid.setAttribute('role', 'radiogroup');
				grid.setAttribute('aria-label', s['picker-title']);
				const previewLabel = document.createElement('div');
				previewLabel.className = 'fw-semibold text-sm mt-3 mb-1';
				previewLabel.textContent = s['picker-preview'];
				const preview = document.createElement('div');
				body.appendChild(help);
				body.appendChild(grid);
				body.appendChild(previewLabel);
				body.appendChild(preview);

				const title = String(postContainer.find('input.title').val() || '').trim();
				const options = [{ id: '', name: choices.defaultIcon ? s['picker-default'] : s['picker-none'], url: choices.defaultIcon && choices.defaultIcon.url }]
					.concat(choices.currentIcon ? [choices.currentIcon] : [])
					.concat(choices.icons);

				/** @returns {void} */
				function sync() {
					grid.querySelectorAll('[role="radio"]').forEach(function (b) {
						const on = b.getAttribute('data-id') === current;
						b.setAttribute('aria-checked', on ? 'true' : 'false');
						b.tabIndex = on ? 0 : -1;
					});
					const icon = current ? findChoice(choices, current) : choices.defaultIcon;
					renderPreview(preview, icon, !current, title, s);
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
				// Arrow keys move the selection, as in a native radio group.
				grid.addEventListener('keydown', function (ev) {
					const radios = Array.prototype.slice.call(grid.querySelectorAll('[role="radio"]'));
					const idx = radios.indexOf(document.activeElement);
					if (idx === -1) return;
					const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
					if (!step) return;
					ev.preventDefault();
					const next = radios[(idx + step + radios.length) % radios.length];
					current = next.getAttribute('data-id');
					sync();
					next.focus();
				});
				sync();

				const dialog = bootbox.dialog({
					title: $('<div>').text(s['picker-title']).html(),
					message: '<div class="topic-icons-picker-mount"></div>',
					className: 'topic-icons-modal',
					onEscape: true,
					buttons: {
						cancel: { label: $('<div>').text(s['picker-cancel']).html(), className: 'btn-light' },
						ok: {
							label: $('<div>').text(s['picker-select']).html(),
							className: 'btn-primary',
							callback: function () {
								state.choice = current;
								updateButton(postData);
							},
						},
					},
				});
				dialog.find('.topic-icons-picker-mount').append(body);
				dialog.on('shown.bs.modal', function () {
					const checked = grid.querySelector('[aria-checked="true"]');
					if (checked) checked.focus();
				});
			});
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

		postData.topicIcons = postData.topicIcons || { choice: undefined };
		const state = postData.topicIcons;
		state.isEdit = isEdit;
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'btn btn-light topic-icons-btn hidden';
		btn.setAttribute('component', 'topic-icons/pick');
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

	if (window.jQuery) {
		const $w = window.jQuery(window);
		$w.on('action:ajaxify.end', function () {
			decorateList(window.ajaxify && ajaxify.data && ajaxify.data.topics);
			decorateTopic();
		});
		$w.on('action:topics.loaded', function (ev, data) {
			decorateList(data && data.topics);
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
			if (state && state.choice !== undefined && (payload.action === 'topics.post' || payload.action === 'posts.edit')) {
				payload.composerData.iconId = state.choice;
			}
			return payload;
		});
	});
}());
