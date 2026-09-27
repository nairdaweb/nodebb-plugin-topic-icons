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
 * ajaxify.data.defaults, categoryList, groupList and maxUploadKb come from the route in
 * library.js.
 */
define('admin/plugins/topic-icons', ['settings', 'alerts', 'translator', 'bootbox', 'topic-icons/icons'], function (Settings, alerts, translator, bootbox, I) {
	const ACP = {};
	const HASH = 'topic-icons';
	const NS = 'admin/plugins/topic-icons';
	/** Placeholder replaced by an escaped name after translation (see message()). */
	const ARG = '@@ti-arg@@';

	/** Library being edited (normalised icons, see lib/icons.js). */
	let library = [];
	/** Category defaults being edited: cid → icon id. */
	let catDefaults = {};
	/** False until the stored settings were read; saving is refused before that. */
	let loaded = false;

	/**
	 * @param {string} key
	 * @param {...(string|number)} args numbers or placeholders only
	 * @returns {string} translation token of the ACP namespace
	 */
	function tx(key) {
		return translator.compile.apply(null, [NS + ':' + key].concat(Array.prototype.slice.call(arguments, 1)));
	}

	/**
	 * Escapes text for element content and double-quoted attributes. Square brackets are encoded
	 * too, so that no stored text can become a translation token when the markup is translated.
	 *
	 * @param {*} str
	 * @returns {string}
	 */
	function esc(str) {
		return I.escape(str == null ? '' : str);
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
	 * @param {string} value JSON from a hidden input
	 * @param {*} fallback returned for empty or invalid JSON
	 * @returns {*}
	 */
	function parse(value, fallback) {
		if (!value) return fallback;
		try {
			return JSON.parse(value);
		} catch {
			return fallback;
		}
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
	 * @param {number} i row index
	 * @param {object} icon
	 * @returns {string} HTML of one library row
	 */
	function rowHtml(icon, i) {
		const src = previewUrl(icon.url);
		const cats = (ajaxify.data.categoryList || []).map(function (c) {
			const selected = icon.cids.indexOf(parseInt(c.cid, 10)) !== -1 ? ' selected' : '';
			return '<option value="' + esc(c.cid) + '"' + selected + '>' + esc(c.name) + '</option>';
		}).join('');
		const placeholder = icon.key ? '[[topic-icons:icon.' + icon.key + ']]' : tx('name-placeholder');
		return '<tr data-i="' + i + '">' +
			'<td>' + (src ? '<img class="topic-icons-acp__img" src="' + esc(src) + '" alt="" width="40" height="40" referrerpolicy="no-referrer">' : '<span class="topic-icons-acp__img d-inline-block bg-light"></span>') + '</td>' +
			'<td style="min-width:12rem"><input type="text" class="form-control form-control-sm" maxlength="' + I.MAX_NAME + '" data-field="name" value="' + esc(icon.name) + '" placeholder="' + placeholder + '"></td>' +
			'<td style="min-width:16rem"><div class="input-group input-group-sm">' +
				'<input type="text" class="form-control" data-field="url" value="' + esc(icon.url) + '" placeholder="/assets/uploads/… or https://…">' +
				'<button type="button" class="btn btn-light" data-ti-action="upload" title="' + tx('upload') + '" aria-label="' + tx('upload') + '"><i class="fa fa-upload"></i></button></div></td>' +
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
	 * Re-renders the library, the default selects and the category table. Called after every
	 * structural change; plain typing only updates the model. The markup contains translation
	 * tokens, so it is translated before insertion (all stored text is escaped by esc()).
	 *
	 * @returns {void}
	 */
	function render() {
		translator.translate(library.map(rowHtml).join(''), function (html) { $('#ti-library tbody').html(html); });
		$('#ti-empty').toggleClass('d-none', library.length > 0);
		translator.translate(iconOptions($('#ti-default').val(), 'default-none'), function (html) { $('#ti-default-select').html(html); });
		const rows = (ajaxify.data.categoryList || []).map(function (c) {
			return '<tr><td>' + esc(c.name) + '</td><td><select class="form-select form-select-sm" data-cid="' + esc(c.cid) + '" style="max-width:20rem">' +
				iconOptions(catDefaults[c.cid] || '', 'default-inherit') + '</select></td></tr>';
		}).join('');
		translator.translate(rows, function (html) { $('#ti-cat-defaults tbody').html(html); });
		renderChecks();
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
		$('#ti-group').val($('#ti-chooser-group').val() || '');
	}

	/**
	 * @returns {{errors: string[], settings: object}} same checks as the server
	 */
	function validate() {
		syncHidden();
		return I.validateSettings({
			chooser: $('#ti-chooser').val(),
			chooserGroup: $('#ti-group').val(),
			defaultIcon: $('#ti-default').val(),
			categoryDefaults: $('#ti-cat-json').val(),
			icons: $('#ti-icons-json').val(),
		});
	}

	/**
	 * Shows validation errors under the tables and marks invalid image fields.
	 *
	 * @returns {void}
	 */
	function renderChecks() {
		$('#ti-group-wrap').toggleClass('opacity-50', $('#ti-chooser').val() !== 'group');
		$('#ti-library [data-field="url"]').each(function () {
			$(this).toggleClass('is-invalid', !I.cleanUrl($(this).val()));
		});
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
		renderChecks();
	}

	/**
	 * Picks an image and uploads it through the plugin's ACP route (administrators only, CSRF
	 * token of the session). The server checks type, content and size again and stores the file
	 * under a new unique name.
	 *
	 * @param {object} icon library entry that gets the URL
	 * @returns {void}
	 */
	function upload(icon) {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.png,.webp,.svg,image/png,image/webp,image/svg+xml';
		input.addEventListener('change', function () {
			const file = input.files && input.files[0];
			if (!file) return;
			if (!/\.(png|webp|svg)$/i.test(file.name)) {
				alerts.error(tx('upload-type'));
				return;
			}
			if (file.size > ajaxify.data.maxUploadKb * 1024) {
				alerts.error(tx('upload-size', ajaxify.data.maxUploadKb));
				return;
			}
			const body = new FormData();
			body.append('file', file, file.name);
			fetch(config.relative_path + '/api/admin/plugins/topic-icons/upload', {
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
				icon.url = stripRelativePath(url);
				syncHidden();
				render();
				alerts.success(tx('uploaded'));
			}).catch(function (err) {
				translator.translate(String(err.message || err), function (reason) {
					message('upload-failed', $('<div>').html(reason).text()).then(function (html) { alerts.error(html); });
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
			render();
			$('#ti-library tbody tr').last().find('[data-field="name"]').trigger('focus');
			return;
		}
		if (action === 'restore') {
			translator.translate(tx('confirm-restore'), function (text) {
				bootbox.confirm(text, function (ok) {
					if (!ok) return;
					I.builtinIcons().forEach(function (icon) {
						if (!library.some(function (e) { return e.id === icon.id; })) library.push(icon);
					});
					render();
					alerts.info(tx('restored'));
				});
			});
			return;
		}
		if (!library[i]) return;
		if (action === 'upload') {
			upload(library[i]);
		} else if (action === 'up' && i > 0) {
			library.splice(i - 1, 0, library.splice(i, 1)[0]);
			render();
		} else if (action === 'down' && i < library.length - 1) {
			library.splice(i + 1, 0, library.splice(i, 1)[0]);
			render();
		} else if (action === 'remove') {
			translator.translate(label(library[i]), function (name) {
				message('confirm-remove', $('<div>').html(name).text()).then(function (html) {
					bootbox.confirm(html, function (ok) {
						if (!ok) return;
						library.splice(i, 1);
						render();
					});
				});
			});
		}
	}

	/**
	 * Page entry point, called by NodeBB when the ACP page is loaded.
	 *
	 * @returns {void}
	 */
	ACP.init = function () {
		const form = $('.topic-icons-settings');
		$('#ti-chooser-group').append((ajaxify.data.groupList || []).map(function (name) {
			return '<option value="' + esc(name) + '">' + esc(name) + '</option>';
		}).join(''));

		Settings.load(HASH, form, function (err) {
			if (err) {
				// Letting Save through would overwrite the stored settings with an empty page.
				$('#save').prop('disabled', true);
				translator.translate(String(err.message || err), function (reason) {
					message('load-error', $('<div>').html(reason).text()).then(function (html) { alerts.error(html, 0); });
				});
				return;
			}
			const d = ajaxify.data.defaults || {};
			const neverSaved = !$('#ti-icons-json').val();
			if (neverSaved) {
				// Unset switches default to on, as on the server (lib/icons.js normalize).
				$('#ti-showInList, #ti-showInTopic').prop('checked', true);
			}
			library = I.normalize({ icons: $('#ti-icons-json').val() || d.icons }).icons;
			catDefaults = parse($('#ti-cat-json').val(), {}) || {};
			$('#ti-chooser-group').val($('#ti-group').val() || '');
			loaded = true;
			render();
		});

		form.on('input change', '#ti-library [data-field]', onInput);
		form.on('click', '[data-ti-action]', onAction);
		form.on('change', '#ti-cat-defaults select', function () {
			const cid = $(this).attr('data-cid');
			if ($(this).val()) catDefaults[cid] = $(this).val();
			else delete catDefaults[cid];
			renderChecks();
		});
		form.on('change', '#ti-default-select', function () {
			$('#ti-default').val($(this).val());
			renderChecks();
		});
		form.on('change', '#ti-chooser, #ti-chooser-group', renderChecks);

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
			Settings.save(HASH, form, function (saveErr) {
				if (saveErr) {
					alerts.error(saveErr);
					return;
				}
				library = I.normalize({ icons: result.settings.icons }).icons;
				alerts.success(tx('saved'));
				render();
			});
		});
	};

	return ACP;
});
