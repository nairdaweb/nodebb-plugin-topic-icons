# nodebb-plugin-topic-icons

Topic icons for **NodeBB 4.x**. When creating a topic, the author picks an icon from a library
managed by the administrators; the icon is shown next to the topic in topic lists and in the topic
header.


- **Compatibility:** NodeBB `^4.15.0` (the ACP page uses the `{{tx()}}` template helper that core
  switched its admin templates to in 4.15), tested with NodeBB 4.16, nodebb-plugin-composer-default
  11 and the Harmony theme; Node.js 22 or newer.
- **Author:** [nairda](https://wirelab.pl) · **Licence:** MIT
- **Source and issues:** [github.com/nairdaweb/nodebb-plugin-topic-icons](https://github.com/nairdaweb/nodebb-plugin-topic-icons)

## Screenshots

![Topic list: the topic icon in place of the avatar, with the author's avatar as a small overlay](https://raw.githubusercontent.com/nairdaweb/nodebb-plugin-topic-icons/main/docs/screenshot-list.png)

![Icon picker in the composer, with a preview of the topic row](https://raw.githubusercontent.com/nairdaweb/nodebb-plugin-topic-icons/main/docs/screenshot-picker.png)

*Shown with a custom theme (nodebb-theme-wirelab) that puts the icon in place of the avatar; with Harmony the icon is shown in front of the title.*

## Features

- **Picker in the composer:** a "Choose icon" button next to the title opens a grid of the icons
  available in the selected category, with a preview of the topic row. The icon can be changed when
  editing the first post; a current icon that is no longer available is shown as such and can be
  replaced or removed. The pick is kept in composer drafts. Keyboard: arrow keys, Home and End.
- **Library in the ACP:** upload (PNG, WebP, SVG up to 256 KB), rename, reorder, limit to categories,
  switch off, remove. Eight neutral built-in icons: question, guide, problem, idea, project,
  showcase, announcement, discussion.
- **Per-category sets and defaults:** each icon can be limited to some categories; each category can
  have a default icon (plus one forum-wide default) for topics without one.
- **Permissions:** everyone who can create topics, members of one group, or moderators only.
  Users choose from the library only; they cannot upload images.
- **Server-side validation:** the icon must exist, be active, be available in the category and
  the user must be allowed to choose, also to remove it; only the topic author or a moderator can
  change it. Topics that go to the post queue are checked when they are submitted. Refused choices
  return a translated error.
- **Viewer's language** for icon names on full page loads, ajaxify navigation and the plugin's API
  routes (guests: the browser language when "auto-detect language" is on); `alt` and tooltip carry
  the icon name. Topic lists loaded through NodeBB's API v3 (e.g. infinite scroll) are rendered in
  the account or forum language and fixed up in the browser.
- **No tables of its own:** the library is stored in the plugin settings, the picked icon in the
  topic object (`topic:<tid>` → `iconId`) and a per-icon sorted set of topics
  (`topic-icons:icon:<id>:tids`) lets a removed icon be cleared from its topics; it works with
  Redis, MongoDB and PostgreSQL.
- **Fast:** the library is cached in memory (invalidated on save, also across processes through
  NodeBB's pubsub); rendered icons are kept in an LRU cache; topic lists need no extra topic query
  (users' language settings are cached for a minute).
- **Translated:** en-GB and pl (other languages fall back to en-GB).

## Installation

```sh
cd /path/to/nodebb
npm install nodebb-plugin-topic-icons
./nodebb activate nodebb-plugin-topic-icons
./nodebb build
./nodebb restart
```

Then configure it in **ACP → Plugins → Topic icons**.

Uninstalling leaves the `iconId` field in topics, the `topic-icons:icon:<id>:tids` sorted sets
and the `settings:topic-icons` hash in the database; they are not used by anything else.

## Configuration

- *Who can choose an icon* — everyone who can create topics / members of a group (and moderators) /
  moderators and administrators only.
- *Display* — show icons in topic lists and in the topic header; forum-wide default icon.
- *Icon library* — order (= order in the picker), name, image (upload or a site path / https URL
  ending in .png, .webp or .svg), categories (none selected = all), active. Names of built-in icons
  come from the language files unless you type one.
- *Category defaults* — icon for topics without one, per category.

Settings are validated in the browser and again on the server before they are saved. A partial
save (e.g. `meta.settings.setOne('topic-icons', 'showInList', 'off')`) is merged with the stored
settings. The group for "members of a group" must exist and cannot be `guests`, `spiders`,
`fediverse` or `banned-users`; the ACP marks a stored group that was deleted or renamed.

### What happens to a topic's icon

- **Switched-off icon:** no longer offered; topics that already use it keep it.
- **Removed icon:** when the settings are saved, it is cleared from the topics that used it (the
  category default is shown instead), so an icon added again later under the same id does not
  come back on old topics. Its uploaded image is deleted, as is an image replaced by a new upload.
  Images uploaded but never saved in the library stay in `uploads/topic-icons/`.
- **Topic moved** to a category where its icon is not available: the icon is cleared and the
  default of the new category is shown. Limiting an icon to some categories later does not change
  topics elsewhere.
- **Post queue:** the icon is checked when the topic is submitted. If it is no longer valid when a
  moderator approves the topic (icon removed or switched off, topic moved to another category in
  the queue, author no longer allowed), the topic is posted without it.
- **Editing:** sending the current icon again is not a change, even when it is no longer available;
  the picker does not send it. With "moderators only", an author cannot change or remove an icon.
- **Fork and merge:** a topic created by forking or by merging under a new title starts without an
  icon (the category default is shown); merging into an existing topic keeps that topic's icon.

## For theme authors

Topics in lists (`topics`) and the topic page carry `topicIcon`:

```json
{ "id": "question", "name": "Question", "url": "/assets/…/question.svg", "isDefault": false, "html": "<span class=\"topic-icon\">…</span>" }
```

Topic lists are those that go through NodeBB's `filter:topics.get` (categories, recent, popular,
unread, tags, user profiles); search results are posts and carry no `topicIcon`.

`html` is built on the server with the name escaped (`[` and `]` as `&lsqb;` / `&rsqb;`, so names
never turn into translation tokens) and can be printed raw, e.g. in `partials/topics_list.tpl`:

```html
{{{ if ./topicIcon }}}{{./topicIcon.html}}{{{ end }}}
```

Themes without such a slot get the icon in front of the topic title from `public/client.js`.
Sizes are CSS custom properties: `--topic-icon-size`, `--topic-icon-size-header`,
`--topic-icon-size-inline`, `--topic-icon-radius`.

Other plugins can get icons for any topics in one database call (at most 500 per call; no
privilege checks, so pass only topics the viewer may see; `lang` must be an installed language):

```js
const topicIcons = require.main.require('nodebb-plugin-topic-icons');
const icons = await topicIcons.getTopicIcons([1, 2, 3], { lang: 'pl' });
```

### API

- `GET /api/v3/plugins/topic-icons/choices?cid=<cid>`, `?pid=<pid>` or `?tid=<tid>` — icons the
  viewer may pick for a new topic or when editing the first post (used by the composer).
- `GET /api/v3/plugins/topic-icons/icons?tids=1,2,3` — rendered icons of up to 100 readable topics
  in the viewer's language.
- `topics.post` / `posts.edit` accept `iconId` (`""` removes the icon).
- `POST /api/admin/plugins/topic-icons/upload` — ACP upload, administrators only, CSRF token required.

## Security notes

- Uploads: administrators only (the ACP page is open to `admin:settings`, but the upload button
  and route are not); extension, MIME type and file content must agree (PNG, WebP, SVG); SVGs with
  scripts, event handlers, external links or external resources in styles (`url(…)` other than
  `#id`, `@import`) are refused, and NodeBB sanitises SVG uploads as well; files get new unique
  names.
- Icons are always shown through `<img>` (scripts in SVG files do not run there) with
  `referrerpolicy="no-referrer"`.
- Image URLs must be site-relative or https, without backslashes, quotes, `.`/`..` segments (also
  percent-encoded) or encoded slashes.
- An https image from another site is loaded by every visitor's browser from that site, which
  sees their IP address (not the page, thanks to `no-referrer`). Upload images to keep them local.

## Development

```sh
npm install
npm test      # node:test
npm run lint  # eslint
```

## Licence

MIT, see [LICENSE](LICENSE). The built-in icons in `static/icons/` are part of this package and
under the same licence.
