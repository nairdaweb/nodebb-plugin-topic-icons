# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned
- State overlays on the icon: pinned, locked and "solved" (the latter only when the `isSolved`
  field of nodebb-plugin-question-and-answer is present; no hard dependency).
- Optional icon of the latest topic in the category list.
- Update the icon in the topic header right after the first post is edited (now shown after the
  next page load).
- Keep the icon when a topic is forked or merged under a new title.

## [1.0.0] - 2026-09-30

First release. Requires NodeBB 4.15 or newer and Node.js 22 or newer.

### Added
- Icon picker in the composer (nodebb-plugin-composer-default) for new topics and when editing the
  first post, with the icons of the selected category and a preview of the topic row. Keyboard
  support (arrow keys, Home, End), focus returns to the button; the pick is kept in drafts; a
  current icon that is no longer available is marked and can be replaced or removed.
- ACP page: icon library (upload, rename, order, categories, active, remove with confirmation),
  per-category and forum-wide default icons, "who can choose" setting, display switches; category
  tree, warning about unsaved changes and about a missing group; validation in the browser and on
  the server.
- Icons in topic lists and the topic header, with `topicIcon` in template and API data and a
  client-side fallback for themes without a slot; names in the viewer's language, also for guests
  on API routes and for topic lists loaded through API v3.
- Server-side rules for the picked icon: checked when a topic is posted, when it is put in the
  post queue and when the first post is edited; removing an icon needs the same right as setting
  one; an icon that became invalid while a topic waited in the queue is dropped on approval; a
  topic moved to a category where its icon is not available loses it.
- Removing an icon from the library clears it from its topics (per-icon index) and deletes
  uploaded images no icon uses.
- `getTopicIcons(tids, { lang })` for other plugins and themes.
- Admin-only upload route with CSRF, type/content/size checks, refusal of SVGs with scripts,
  handlers, external links or external style resources, and unique file names.
- Eight built-in SVG icons; en-GB and pl translations.

[Unreleased]: https://github.com/nairdaweb/nodebb-plugin-topic-icons/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/nairdaweb/nodebb-plugin-topic-icons/releases/tag/v1.0.0
