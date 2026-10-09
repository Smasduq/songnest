# Fork note: `tauri-plugin-native-audio`

Vendored from crates.io `tauri-plugin-native-audio 1.0.5`
(upstream: https://github.com/uvarov-frontend/tauri-plugin-native-audio,
MIT OR Apache-2.0 — LICENSEs kept in this dir).

## Why a fork

Upstream's Android notification/lockscreen card shows the **app icon**
instead of the song artwork, and disables **prev/next** (play/pause +
rewind/ffwd only). Songnest wants a real music card: cover art +
prev/play/next.

## Songnest changes (all Android/Kotlin; Rust + guest-js untouched)

- `android/.../NativeAudioService.kt`
  - `getCurrentLargeIcon` loads `mediaMetadata.artworkUri` (set from our
    `setSource artworkUrl`) off-thread with downsampling, delivered via
    `BitmapCallback`; app icon stays as the placeholder/fallback.
  - Notification actions: prev + play/pause + next (compact view too);
    rewind/ffwd off.
- `android/.../NativeAudioPlugin.kt`
  - `ForwardingPlayer.seekToNextMediaItem/seekToPreviousMediaItem` send a
    package-scoped broadcast (`<package>.SONGNEST_TRANSPORT_NEXT/PREV`)
    instead of seeking ±10s. `MainActivity` relays it into
    `window.__songnestTransport` (see `web/src/native/background-player.ts`),
    so the store's queue/repeat/shuffle logic stays the single owner.
  - (Upstream used those two overrides for ±10s seek; the notification no
    longer offers rewind/ffwd, so nothing else calls them.)

## Rebasing onto a newer upstream

1. Copy the new crate version over this dir (keep `FORK.md`).
2. Re-apply the two hunks above (both marked with `Songnest:` comments).
3. Keep `version` in sync with the npm `tauri-plugin-native-audio-api`
   dep in `web/package.json` (the JS API is unchanged by this fork).
