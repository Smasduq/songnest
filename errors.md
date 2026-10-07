# errors.md — running error log

Every error encountered goes here. Delete an entry when it is fixed.
Format: `- [ ] <where> — <what> (<date>)`, checked when fixed.

## Open

- [ ] 2026-10-04 media fetch throttling — googlevideo URLs serve the first ~1MB range (206) then 403 every subsequent range (same/new connection, paced, fresh resolve). Plain/open-range GETs 403 too. yt-dlp's full-file-capable clients serve sequential 1MB chunks 206/206. Workaround in direct download: 1MB chunks, pacing, re-resolve+backoff resume, global 403→cooldown. Full downloads from datacenter IPs currently fail; residential/phone IPs untested. Auth now via cookies.txt (device flow retired 2026-10-07).

## Fixed

- [x] 2026-10-07 Android launch SIGABRT — JNI FindClass from Rust worker threads resolves against the wrong class loader: ClassNotFoundException stayed pending at thread detach and ART aborted every launch. Fixed in crates/extract/src/songnestpy.rs: resolve Chaquopy classes through the Activity's class loader + clear pending Java exceptions before detach. Verified on-device, zero warnings on host and aarch64 checks.
- [x] 2026-10-07 search hits silently dropped — yt-dlp durations arrive as floats and flat rows can miss fields; as_u64 + `?` discarded every hit. Fixed: accept f64, tolerate missing title/duration/channel.
- [x] 2026-10-07 default-build dead_code warnings (download_direct/audio_ext/cached_mime) after ungating the direct-fetch path. Fixed: feature-gate with the on-device backend.
- [x] 2026-10-07 borrow of moved `func` into a spawn_blocking closure (crates/extract/src/songnestpy.rs). Fixed: clone outside the closure.
- [x] 2026-10-07 TV device-code sign-in retired with the backend swap (endpoints now 409/410; auth is cookies.txt via POST /api/cookies + Diagnostics UI). Closed the 2026-10-05 sign-in entry untested.
- [x] 2026-10-05 on-device extraction hardening / 2026-10-04 deobf failure / visitor_data panic guard — SUPERSEDED 2026-10-07: backend replaced by on-device yt-dlp, code and patches removed.
- [x] 2026-10-07 CI setup-android@v3 dies (installs the removed `tools` package). Fixed: drive sdkmanager directly (platform-tools, android-36, build-tools, pinned NDK).
- [x] 2026-10-07 CI `platforms;android-37` missing — 37 is a preview, not on the stable repo. Fixed: compileSdk/targetSdk 36.
- [x] 2026-10-07 CI `--apk true` rejected (`--apk` is a flag). Fixed: bare `--apk`.
- [x] 2026-10-07 CI mobile builds: `resource path bin doesn't exist` (sidecar is desktop-only). Fixed: tauri.android/ios.conf.json override resources to [].
- [x] 2026-10-07 CI Windows MSI rejects the alpha prerelease (must be numeric-only). Fixed: NSIS-only for pre-releases.
- [x] 2026-10-07 release creation "Resource not accessible by integration" on an early dispatch run; later runs created/attached to the release fine. No action.
- [x] 2026-10-07 device-test ghost: stale `adb reverse` looped phone:8787 back to the PC server, looking like a rogue on-device backend. Fixed: removed; verify device servers via forward only.
- [x] 2026-10-07 tsc failed on a mid-save file during concurrent editing; clean on forced re-run. Process note, no code change.
