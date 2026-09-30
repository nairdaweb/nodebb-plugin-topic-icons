# nodebb-plugin-topic-icons

Topic icons for **NodeBB 4.x**. When creating a topic, the author picks an icon from a library
managed by the administrators; the icon is shown next to the topic in topic lists and in the topic
header.

*Polska wersja: [README.pl.md](README.pl.md).*

- **Compatibility:** NodeBB `^4.0.0`, tested with NodeBB 4.16, nodebb-plugin-composer-default 11 and
  the Harmony theme; Node.js 22 or newer.
- **Author:** [nairda](https://wirelab.pl) · **Licence:** MIT
- **Source and issues:** [github.com/nairdaweb/nodebb-plugin-topic-icons](https://github.com/nairdaweb/nodebb-plugin-topic-icons)

## Screenshots

![Topic list: the topic icon in place of the avatar, with the author's avatar as a small overlay](https://raw.githubusercontent.com/nairdaweb/nodebb-plugin-topic-icons/main/docs/screenshot-list.png)

![Icon picker in the composer, with a preview of the topic row](https://raw.githubusercontent.com/nairdaweb/nodebb-plugin-topic-icons/main/docs/screenshot-picker.png)

*Shown with a custom theme (nodebb-theme-wirelab) that puts the icon in place of the avatar; with Harmony the icon is shown in front of the title.*

## Features

- **Picker in the composer:** a "Choose icon" button next to the title opens a grid of the icons
  available in the selected category, with a preview of the topic row. The icon can be changed when
  editing the first post.
- **Library in the ACP:** upload (PNG, WebP, SVG up to 256 KB), rename, reorder, limit to categories,
  switch off, remove. Eight neutral built-in icons: question, guide, problem, idea, project,
  showcase, announcement, discussion.
- **Per-category sets and defaults:** each icon can be limited to some categories; each category can
  have a default icon (plus one forum-wide default) for topics without one.
- **Permissions:** everyone who can create topics, members of one group, or moderators only.
  Users choose from the library only; they cannot upload images.
- **Server-side validation:** the icon must exist, be active, be available in the category and
  the user must be allowed to choose; only the topic author or a moderator can change it. Refused
  choices return a translated error.
- **Viewer's language** for icon names on full page loads, ajaxify navigation and API responses;
  `alt` and tooltip carry the icon name.
- **No tables of its own:** the library is stored in the plugin settings and the picked icon in the
  topic object (`topic:<tid>` → `iconId`), so it works with Redis, MongoDB and PostgreSQL.
- **Fast:** the library is cached in memory (invalidated on save, also across processes through
  NodeBB's pubsub); rendered icons are kept in an LRU cache; topic lists need no extra query.
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

## Configuration

- *Who can choose an icon* — everyone who can create topics / members of a group (and moderators) /
  moderators and administrators only.
- *Display* — show icons in topic lists and in the topic header; forum-wide default icon.
- *Icon library* — order (= order in the picker), name, image (upload or a site path / https URL
  ending in .png, .webp or .svg), categories (none selected = all), active. A switched-off icon is
  no longer offered but stays on topics that already use it; a removed icon disappears from its
  topics (the category default is shown instead). Names of built-in icons come from the language
  files unless you type one.
- *Category defaults* — icon for topics without one, per category.

Settings are validated in the browser and again on the server before they are saved.

## For theme authors

Topics in lists (`topics`) and the topic page carry `topicIcon`:

```json
{ "id": "question", "name": "Question", "url": "/assets/…/question.svg", "isDefault": false, "html": "<span class=\"topic-icon\">…</span>" }
```

`html` is built on the server with the name escaped (`[` and `]` as `&lsqb;` / `&rsqb;`, so names
never turn into translation tokens) and can be printed raw, e.g. in `partials/topics_list.tpl`:

```html
{{{ if ./topicIcon }}}{{./topicIcon.html}}{{{ end }}}
```

Themes without such a slot get the icon in front of the topic title from `public/client.js`.
Sizes are CSS custom properties: `--topic-icon-size`, `--topic-icon-size-header`,
`--topic-icon-size-inline`, `--topic-icon-radius`.

Other plugins can get icons for any topics in one database call:

```js
const topicIcons = require.main.require('nodebb-plugin-topic-icons');
const icons = await topicIcons.getTopicIcons([1, 2, 3], { lang: 'pl' });
```

### API

- `GET /api/v3/plugins/topic-icons/choices?cid=<cid>` or `?tid=<tid>` — icons the viewer may pick
  (used by the composer).
- `topics.post` / `posts.edit` accept `iconId` (`""` removes the icon).
- `POST /api/admin/plugins/topic-icons/upload` — ACP upload, administrators only, CSRF token required.

## Security notes

- Uploads: administrators only; extension, MIME type and file content must agree (PNG, WebP, SVG);
  SVGs with scripts, event handlers or external links are refused, and NodeBB sanitises SVG uploads
  as well; files get new unique names.
- Icons are always shown through `<img>` (scripts in SVG files do not run there) with
  `referrerpolicy="no-referrer"`.
- Image URLs must be site-relative or https, without backslashes, quotes or `..`.

## Development

```sh
npm install
npm test      # node:test
npm run lint  # eslint
```

## Licence

MIT, see [LICENSE](LICENSE). The built-in icons in `static/icons/` are part of this package and
under the same licence.
