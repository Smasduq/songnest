# Songnest

Songnest is a music library and player with a pluggable source system,
desktop-first, built with Tauri, Rust and React.

> **Status: early alpha. Expect breaking changes.**

What works today:

- Metadata search, suggestions, and a local library with likes.
- Playback of saved tracks, plus proxied streaming for unsaved ones.
- A save-to-library queue (max 2 at a time) with request pacing and
  rate-limit handling, progress, and health reporting.
- Source health and diagnostics screen (backend versions, update status,
  cooldown state).
- Desktop app (Tauri) that spawns and manages the backend automatically.
- Android builds are **experimental** (thin client over your local network).

Planned or experimental:

- Legal-source support — planned.
- Source health checks and updates — available.
- Mobile builds — experimental.
- Local-file import — planned.
- Loudness normalization — planned.

## Screenshots

Current prototype (desktop library view):

![Songnest desktop library](docs/screenshots/desktop-library.png)

## Quick start

Prerequisites: a recent Rust toolchain and Node.js. Optional, installed
and configured by you: `yt-dlp` and a JavaScript runtime (Deno 2.3+, or
Node.js 22+) for source challenge-solving.

```sh
# backend API + queue workers (http://127.0.0.1:8787)
cargo run -p songnest -- serve

# web frontend (dev)
cd web
npm install
npm run dev -- --port 1420 --strictPort

# type check + production frontend build
npm run build

# lint
npm run lint
```

Desktop app (builds the backend binary as a sidecar, then the app):

```sh
cd web
npm run desktop:sidecar
npm run desktop:build
```

Android (experimental thin client; needs the Android SDK):

```sh
cd web
npx tauri android build --apk
```

Tests and checks:

```sh
cargo test --workspace
cargo clippy --workspace
cd web && npm run build
```

## Accounts & liked-songs sync

Optional self-hosted service (`crates/accounts`) for sign-up/sign-in and
syncing likes across devices. It handles **only** accounts and sync — never
music, downloads, or streaming. The app works fully without it.

```sh
# 1. Postgres (localhost only): create user + database
sudo -u postgres psql -c "CREATE USER songnest WITH PASSWORD '...';"
sudo -u postgres psql -c "CREATE DATABASE songnest OWNER songnest;"

# 2. Configure (never commit real secrets)
cp crates/accounts/.env.example crates/accounts/.env
# edit DATABASE_URL + SONGNEST_JWT_SECRET (min 32 random bytes)

# 3. Run (migrations apply automatically; default http://127.0.0.1:8788)
cargo run -p songnest-accounts
```

Postgres must listen on localhost only (`postgresql.conf`:
`listen_addresses = 'localhost'`, plus `pg_hba.conf` scram entries).

Environment variables (full list in `crates/accounts/.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — (required) | Postgres connection |
| `SONGNEST_JWT_SECRET` | — (required, ≥32 bytes) | Access-token HMAC secret |
| `SONGNEST_ACCOUNTS_BIND` | `127.0.0.1:8788` | Bind address (keep loopback) |
| `SONGNEST_ACCESS_TTL_SECS` | `900` | Access-token lifetime |
| `SONGNEST_REFRESH_TTL_SECS` | `2592000` | Refresh-token lifetime |
| `SONGNEST_CORS_ORIGINS` | Vite + Tauri origins | Exact-match CORS allowlist |
| `SONGNEST_AUTH_PER_MINUTE` | `10` | Per-IP auth rate limit |
| `SONGNEST_MAX_BODY_BYTES` | `1048576` | Max JSON body size |

API reference (JSON; errors are `{ "error": "<showable message>" }`):

| Method & path | Auth | Description |
|---|---|---|
| `GET /health` | — | Liveness (pings the DB) |
| `POST /auth/signup` | — (rate-limited) | `{email, password}` → `201` + tokens |
| `POST /auth/login` | — (rate-limited) | `{email, password}` → `200` + tokens |
| `POST /auth/refresh` | — (rate-limited) | `{refresh_token}` → rotated pair |
| `POST /auth/logout` | — (rate-limited) | `{refresh_token}` → always `200` |
| `GET /me` | Bearer | `{id, email}` |
| `GET /sync/likes?since=<cursor>` | Bearer | Changes after cursor (incl. unlikes), oldest first, + new `cursor` |
| `POST /sync/likes` | Bearer | `{changes: [{track_id, liked, updated_at, title?, artist?, album?, cover?}]}` → `{cursor, applied, skipped}` (idempotent) |

Token pair shape: `{user: {id, email}, access_token, refresh_token,
expires_in}`.

Sync model: one row per `(user, track)`, `liked=false` rows are tombstones
so unlikes propagate; conflicts resolve last-write-wins on `updated_at`
(like wins exact ties); the server assigns a monotonic `version` cursor.
Only canonical `dz:<deezer_id>` likes sync — library rows without a Deezer
ID stay local-only (shown as "local only" in the UI).

App wiring: sign in from the sidebar (desktop) or Diagnostics → Songnest
account (mobile), or open `/#signin`. Tokens live in the OS credential
store (localStorage fallback in browser dev). Likes work offline and sync
on launch, login, change, and reconnect with backoff. The accounts base URL
defaults to `http://127.0.0.1:8788`, overridable via `VITE_ACCOUNTS_URL` or
the runtime `songnest-accounts-url` localStorage key.

Deployment (`deploy/`): `Dockerfile.accounts` (build on the ARM VM),
`songnest-accounts.service` (systemd), `Caddyfile` (HTTPS proxy), and
`backup-accounts-db.sh` (nightly `pg_dump` cron). Email verification and
password reset are TODOs (`POST /auth/...` reserved in code comments).

Known limitations: sync trusts device clocks for `updated_at` (skewed
clocks can misorder concurrent two-device edits); the per-IP rate limiter
sees the proxy's loopback IP behind Caddy (per-user throttling is a TODO).

## How it works

- Track metadata comes from a public catalog API.
- A pluggable source layer matches catalog entries to playable audio,
  caches matches and stream URLs, and keeps a local SQLite library.
- Saved tracks live as tagged audio files in the data directory; the
  bundled web UI talks to the local server over HTTP.
- `yt-dlp`, when used, is an optional separate tool installed and
  configured by the user. It is not bundled with Songnest.

## Responsible use

Songnest does not host, distribute, or provide any music. It is a player
and library manager. Users are solely responsible for complying with
copyright law and the terms of any service they connect to, and for the
source of any files they use. Prefer sources with licenses that allow
saving copies (Creative Commons catalogs, music you own).

## Not affiliated

Songnest is not affiliated with or endorsed by any streaming or video
service.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately
as described in [SECURITY.md](SECURITY.md).

## License

Licensed under either of [MIT](LICENSE-MIT) or
[Apache-2.0](LICENSE-APACHE), at your option. Third-party Rust
dependency licenses are listed in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
