# Architecture (one page)

## Crates (`crates/`)

- `server` — the whole backend: axum HTTP API, app state, queue workers,
  source matching/resolution, tagging, downloader health and updates.
  `Backend` selects the source layer (subprocess-based default; an
  optional pure-Rust backend behind a cargo feature).
- `cli` — thin CLI: `serve` (HTTP server + workers), single-shot
  search-and-save, and an extractor test harness (feature-gated).
- `extract` — the `Extractor` trait (search/resolve) plus an optional
  pure-Rust implementation. Without the feature it is types only.
- `core` — placeholder crate (a stub function); nothing depends on it yet.

## Frontend (`web/src`)

React + Vite + Tailwind. The player store (`player/store.ts`, zustand)
owns a module-level audio element outside React; UI components
(`song-card`, `now-playing`, `mini-player`, `player-bar`, `sidebar`,
`header`) are views over it. `lib/api.ts` is the HTTP client; the
server URL is a build default overridable in Settings (stored locally).

## Desktop/mobile (`web/src-tauri`)

Desktop spawns `songnest-cli serve` as a sidecar with the app data dir
and kills it on exit. Mobile can run the same server in-process on
device localhost (feature-gated); otherwise the app talks to a server
on the local network.

## Data flow

Search (public catalog API) → match (source search + scoring, cached in
the `yt_match` SQLite table) → resolve (`/stream/:video_id`: local file
first, else a cached playable URL proxied with range support and one
fresh re-resolve on 403) → cache (resolved URLs, 1h) → play (audio
element over queue + library). Queue path: `POST /api/enqueue` →
at most 2 workers → save + tag (`music/`) → library row in `library.db`
(`tracks`, `downloads`, `liked`, `yt_match` tables).

Throttled sources trigger request pacing and a 5-minute cooldown that
pauses resolving and downloading. Runtime state lives in the data dir:
`library.db`, `music/`, settings/cookie files, extractor caches.
