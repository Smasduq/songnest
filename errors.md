# errors.md — running error log

Every error encountered goes here. Delete an entry when it is fixed.
Format: `- [ ] <where> — <what> (<date>)`, checked when fixed.

## Open

(none)

## Fixed

- [x] 2026-10-04 `rustypipe visitor_data.rs:113 unwrap on Err(Http("error decoding response body"))` — panicked instead of returning Err on `extract SlPhMPnQ58k`. Transient (retry succeeded 3/3 resolve + search OK 2026-10-04). Contained in `crates/extract/src/rustypipe_impl.rs`: `player_guarded`/`search_guarded` run queries in spawned tasks so the upstream panic becomes `JoinError→Err`, plus 2–3x retry with backoff. Added `cli search <query>` test path. Upstream still unwraps (rustypipe 0.11.4, https://codeberg.org/ThetaDev/rustypipe) — keep guard until upstream returns Err.
