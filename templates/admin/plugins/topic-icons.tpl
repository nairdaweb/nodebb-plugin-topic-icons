<!--
	ACP page of nodebb-plugin-topic-icons, rendered by the route in library.js (init).
	Behaviour lives in public/admin.js; strings come from
	languages/<lang>/admin/plugins/topic-icons.json. Fields with a name attribute are saved by
	NodeBB's settings module under the "topic-icons" hash; the library, the category defaults and
	the forum-wide default are kept in the hidden inputs at the bottom and validated on the server
	by lib/icons.js.
-->
<div class="acp-page-container">
	<!-- IMPORT admin/partials/settings/header.tpl -->

	<div class="row m-0">
		<div id="spy-container" class="col-12 px-0 mb-4" tabindex="0">
			<form role="form" class="topic-icons-settings d-flex flex-column gap-4">
				<div class="row g-3">
					<div class="col-12 col-md-6">
						<label class="form-label fw-semibold" for="ti-chooser">{{tx("admin/plugins/topic-icons:permissions")}}</label>
						<select class="form-select" id="ti-chooser" name="chooser">
							<option value="all">{{tx("admin/plugins/topic-icons:chooser-all")}}</option>
							<option value="group">{{tx("admin/plugins/topic-icons:chooser-group")}}</option>
							<option value="mods">{{tx("admin/plugins/topic-icons:chooser-mods")}}</option>
						</select>
						<p class="form-text">{{tx("admin/plugins/topic-icons:chooser-help")}}</p>
					</div>
					<div class="col-12 col-md-6" id="ti-group-wrap">
						<label class="form-label fw-semibold" for="ti-chooser-group">{{tx("admin/plugins/topic-icons:chooser-group-label")}}</label>
						<!-- Options are added by public/admin.js (group names are escaped there). -->
						<select class="form-select" id="ti-chooser-group">
							<option value="">{{tx("admin/plugins/topic-icons:chooser-group-none")}}</option>
						</select>
					</div>
				</div>

				<div>
					<h5>{{tx("admin/plugins/topic-icons:display")}}</h5>
					<div class="d-flex flex-wrap gap-4 mb-3">
						<div class="form-check form-switch">
							<input type="checkbox" class="form-check-input" id="ti-showInList" name="showInList">
							<label class="form-check-label" for="ti-showInList">{{tx("admin/plugins/topic-icons:show-in-list")}}</label>
						</div>
						<div class="form-check form-switch">
							<input type="checkbox" class="form-check-input" id="ti-showInTopic" name="showInTopic">
							<label class="form-check-label" for="ti-showInTopic">{{tx("admin/plugins/topic-icons:show-in-topic")}}</label>
						</div>
					</div>
					<label class="form-label fw-semibold" for="ti-default-select">{{tx("admin/plugins/topic-icons:default-icon")}}</label>
					<select class="form-select" id="ti-default-select" style="max-width:24rem"></select>
					<p class="form-text">{{tx("admin/plugins/topic-icons:default-icon-help")}}</p>
				</div>

				<div>
					<div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
						<h5 class="mb-0">{{tx("admin/plugins/topic-icons:library")}}</h5>
						<div class="d-flex flex-wrap gap-2">
							<button type="button" class="btn btn-sm btn-light" data-ti-action="add"><i class="fa fa-plus"></i> {{tx("admin/plugins/topic-icons:add-icon")}}</button>
							<button type="button" class="btn btn-sm btn-light" data-ti-action="restore"><i class="fa fa-rotate-left"></i> {{tx("admin/plugins/topic-icons:restore-builtin")}}</button>
						</div>
					</div>
					<p class="form-text">{{tx("admin/plugins/topic-icons:library-help", maxUploadKb)}}</p>
					<div class="table-responsive">
						<table class="table table-sm align-middle" id="ti-library">
							<thead><tr><th>{{tx("admin/plugins/topic-icons:col-icon")}}</th><th>{{tx("admin/plugins/topic-icons:col-name")}}</th><th>{{tx("admin/plugins/topic-icons:col-image")}}</th><th>{{tx("admin/plugins/topic-icons:col-categories")}}</th><th>{{tx("admin/plugins/topic-icons:col-active")}}</th><th></th></tr></thead>
							<tbody></tbody>
						</table>
					</div>
					<p class="text-muted d-none" id="ti-empty">{{tx("admin/plugins/topic-icons:empty-library")}}</p>
				</div>

				<div>
					<h5>{{tx("admin/plugins/topic-icons:category-defaults")}}</h5>
					<p class="form-text">{{tx("admin/plugins/topic-icons:category-defaults-help")}}</p>
					<div class="table-responsive">
						<table class="table table-sm align-middle" id="ti-cat-defaults">
							<thead><tr><th>{{tx("admin/plugins/topic-icons:col-category")}}</th><th>{{tx("admin/plugins/topic-icons:col-default")}}</th></tr></thead>
							<tbody></tbody>
						</table>
					</div>
				</div>

				<!-- Validation errors, filled by public/admin.js (renderChecks). -->
				<div id="ti-checks" class="d-none">
					<h5>{{tx("admin/plugins/topic-icons:checks")}}</h5>
					<ul class="list-unstyled d-flex flex-column gap-2 mb-0"></ul>
				</div>

				<!-- Filled by public/admin.js (syncHidden) before each save. -->
				<input type="hidden" name="icons" id="ti-icons-json">
				<input type="hidden" name="categoryDefaults" id="ti-cat-json">
				<input type="hidden" name="defaultIcon" id="ti-default">
				<input type="hidden" name="chooserGroup" id="ti-group">
			</form>
		</div>
	</div>
</div>
