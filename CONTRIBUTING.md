# Contributing to Songnest

Thanks for helping. This project is early alpha, so small, reviewable
changes are preferred over large rewrites.

## Setup

You need a recent Rust toolchain and Node.js. No other setup is required
for the default build; `yt-dlp` and a JavaScript runtime are optional and,
if you use them, are installed and configured by you (never bundled).

```sh
cargo run -p songnest -- serve   # backend on :8787
cd web && npm install && npm run dev -- --port 1420 --strictPort
```

## Checks (run before opening a PR)

```sh
cargo test --workspace
cargo clippy --workspace
cd web && npm run build   # type check (tsc) + production build
cd web && npm run lint    # oxlint
```

## Code style

- Rust: `cargo fmt`-clean, no new warnings from `clippy`.
- Frontend: TypeScript strict, functional components, existing
  Tailwind/framer-motion patterns. Keep user-visible strings neutral —
  do not name third-party services in UI text.
- Docs and comments describe what the code does, not how to evade
  anyone's rate limits or access controls.

## Pull request rules

- Keep PRs small and focused; one concern per PR.
- PRs must not add features whose purpose is to circumvent DRM,
  paywalls, or access controls.
- PRs must not add branding of third parties (names, logos, or
  look-alike theme names) to the UI, assets, or docs. Descriptive
  technical mentions (e.g. the name of an optional external tool) are fine.
- Do not commit binaries, databases, media files, cookies, tokens, or
  personal data. Check `git status` before pushing.
- A maintainer will run the checks above; make sure they pass first.
