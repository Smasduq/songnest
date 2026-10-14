# errors.md — running error log

Every error encountered goes here. Delete an entry when it is fixed.
Format: `- [ ] <where> — <what> (<date>)`, checked when fixed.

## Open

- [ ] 2026-10-04 media fetch throttling — googlevideo URLs serve the first ~1MB range (206) then 403 every subsequent range (same/new connection, paced, fresh resolve). Plain/open-range GETs 403 too. yt-dlp's full-file-capable clients serve sequential 1MB chunks 206/206. Workaround in direct download: 1MB chunks, pacing, re-resolve+backoff resume, global 403→cooldown. Full downloads from datacenter IPs currently fail; residential/phone IPs untested. Auth now via cookies.txt (device flow retired 2026-10-07).
- [ ] 2026-10-07 AppImage WebKit SIGABRT on modern Mesa/Wayland (Arch/Omarchy, i915) — CI built on ubuntu-22.04 froze icu-70-era WebKit into the bundle; renderer aborts minutes into use, app code exonerated. Local mitigation under test: WEBKIT_DISABLE_DMABUF_RENDERER=1. Repo fix: Linux CI moved to ubuntu-24.04. Verify on next alpha AppImage.
- [x] 2026-10-14 AppImage WebKitWebProcess SIGABRT on every song play — bundle shipped GStreamer core with zero plugins, so no AAC/MP4 pipeline could be built (coredump + AppImage extraction proved it). Repo fix: `bundle.linux.appimage.bundleMediaFramework: true` in tauri.conf.json plus `gstreamer1.0-plugins-base/good/libav` + `gstreamer1.0-tools` on the ubuntu-24.04 CI runner (`patchelf` was already there). Verified locally: 266 plugins in bundle, qtdemux/AAC/playbin/PipeWire all load. Awaiting user press-play confirmation on the fixed build.