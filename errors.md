# errors.md — running error log

Every error encountered goes here. Delete an entry when it is fixed.
Format: `- [ ] <where> — <what> (<date>)`, checked when fixed.

## Open

- [ ] 2026-10-04 rustypipe media fetch throttling — iOS-client googlevideo URLs serve the first ~1MB range (206) then 403 every subsequent range (same/new connection, paced, fresh resolve). Plain/open-range GETs 403 too. Only full-file-capable client observed is yt-dlp's VISIONOS (`-g` URL serves sequential 1MB chunks 206/206). Workaround in `download_rustypipe`: 1MB chunks, 1s pacing, re-resolve+backoff resume, global 403→cooldown. Full downloads from datacenter IPs currently fail; residential/phone IPs untested.
- [ ] 2026-10-04 rustypipe 0.11.4 `DeobfData::extract` fails ("could not extract sig fn name" on fresh cache, then 24h lockout per storage dir) — YouTube player-JS changed, only the iOS client (no deobf needed) resolves. Needs upstream update; `CLIENTS` order already tries Android first so it self-heals when upstream fixes parsing.

## Fixed

- [x] 2026-10-04 `rustypipe visitor_data.rs:113 unwrap on Err(Http("error decoding response body"))` — panicked instead of returning Err on `extract SlPhMPnQ58k`. Transient (retry succeeded 3/3 resolve + search OK 2026-10-04). Contained in `crates/extract/src/rustypipe_impl.rs`: `player_guarded`/`search_guarded` run queries in spawned tasks so the upstream panic becomes `JoinError→Err`, plus 2–3x retry with backoff. Added `cli search <query>` test path. Upstream still unwraps (rustypipe 0.11.4, https://codeberg.org/ThetaDev/rustypipe) — keep guard until upstream returns Err.
