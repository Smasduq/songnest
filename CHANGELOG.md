# Changelog

Songnest is a cross-platform music library and player built in Rust.
Releases are cut from tags like `v0.1.0-alpha.1`.

## Unreleased

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
