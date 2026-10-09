# Changelog

Songnest is a cross-platform music library and player built in Rust.
Releases are cut from tags like `v0.1.0-alpha.2`.

## Unreleased

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
