'use strict';

/*
 * ACP page script for nodebb-plugin-topic-icons (ACP → Plugins → Topic icons).
 * Registered in plugin.json under "modules" and loaded by NodeBB for
 * templates/admin/plugins/topic-icons.tpl. Strings are translation keys of the
 * "admin/plugins/topic-icons" namespace.
 *
 * The library (`library`) and the category defaults (`catDefaults`) are edited in memory and
 * serialised as JSON into hidden inputs, which NodeBB's settings module saves together with the
 * other fields. Validation comes from lib/icons.js, the same module the server uses (exposed to
 * the browser as "topic-icons/icons" through plugin.json); the server checks everything again
 * when the settings are saved (library.js onSettingsSave).
 * Category covers (`catCovers`) are kept the same way and checked with lib/covers.js
 * ("topic-icons/covers").
 * ajaxify.data.defaults, categoryList (tree order, with depth), groupList, maxUploadKb,
 * maxCoverKb, coverState (cover switches as the server applies them) and canUpload come from the
 * route in library.js.
 */
define('admin/plugins/topic-icons', ['settings', 'alerts', 'translator', 'bootbox', 'topic-icons/icons', 'topic-icons/covers'], function (Settings, alerts, translator, bootbox, I, C) {
	const ACP = {};
	const HASH = 'topic-icons';
	const NS = 'admin/plugins/topic-icons';
	/** Placeholder replaced by an escaped name after translation (see message()). */
	const ARG = '@@ti-arg@@';

	/** Library being edited (normalised icons, see lib/icons.js). */
	let library = [];
	/** Category defaults being edited: cid → icon id. */
	let catDefaults = {};
	/** Category covers being edited: cid → image URL. */
	let catCovers = {};
	/** False until the stored settings were read; saving is refused before that. */
	let loaded = false;

	/**
	 * Marks the page as changed, so that NodeBB asks before navigating away without saving.
	 *
	 * @param {boolean} value
	 * @returns {void}
	 */
	function setUnsaved(value) {
		if (!window.app) return;
		app.flags = app.flags || {};
		app.flags._unsaved = !!value;
	}

	/**
	 * Escapes text for element content and double-quoted attributes. Square brackets are encoded
	 * too, so that no stored text can become a translation token when the markup is translated.
	 */
	const esc = I.escape;
	/** Translated (HTML-escaped) text → plain text; a string operation, nothing is parsed as HTML. */
	const plain = I.decodeEntities;

	/**
	 * @param {string} text markup with translation tokens
	 * @returns {Promise<string>} translated markup
	 */
	function translate(text) {
		return new Promise(function (resolve) {
			translator.translate(text, resolve);
		});
	}

	/**
	 * @param {object} c category from ajaxify.data.categoryList
	 * @returns {string} escaped name, indented by its depth in the category tree
	 */
	function categoryLabel(c) {
		const depth = Math.min(parseInt(c.depth, 10) || 0, 10);
		return (depth ? '\u2003'.repeat(depth) + '\u2514 ' : '') + esc(c.name);
	}

	/**
	 * @param {string} key
	 * @param {...(string|number)} args numbers or placeholders only
	 * @returns {string} translation token of the ACP namespace
	 */
	function tx(key) {
		return translator.compile.apply(null, [NS + ':' + key].concat(Array.prototype.slice.call(arguments, 1)));
	}

	/**
	 * Translated message with an optional admin-typed argument, escaped and inserted after
	 * translation, so it is never read as a translation token.
	 *
	 * @param {string} key
	 * @param {string} [arg] plain text
	 * @returns {Promise<string>} HTML
	 */
	function message(key, arg) {
		return translator.translate(arg === undefined ? tx(key) : tx(key, ARG)).then(function (html) {
			return arg === undefined ? html : html.split(ARG).join(esc(arg));
		});
	}

	/**
	 * @param {object} icon
	 * @returns {string} token or escaped text to show for an icon in selects and dialogs
	 */
	function label(icon) {
		if (icon.name) return esc(icon.name);
		return icon.key ? '[[topic-icons:icon.' + icon.key + ']]' : esc(icon.id);
	}

	/**
	 * @param {string} url stored URL
	 * @returns {string} URL for a preview (with relative_path)
	 */
	function previewUrl(url) {
		return I.withRelativePath(I.cleanUrl(url), config.relative_path || '');
	}

	/**
	 * Site-relative path as stored (without relative_path), from a URL that may carry the prefix.
	 *
	 * @param {string} url
	 * @returns {string}
	 */
	function stripRelativePath(url) {
		const rp = config.relative_path || '';
		return rp && url.indexOf(rp + '/') === 0 ? url.slice(rp.length) : url;
	}

	/**
	 * @param {object} icon
	 * @param {number} i row index
	 * @returns {string} HTML of one library row
	 */
	function rowHtml(icon, i) {
		const src = previewUrl(icon.url);
		const cats = (ajaxify.data.categoryList || []).map(function (c) {
			const selected = icon.cids.indexOf(parseInt(c.cid, 10)) !== -1 ? ' selected' : '';
			return '<option value="' + esc(c.cid) + '"' + selected + '>' + categoryLabel(c) + '</option>';
		}).join('');
		const placeholder = icon.key ? '[[topic-icons:icon.' + icon.key + ']]' : tx('name-placeholder');
		return '<tr data-i="' + i + '">' +
			'<td>' + (src ? '<img class="topic-icons-acp__img" src="' + esc(src) + '" alt="" width="40" height="40" referrerpolicy="no-referrer">' : '<span class="topic-icons-acp__img d-inline-block bg-light"></span>') + '</td>' +
			'<td style="min-width:12rem"><input type="text" class="form-control form-control-sm" maxlength="' + I.MAX_NAME + '" data-field="name" value="' + esc(icon.name) + '" placeholder="' + placeholder + '"></td>' +
			'<td style="min-width:16rem"><div class="input-group input-group-sm">' +
				'<input type="text" class="form-control" data-field="url" value="' + esc(icon.url) + '" placeholder="/assets/uploads/… or https://…">' +
				(ajaxify.data.canUpload ? '<button type="button" class="btn btn-light" data-ti-action="upload" title="' + tx('upload') + '" aria-label="' + tx('upload') + '"><i class="fa fa-upload"></i></button>' : '') + '</div></td>' +
			'<td style="min-width:12rem"><select multiple class="form-select form-select-sm" size="3" data-field="cids" aria-label="' + tx('col-categories') + '" title="' + tx('all-categories') + '">' + cats + '</select></td>' +
			'<td class="text-center"><input type="checkbox" class="form-check-input" data-field="active"' + (icon.active ? ' checked' : '') + ' aria-label="' + tx('col-active') + '"></td>' +
			'<td><div class="btn-group btn-group-sm">' +
				'<button type="button" class="btn btn-light" data-ti-action="up"' + (i === 0 ? ' disabled' : '') + ' title="' + tx('up') + '" aria-label="' + tx('up') + '"><i class="fa fa-arrow-up"></i></button>' +
				'<button type="button" class="btn btn-light" data-ti-action="down"' + (i === library.length - 1 ? ' disabled' : '') + ' title="' + tx('down') + '" aria-label="' + tx('down') + '"><i class="fa fa-arrow-down"></i></button>' +
				'<button type="button" class="btn btn-light text-danger" data-ti-action="remove" title="' + tx('remove') + '" aria-label="' + tx('remove') + '"><i class="fa fa-trash"></i></button>' +
			'</div></td></tr>';
	}

	/**
	 * @param {string} selected icon id
	 * @param {string} emptyLabel token of the "no icon" option
	 * @returns {string} options of an icon select
	 */
	function iconOptions(selected, emptyLabel) {
		return '<option value="">' + tx(emptyLabel) + '</option>' + library.map(function (icon) {
			return '<option value="' + esc(icon.id) + '"' + (icon.id === selected ? ' selected' : '') + '>' + label(icon) + '</option>';
		}).join('');
	}

	/**
	 * @param {string} url stored cover URL
	 * @returns {string} URL for a preview (with relative_path), or '' when it is not valid
	 */
	function coverPreviewUrl(url) {
		return I.withRelativePath(C.cleanAdminUrl(url), config.relative_path || '');
	}

	/**
	 * @param {object} c category from ajaxify.data.categoryList
	 * @returns {string} HTML of the cover cell of a category row: preview, URL field, upload and
	 *   clear buttons
	 */
	function coverCell(c) {
		const url = catCovers[c.cid] || '';
		const src = coverPreviewUrl(url);
		return '<td style="min-width:20rem"><div class="d-flex align-items-center gap-2">' +
			(src ? '<img class="topic-icons-acp__cover" src="' + esc(src) + '" alt="" width="64" height="48" loading="lazy" referrerpolicy="no-referrer">' : '<span class="topic-icons-acp__cover d-inline-block"></span>') +
			'<div class="input-group input-group-sm flex-nowrap">' +
				'<input type="text" class="form-control" data-cover-cid="' + esc(c.cid) + '" value="' + esc(url) + '" placeholder="/assets/uploads/… or https://…" aria-label="' + tx('col-cover') + ': ' + esc(c.name) + '">' +
				(ajaxify.data.canUpload ? '<button type="button" class="btn btn-light" data-ti-action="cover-upload" title="' + tx('cover-upload') + '" aria-label="' + tx('cover-upload') + '"><i class="fa fa-upload"></i></button>' : '') +
				'<button type="button" class="btn btn-light text-danger" data-ti-action="cover-clear"' + (url ? '' : ' disabled') + ' title="' + tx('cover-clear') + '" aria-label="' + tx('cover-clear') + '"><i class="fa fa-xmark"></i></button>' +
			'</div></div></td>';
	}

	/**
	 * Re-renders the library, the default selects and the category table. Called after every
	 * structural change; plain typing only updates the model. The markup contains translation
	 * tokens, so it is translated before insertion (all stored text is escaped by esc()).
	 *
	 * @returns {Promise<void>} resolved once the new markup is in the page
	 */
	function render() {
		$('#ti-empty').toggleClass('d-none', library.length > 0);
		const rows = (ajaxify.data.categoryList || []).map(function (c) {
			const depth = Math.min(parseInt(c.depth, 10) || 0, 10);
			return '<tr data-cid="' + esc(c.cid) + '"><td><span class="topic-icons-acp__cat d-inline-block" style="--ti-depth:' + depth + '">' + esc(c.name) + '</span></td>' +
				'<td><select class="form-select form-select-sm" data-cid="' + esc(c.cid) + '" style="max-width:20rem" aria-label="' + esc(c.name) + '">' +
				iconOptions(catDefaults[c.cid] || '', 'default-inherit') + '</select></td>' +
				coverCell(c) + '</tr>';
		}).join('');
		return Promise.all([
			translate(library.map(rowHtml).join('')),
			translate(iconOptions($('#ti-default').val(), 'default-none')),
			translate(rows),
		]).then(function (html) {
			$('#ti-library tbody').html(html[0]);
			$('#ti-default-select').html(html[1]);
			$('#ti-cat-defaults tbody').html(html[2]);
			renderChecks();
		});
	}

	/**
	 * Writes the edited state into the hidden inputs that the settings module saves. Defaults
	 * that point to removed icons are dropped.
	 *
	 * @returns {void}
	 */
	function syncHidden() {
		const ids = library.map(function (icon) { return icon.id; });
		Object.keys(catDefaults).forEach(function (cid) {
			if (ids.indexOf(catDefaults[cid]) === -1) delete catDefaults[cid];
		});
		if (ids.indexOf($('#ti-default').val()) === -1) $('#ti-default').val('');
		$('#ti-icons-json').val(JSON.stringify(library));
		$('#ti-cat-json').val(JSON.stringify(catDefaults));
		$('#ti-covers-json').val(JSON.stringify(catCovers));
		$('#ti-group').val($('#ti-chooser-group').val() || '');
	}

	/**
	 * @param {string} name group name
	 * @returns {boolean} whether the group is one of the groups listed by the server
	 */
	function groupListed(name) {
		return (ajaxify.data.groupList || []).indexOf(name) !== -1;
	}

	/**
	 * @returns {{errors: string[], settings: object}} same checks as the server
	 */
	function validate() {
		syncHidden();
		const group = $('#ti-group').val();
		const result = I.validateSettings({
			chooser: $('#ti-chooser').val(),
			chooserGroup: group,
			defaultIcon: $('#ti-default').val(),
			categoryDefaults: $('#ti-cat-json').val(),
			icons: $('#ti-icons-json').val(),
		}, { groupExists: group ? groupListed(group) : undefined });
		const coverResult = C.validateSettings({
			coverRatio: $('#ti-coverRatio').val(),
			categoryCovers: $('#ti-covers-json').val(),
		});
		result.errors = result.errors.concat(coverResult.errors);
		result.settings.categoryCovers = coverResult.settings.categoryCovers;
		return result;
	}

	/**
	 * Shows validation errors under the tables and marks invalid image fields (of the rows in
	 * the page, so call it after render() has put them there).
	 *
	 * @returns {void}
	 */
	function renderChecks() {
		$('#ti-group-wrap').toggleClass('opacity-50', $('#ti-chooser').val() !== 'group');
		$('#ti-library [data-field="url"]').each(function () {
			$(this).toggleClass('is-invalid', !I.cleanUrl($(this).val()));
		});
		$('#ti-cat-defaults [data-cover-cid]').each(function () {
			const value = $(this).val().trim();
			$(this).toggleClass('is-invalid', !!value && !C.cleanAdminUrl(value));
		});
		$('#ti-coverExternal').prop('disabled', !$('#ti-coverAuto').is(':checked'));
		$('#ti-coverPhones').prop('disabled', !$('#ti-coverStyle').is(':checked'));
		Promise.all(validate().errors.map(function (token) { return translator.translate(token); })).then(function (list) {
			$('#ti-checks ul').html(list.map(function (html) { return '<li class="alert alert-danger py-2 mb-0">' + html + '</li>'; }).join(''));
			$('#ti-checks').toggleClass('d-none', !list.length);
		});
	}

	/**
	 * Delegated input handler for library fields: updates the model without re-rendering, so the
	 * focused field keeps its cursor.
	 *
	 * @this {HTMLElement}
	 * @returns {void}
	 */
	function onInput() {
		const el = $(this);
		const icon = library[parseInt(el.closest('tr').attr('data-i'), 10)];
		if (!icon) return;
		const field = el.attr('data-field');
		if (field === 'active') icon.active = el.is(':checked');
		else if (field === 'cids') icon.cids = I.cleanCids(el.val() || []);
		else if (field === 'url') {
			icon.url = el.val().trim();
			const src = previewUrl(icon.url);
			el.closest('tr').find('img.topic-icons-acp__img').attr('src', src || '');
		} else icon.name = el.val();
		setUnsaved(true);
		renderChecks();
	}

	/** Upload kinds: route, accepted files and limits. */
	const UPLOADS = {
		icon: {
			route: '/upload',
			accept: '.png,.webp,.svg,image/png,image/webp,image/svg+xml',
			ext: /\.(png|webp|svg)$/i,
			typeKey: 'upload-type',
			maxKb: function () { return ajaxify.data.maxUploadKb; },
		},
		cover: {
			route: '/upload-cover',
			accept: '.png,.jpg,.jpeg,.webp,.gif,.svg,image/png,image/jpeg,image/webp,image/gif,image/svg+xml',
			ext: /\.(png|jpe?g|webp|gif|svg)$/i,
			typeKey: 'cover-upload-type',
			maxKb: function () { return ajaxify.data.maxCoverKb; },
		},
	};

	/**
	 * Picks an image and uploads it through the plugin's ACP route (administrators only, CSRF
	 * token of the session). The server checks type, content and size again and stores the file
	 * under a new unique name.
	 *
	 * @param {string} kind "icon" or "cover" (see UPLOADS)
	 * @param {function(string): void} done gets the stored URL (without relative_path)
	 * @returns {void}
	 */
	function upload(kind, done) {
		const opts = UPLOADS[kind];
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = opts.accept;
		input.addEventListener('change', function () {
			const file = input.files && input.files[0];
			if (!file) return;
			if (!opts.ext.test(file.name)) {
				alerts.error(tx(opts.typeKey));
				return;
			}
			if (file.size > opts.maxKb() * 1024) {
				alerts.error(tx('upload-size', opts.maxKb()));
				return;
			}
			const body = new FormData();
			body.append('file', file, file.name);
			fetch(config.relative_path + '/api/admin/plugins/topic-icons' + opts.route, {
				method: 'POST',
				body: body,
				credentials: 'same-origin',
				headers: { 'x-csrf-token': config.csrf_token },
			}).then(function (res) {
				return res.json().catch(function () { return {}; }).then(function (data) {
					if (!res.ok || !data || !data.url) throw new Error((data && data.error) || res.status + ' ' + res.statusText);
					return data.url;
				});
			}).then(function (url) {
				done(stripRelativePath(url));
				syncHidden();
				setUnsaved(true);
				render();
				alerts.success(tx('uploaded'));
			}).catch(function (err) {
				translator.translate(String(err.message || err), function (reason) {
					message('upload-failed', plain(reason)).then(function (html) { alerts.error(html); });
				});
			});
		});
		input.click();
	}

	/**
	 * Delegated click handler for every [data-ti-action] button.
	 *
	 * @this {HTMLElement}
	 * @returns {void}
	 */
	function onAction() {
		const btn = $(this);
		const action = btn.attr('data-ti-action');
		const i = parseInt(btn.closest('tr').attr('data-i'), 10);
		if (action === 'add') {
			const id = 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
			library.push({ id: id, key: '', name: '', url: '', cids: [], active: true });
			setUnsaved(true);
			render().then(function () {
				$('#ti-library tbody tr').last().find('[data-field="name"]').trigger('focus');
			});
			return;
		}
		if (action === 'restore') {
			translator.translate(tx('confirm-restore'), function (text) {
				bootbox.confirm(text, function (ok) {
					if (!ok) return;
					I.builtinIcons().forEach(function (icon) {
						if (!library.some(function (e) { return e.id === icon.id; })) library.push(icon);
					});
					setUnsaved(true);
					render();
					alerts.info(tx('restored'));
				});
			});
			return;
		}
		if (action === 'cover-upload' || action === 'cover-clear') {
			const cid = btn.closest('tr').attr('data-cid');
			if (!cid) return;
			if (action === 'cover-clear') {
				delete catCovers[cid];
				setUnsaved(true);
				render().then(function () {
					$('#ti-cat-defaults [data-cover-cid="' + cid + '"]').trigger('focus');
				});
			} else {
				upload('cover', function (url) { catCovers[cid] = url; });
			}
			return;
		}
		if (!library[i]) return;
		if (action === 'upload') {
			const icon = library[i];
			upload('icon', function (url) { icon.url = url; });
		} else if (action === 'up' && i > 0) {
			library.splice(i - 1, 0, library.splice(i, 1)[0]);
			setUnsaved(true);
			render().then(function () { focusRowButton(i - 1, 'up'); });
		} else if (action === 'down' && i < library.length - 1) {
			library.splice(i + 1, 0, library.splice(i, 1)[0]);
			setUnsaved(true);
			render().then(function () { focusRowButton(i + 1, 'down'); });
		} else if (action === 'remove') {
			translator.translate(label(library[i]), function (name) {
				message('confirm-remove', plain(name)).then(function (html) {
					bootbox.confirm(html, function (ok) {
						if (!ok) return;
						library.splice(i, 1);
						setUnsaved(true);
						render().then(function () {
							const rows = $('#ti-library tbody tr');
							if (rows.length) rows.eq(Math.min(i, rows.length - 1)).find('[data-field="name"]').trigger('focus');
							else $('[data-ti-action="add"]').trigger('focus');
						});
					});
				});
			});
		}
	}

	/**
	 * Keeps the keyboard on the moved row: focuses its move button again (or the other one when
	 * the row reached the top or bottom).
	 *
	 * @param {number} index row index after the move
	 * @param {string} action "up" or "down"
	 * @returns {void}
	 */
	function focusRowButton(index, action) {
		const row = $('#ti-library tbody tr').eq(index);
		const btn = row.find('[data-ti-action="' + action + '"]');
		(btn.prop('disabled') ? row.find('[data-ti-action="' + (action === 'up' ? 'down' : 'up') + '"]') : btn).trigger('focus');
	}

	/**
	 * Page entry point, called by NodeBB when the ACP page is loaded.
	 *
	 * @returns {void}
	 */
	/**
	 * "Check for updates" switch (lib/update-check.js): its own settings hash, saved when changed,
	 * independent of the main form and its Save button.
	 */
	function initUpdateCheck() {
		const updateForm = $('.wl-update-check');
		const updateHash = updateForm.attr('data-hash');
		if (!updateHash) {
			return;
		}
		Settings.load(updateHash, updateForm, function (err, values) {
			// deserialize() never unchecks a box, so apply a saved "off" here
			if (!err && values) {
				updateForm.find('[name="checkUpdates"]').prop('checked', !['off', 'false', '0'].includes(String(values.checkUpdates)));
			}
		});
		updateForm.on('change', 'input', function () {
			Settings.save(updateHash, updateForm, function (err) {
				if (err) {
					alerts.error(err);
				} else {
					alerts.success('[[admin/plugins/topic-icons:update.saved]]');
				}
			});
		});
	}

	ACP.init = function () {
		initUpdateCheck();
		const form = $('.topic-icons-settings');
		$('#ti-chooser-group').append((ajaxify.data.groupList || []).map(function (name) {
			return '<option value="' + esc(name) + '">' + esc(name) + '</option>';
		}).join(''));

		Settings.load(HASH, form, function (err) {
			if (err) {
				// Letting Save through would overwrite the stored settings with an empty page.
				$('#save').prop('disabled', true);
				translator.translate(String(err.message || err), function (reason) {
					message('load-error', plain(reason)).then(function (html) { alerts.error(html, 0); });
				});
				return;
			}
			const d = ajaxify.data.defaults || {};
			const neverSaved = !$('#ti-icons-json').val();
			if (neverSaved) {
				// Unset switches default to on, as on the server (lib/icons.js normalize).
				$('#ti-showInList, #ti-showInTopic').prop('checked', true);
			}
			// Same clean-up as on the server: invalid entries and defaults of unknown icons are dropped.
			const stored = I.normalize({ icons: $('#ti-icons-json').val() || d.icons, categoryDefaults: $('#ti-cat-json').val() });
			library = stored.icons;
			catDefaults = stored.categoryDefaults;
			catCovers = C.normalize({ categoryCovers: $('#ti-covers-json').val() }).categoryCovers;
			// Cover settings as the server applies them: keys never saved (new installs, upgrades
			// from 1.0) take their defaults.
			const state = ajaxify.data.coverState || {};
			['category', 'auto', 'external', 'style', 'phones'].forEach(function (key) {
				$('#ti-cover' + key.charAt(0).toUpperCase() + key.slice(1)).prop('checked', !!state[key]);
			});
			$('#ti-coverRatio').val(state.ratio || '4-3');
			const group = $('#ti-group').val() || '';
			if (group && !groupListed(group)) {
				// The stored group was deleted or renamed: keep it selected, marked, so that the
				// validation explains what to fix. The option is added now (the mark follows after
				// translation), otherwise the select would lose the value before render() reads it.
				const option = $('<option>').val(group).text(group).appendTo('#ti-chooser-group');
				translate(tx('group-missing')).then(function (suffix) {
					option.text(group + ' ' + plain(suffix));
				});
			}
			$('#ti-chooser-group').val(group);
			loaded = true;
			render();
		});

		form.on('input change', '#ti-library [data-field]', onInput);
		form.on('click', '[data-ti-action]', onAction);
		form.on('change', '#ti-cat-defaults select', function () {
			const cid = $(this).attr('data-cid');
			if ($(this).val()) catDefaults[cid] = $(this).val();
			else delete catDefaults[cid];
			setUnsaved(true);
			renderChecks();
		});
		form.on('change', '#ti-default-select', function () {
			$('#ti-default').val($(this).val());
			setUnsaved(true);
			renderChecks();
		});
		form.on('input change', '#ti-cat-defaults [data-cover-cid]', function () {
			const cid = $(this).attr('data-cover-cid');
			const value = $(this).val().trim();
			if (value) catCovers[cid] = value;
			else delete catCovers[cid];
			const src = coverPreviewUrl(value);
			const row = $(this).closest('tr');
			row.find('[data-ti-action="cover-clear"]').prop('disabled', !value);
			const img = row.find('img.topic-icons-acp__cover');
			if (img.length && src) img.attr('src', src);
			setUnsaved(true);
			renderChecks();
		});
		form.on('change', '#ti-chooser, #ti-chooser-group, #ti-showInList, #ti-showInTopic, [id^="ti-cover"]', function () {
			setUnsaved(true);
			renderChecks();
		});

		$('#save').on('click', function (ev) {
			ev.preventDefault();
			if (!loaded) {
				alerts.error(tx('save-blocked'));
				return;
			}
			const result = validate();
			renderChecks();
			if (result.errors.length) {
				alerts.error(result.errors[0]);
				return;
			}
			$('#ti-icons-json').val(result.settings.icons);
			$('#ti-cat-json').val(result.settings.categoryDefaults);
			$('#ti-covers-json').val(result.settings.categoryCovers);
			Settings.save(HASH, form, function (saveErr) {
				if (saveErr) {
					alerts.error(saveErr);
					return;
				}
				library = I.normalize({ icons: result.settings.icons }).icons;
				catCovers = C.normalize({ categoryCovers: result.settings.categoryCovers }).categoryCovers;
				setUnsaved(false);
				alerts.success(tx('saved'));
				render();
			});
		});
	};

	return ACP;
});
