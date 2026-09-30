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
- Put icons of topics pushed over the websocket (new topics, guests' infinite scroll) into the
  viewer's language; they are rendered in the forum default language for guests until the page is
  reloaded.

## [1.0.0] - 2026-09-27

### Added
- Icon picker in the composer (nodebb-plugin-composer-default) for new topics and when editing the
  first post, with the icons of the selected category and a preview of the topic row.
- ACP page: icon library (upload, rename, order, categories, active, remove with confirmation),
  per-category and forum-wide default icons, "who can choose" setting, display switches; validation
  in the browser and on the server.
- Icons in topic lists and the topic header, with `topicIcon` in template and API data and a
  client-side fallback for themes without a slot.
- Server-side validation of the picked icon on posting (also for queued posts) and editing.
- Admin-only upload route with CSRF, type/content/size checks and unique file names.
- Eight built-in SVG icons; en-GB and pl translations.

[Unreleased]: https://github.com/nairdaweb/nodebb-plugin-topic-icons/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/nairdaweb/nodebb-plugin-topic-icons/releases/tag/v1.0.0
