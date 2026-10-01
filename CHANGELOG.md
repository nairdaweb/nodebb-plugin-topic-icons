# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-10-01

### Added
- Update notices on the ACP page: "Version X is available — what's new", linking to the release notes. The plugin fetches
  `https://updates.wirelab.pl/api/nodebb-plugin-topic-icons.json` at most once a day (in the background and when the
  ACP page is opened, from a cache kept in the database; an hour after a failed attempt) with a plain
  `GET`: no query string, no cookies, no data about the forum, `User-Agent: nodebb-plugin-topic-icons/<version>`,
  5 s timeout. Network errors are logged at verbose level only.
- "Check for updates" switch on the ACP page, on by default, saved on its own (settings hash
  `topic-icons-update-check`). When it is off, no request is made at all.
- `lib/update-check.js`, shared by the wirelab plugins; no new dependencies.

## [1.1.2] - 2026-10-01

### Security
- Use express-rate-limit and rebuild upload paths from a fixed directory. Request limits are
  unchanged (20 uploads, 60 ACP page loads and 300 API requests per minute per user, guests per IP
  address, IPv6 grouped by /56) and now come from `express-rate-limit` (new dependency), which
  replaces `lib/ratelimit.js`. The path of an uploaded file is rebuilt from the system temporary
  folder fixed at start-up and the bare file name, which must be a multer name (32 hex digits); it
  must still be a regular file and not a symbolic link.

## [1.1.1] - 2026-10-01

### Security
- Uploads: only multer's temporary file is read, copied and deleted. Its path must resolve to a
  regular file inside the system temporary folder, without `..` segments and not through a symbolic
  link (`lib/safe-path.js`); anything else is refused. Applies to icon and category cover uploads.
- The clean-up of unused uploaded files accepts plain file names inside the plugin's upload folder
  only.
- Request limits per user (guests: per IP address), counted in memory without new dependencies
  (`lib/ratelimit.js`): 20 uploads per minute, checked after the administrator check and before the
  file is received; 60 loads of the ACP page per minute; 300 requests per minute to the
  `choices` and `icons` API routes. Above the limit the answer is `429` with `Retry-After`.
- Icons re-rendered in the viewer's language are built from the icon data with DOM methods (the URL
  checked again), no longer by inserting HTML from the API response.
- Findings reported by Snyk Code (CWE-23, CWE-770, CWE-79).

## [1.1.0] - 2026-10-01

### Added
- Topic covers, working with NodeBB's topic thumbnails. A topic without thumbnails can show the
  first image of its first post (forum uploads; images from other sites only when allowed in the
  ACP) or the default cover of its category, in that order. Covers are added at display time and
  never saved as thumbnails, so a changed category cover shows everywhere at once. Each part can
  be switched off; the first image and images from other sites are off by default.
- The first image is looked up once per first post (topic field `coverScan`), again when the first
  post is edited, so an image removed in an edit takes the cover away immediately; code blocks and
  comments are skipped.
- Uniform frame for topic thumbnails in lists and in the topic header: 4:3 or square, cropped,
  rounded, also in topic lists on phones (optional), dark mode through Bootstrap variables, topic
  title as `alt` text; CSS custom properties `--topic-cover-*` for themes.
- ACP: "Topic covers" section and a default cover per category (upload, site path or https URL),
  with a separate admin-only upload route (`upload-cover`) for PNG, JPEG, WebP, GIF and SVG up to
  2 MB; unused uploaded covers are deleted on save.
- `topicCover` in topic data for themes.

### Changed
- The ACP upload checks accept a list of types and a size limit per kind of upload; JPEG and GIF
  are recognised by content (icons still accept PNG, WebP and SVG only).

## [1.0.0] - 2026-10-01

First release. Requires NodeBB 4.15 or newer and Node.js 22 or newer.

### Added
- Icon picker in the composer (nodebb-plugin-composer-default) for new topics and when editing the
  first post, with the icons of the selected category and a preview of the topic row. Keyboard
  support (arrow keys, Home, End), focus returns to the button; the pick is kept in drafts; a
  current icon that is no longer available is marked and can be replaced or removed.
- ACP page: icon library (upload, rename, order, categories, active, remove with confirmation),
  per-category and forum-wide default icons, "who can choose" setting, display switches; category
  tree, warning about unsaved changes and about a missing group (a chooser group that no longer
  exists stays selected and is marked); validation in the browser and on the server.
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
- Admin-only upload route (the administrator check runs before the file is received) with CSRF,
  type/content/size checks, refusal of SVGs with scripts, event handlers (also `<svg/onload=…>`),
  external links or external style resources, and unique file names.
- Eight built-in SVG icons; en-GB and pl translations.

[1.1.1]: https://github.com/nairdaweb/nodebb-plugin-topic-icons/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/nairdaweb/nodebb-plugin-topic-icons/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/nairdaweb/nodebb-plugin-topic-icons/releases/tag/v1.0.0
