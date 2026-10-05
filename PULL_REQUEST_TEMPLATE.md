<!-- Keep PRs small and focused: one concern per PR. -->

## What

## Why

## Checks

- [ ] `cargo test --workspace`
- [ ] `cargo clippy --workspace` (no new warnings)
- [ ] `cd web && npm run build` and `npm run lint`
- [ ] No binaries, databases, media files, cookies, tokens, or personal
      data in the diff (`git status` is clean apart from intended files)

## Notes for reviewers

<!--
Does this PR touch source selection, rate-limit handling, or update logic?
Say so explicitly. Rules: no features that circumvent DRM, paywalls, or
access controls; no third-party branding in UI, assets, or docs.
-->
