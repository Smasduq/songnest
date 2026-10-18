---
name: songnest-changelog-releases
description: "Use when preparing Songnest changelog entries, GitHub release notes, version tags, or a release. Summarize features, improvements, fixes, and security changes, and credit verified contributors with GitHub @mentions."
---

# Songnest changelog and releases

Prepare Songnest changelog entries and release notes in the style used by
[Omarchy's GitHub releases](https://github.com/omacom/omarchy/releases): group
changes by category, describe what changed in plain language, and credit the
contributor inline as `by @username in #PR`.

## Workflow

1. Read `CHANGELOG.md`, `CONTRIBUTING.md`, and
   `.github/workflows/publish-alpha.yml`. Check the worktree before editing;
   preserve unrelated changes.
2. Establish the release range from the latest published GitHub release and
   its tag, using `gh release list` and `git tag`. If the target version or
   release range is unclear, ask before choosing one.
3. Review the commits and merged pull requests since the previous release.
   Read the actual diff or PR description for each meaningful change; don't
   turn raw commit subjects into release notes.
4. Group the changes under only the headings that apply: `Features`,
   `Improvements`, `Fixes`, `Security`, or `Maintenance`. Keep each bullet
   specific about the behavior or problem, including affected platforms when
   useful. Skip internal churn that users don't need to know about.
5. Verify each contributor's GitHub login from the associated pull request
   (`gh pr view`) or, for a direct commit, the GitHub commit metadata. Credit
   the person who made the change, not automatically the merger. End each
   relevant bullet with `by @username in #PR`; mention multiple contributors
   when the change was genuinely shared. Never guess a handle or PR number. If
   attribution can't be verified, ask the user or leave the credit out and
   state why.
6. Add the new entry at the top of `CHANGELOG.md`, following its version and
   date heading convention (`## vX.Y.Z — YYYY-MM-DD`). Keep older entries
   intact. Use concise, reader-facing wording rather than copying PR titles.
   Add a short release summary when it helps explain the main theme, and end
   with a verified comparison link from the previous tag to the new tag.
7. Before publishing, confirm the release notes contain every intended
   change, all handles and PR numbers are correct, and the target tag matches
   the version. Run the checks listed in `CONTRIBUTING.md` that apply to the
   release.
8. Inspect the workflow's current trigger and inputs before starting a
   release. Its tag push filter may name a specific version; the manual
   `workflow_dispatch` input accepts a tag. Confirm the target tag and release
   action with the user before pushing a tag or publishing a release.
9. After the release workflow runs, inspect the GitHub release page and report
   the tag, categorized changes, contributor credits, and any failed or
   incomplete build jobs.

## Release-note shape

Use the Songnest version heading, then category headings and short bullets.
For example:

```markdown
## vX.Y.Z — YYYY-MM-DD

Short summary of the release when useful.

### Features

- Add [specific capability and its effect] by @login in #123.

### Fixes

- Fix [specific issue and the behavior users now get] by @login in #124.

**Full Changelog**: https://github.com/Smasduq/songnest/compare/<previous-tag>...<new-tag>
```

Omit empty categories. Include a PR reference when one exists; use Songnest's
short `#number` form. For a direct commit without a PR, retain the verified
`by @login` credit and don't invent a PR reference.

## Songnest release details

- `CHANGELOG.md` is the source for the release notes.
- `publish-alpha.yml` creates or updates the GitHub release and attaches the
  notes from the matching changelog section. It also appends commits after
  the tag under “Late changes,” so cut the tag only after the intended notes
  are ready and check that section before considering the release complete.
- The workflow builds desktop and Android artifacts, then publishes updater
  metadata and release notes. Check every job, not only the release page.
- Don't assume a tag push starts the workflow: verify its configured tag
  filter for the target version first.
