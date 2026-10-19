# Changelog

Songnest is a cross-platform music library and player built in Rust.
Releases are cut from tags like `v0.2.0`.

## Unreleased

## v0.4.0 — 2026-10-19

Updates now install in place on Android, and the phone build is much
lighter. The player was reworked on Android (Media3) and the queue now
survives a restart.

### Features

- Android updates are installed in place through Android's session
  installer. Pressing Update downloads the APK, hands it to the system,
  and Android asks you to confirm with one tap; your library and likes are
  kept. Android always shows its own confirmation for an app that is not
  on Google Play.
- Android background playback now runs on Media3, with a command queue so
  play, pause, next, previous, and seek stay in order, plus lockscreen and
  notification controls.
- The play queue keeps pending and up-next tracks and remembers the
  playback position across restarts.
- Added a shuffle button to the desktop player bar.
- Join the [Songnest WhatsApp community](https://chat.whatsapp.com/COutxvPnS4J3W5vyDSeWxv)
  from the app's settings, the website, or the README for release news,
  early builds, and support.

### Improvements

- Android releases now ship single-ABI APKs alongside the universal one.
  The ~156 MB universal APK (all four ABIs) is rejected as an invalid
  package by some installers, including Transsion/HiOS on Android 15 Go;
  the armeabi-v7a build is ~69 MB and installs cleanly. The blanket
  `abiFilters` in `defaultConfig` was also removed — it forced every ABI
  into every variant, so `-t armv7` still produced a 156 MB file.
- The in-app updater now picks the APK matching the phone's CPU family
  instead of whichever `.apk` sorted first, which handed Android users the
  156 MB universal build.
- Pressing Update on Android no longer looks like it did nothing, and no
  longer sends you into the browser.
- Deleting a song is now deferred ~6s and the bottom toast gains an Undo
  button, so an accidental delete is a tap away from being cancelled.
- Swipe actions on a song card are icon-only and appear on a short drag.
- The download site picks the right build for your device and explains how
  to install it, so non-technical users are not left guessing.

### Fixes

- Fixed YouTube matching serving the wrong recording. Search now inspects
  every candidate instead of only each query's top hit and rejects live,
  acoustic, karaoke, remix, slowed, "1 hour loop", lyric-video and
  foreign-language re-uploads that Deezer did not ask for — so "One Dance"
  no longer resolves to the SNL performance, "Love To Lose" to the
  acoustic cut, "Beauty And A Beat" to a Spanish re-upload, or "STAY" to
  its lyric video. Deezer tracks are audio, so an "Official Audio" upload
  now outranks an "Official Video"/music video, and the artist's own
  plain-titled master is preferred over a verbosely-titled video that
  merely names every collaborator. When only a wrong cut exists the track
  now honestly 404s instead of playing something wrong, and a query that
  times out no longer aborts the whole search. Cached matches from the old
  scorer are re-searched once.
- Deleting a song now clears its cached Deezer→YouTube match, download
  history and in-memory stream URL, so re-downloading it genuinely
  re-searches YouTube instead of replaying the exact recording you
  deleted.
- Fixed the update page on Windows and Linux. The `latest.json` job matched
  Tauri v1 updater artifact names (`.nsis.zip`, `.msi.zip`,
  `.AppImage.tar.gz`) that v2 no longer emits, so both platforms were
  silently omitted and those devices reported "up to date" while a signed
  installer sat in the release. It now matches the v2 artifacts
  (`*-setup.exe`, `*.AppImage`).
- Fixed Android release APK signing.
- Android builds now ask for `REQUEST_INSTALL_PACKAGES`, which Android
  requires before it will install an update.

**Full Changelog**: https://github.com/Smasduq/songnest/compare/v0.3.1...v0.4.0

## v0.3.1 — 2026-10-17

- Fixed mobile YouTube matching for remixes: search now considers more
  candidates and reads Deezer's separate version field, rejecting the
  plain original when Deezer identifies a remix. Existing cached matches
  are invalidated and searched again.
- Fixed Windows desktop startup by locating the bundled backend executable
  and launching it without opening a console window.

## v0.3.0 — 2026-10-15

- Time-synced lyrics (LRCLIB, no key): synced lines with the active line
  highlighted and auto-centered, click-to-seek, and a per-track ±ms offset
  saved in SQLite. Plain-lyrics fallback, Instrumental detection, and an
  honest "not found" — fetches are cached, prefetched at download time,
  and work offline. Desktop gets a full lyrics page over ambient artwork
  (player-bar icon); the mobile sheet keeps a large inline panel.
- Smarter YouTube matching: remixes/live/acoustic versions no longer lose
  to the plain original, collaborations credit every artist, and stale
  wrong matches from older scorers are re-searched once automatically.
  Lyric failures now say what actually happened (no lyrics vs service
  down vs outdated backend) instead of a blanket "not found".
- Desktop chrome flattened Firefox-style with the sidebar and header
  joined; header search tints with the artwork palette.
- Accounts: visible native-login phase, 20s timeout on API calls, fixed
  native Google login, live search autocomplete.
- Search results stay visible while the picked song resolves and plays.

## v0.2.0 — 2026-10-14

- In-app updates: new App updates page (sidebar, settings, `#update`).
  Desktop installs signed updater bundles in place with progress and
  relaunch; mobile and browser get one Update button that picks the right
  file automatically. `latest.json` is published with every release.
- Downloaded state is persistent everywhere: song cards, the now-playing
  sheet, and the desktop sidebar all read one registry seeded from the
  on-disk library, so Downloaded survives re-renders and restarts (and
  reverts when a track is deleted).
- Edit-profile modal: change username and email together, with per-field
  errors; the session and header update immediately (`PUT /me/email`).
- GitHub device flow copies the code to the clipboard automatically (tap
  to copy again); provider login failures report specific messages
  instead of the generic password error.
- Android: local builds sign with the release keystore, so updates
  install over the old app after one final reinstall; native audio
  plugin targets SDK 26/36 (compileSdk 36, minSdk 26).
- Release pipeline signs desktop updater artifacts and Android APKs from
  GitHub secrets; the accounts API redeploys on release publish.
- Release notes are generated from this changelog plus post-tag commits
  (appended at the bottom), so late fixes never miss the release page.

## v0.1.0 — 2026-10-14

- Hosted accounts (Neon Postgres + Vercel): email/password sign-up and
  sign-in, GitHub and Google login (redirect on web, loopback + device
  flows on desktop/mobile), liked-song sync across devices, editable
  usernames, and profile photos stored in Neon Object Storage.
- Desktop and mobile bundles talk to the production API; local `vite dev`
  keeps using the loopback servers.
- Linux AppImage bundles the GStreamer media framework, fixing the
  WebKitWebProcess crash on every song play.
- Background playback on both platforms: Android plays through a native
  Media3 service (notification, lockscreen controls, audio focus, survives
  backgrounding); desktop hides to the system tray instead of quitting on
  close, with tray transport actions and OS media-key metadata.
  Phone queue/transport logic is unchanged — only the audio engine swaps.
- Android lockscreen/notification card shows the song cover with
  prev/play/next (vendored player fork, see
  `web/src-tauri/plugins/native-audio/FORK.md`); track buttons forward
  into the app queue, so repeat/shuffle keep working from the lockscreen.

## v0.1.0-alpha.2 — 2026-10-07

- Offline and empty states with big centered icons instead of
  "is the server reachable" text, plus a startup backfill that refreshes
  stale single-artist rows.
- Every credited artist shown on songs (search, suggestions, library,
  likes, downloads, file tags) — e.g. "FOLA, Ayra Starr".
- Queue rework: Up next lists only explicitly added songs, drag up/down
  to reorder, swipe to remove, optimistic add with toast, sequential
  next/auto-advance, tap-guard so swipes never start playback.
- Mobile now-playing sheet with fullscreen detent and queue view,
  ambient cover glow on the sheet and bars, buffering
  ("Getting the song ready…") state, drag-to-seek with hover preview.
- Custom main-page scrollbar, right-click song menus, hover play buttons,
  vertical card menus, theme-colored playing waves on song cards.

- YouTube cookies can be installed from the app (Downloader diagnostics),
  same file the desktop reads — stops downloads stalling after a few
  anonymous fetches.
- Android releases are signed, so they install on any device.
- Linux AppImage builds on Ubuntu 24.04 (modern bundled WebKit).
- Windows alpha ships NSIS-only (MSI rejects the alpha version tag).
- iOS builds paused; desktop, Android, and site keep shipping.

## v0.1.0-alpha.1 — 2026-10-07

First public alpha. Desktop (Linux, macOS, Windows) and Android.

- Search any song or artist, stream full tracks, download for offline,
  like songs, queue and repeat/shuffle.
- Android runs its own backend on-device: real yt-dlp on embedded
  Python, no previews, no account needed.
- Now-playing sheet with volume, transport controls, and queue.
- Mobile-first UI: bottom navigation, swipe actions, glass header.
- Landing + downloads site.
