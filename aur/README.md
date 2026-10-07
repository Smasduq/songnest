# AUR package: songnest-bin

Binary AUR package — repacks the official `_amd64.deb` from GitHub releases.
No compilation, no `-git` VCS juggling.

## First-time submit (maintainer, needs an AUR account + SSH key)

```sh
cd aur/songnest-bin
git clone ssh://aur@aur.archlinux.org/songnest-bin.git /tmp/aur-push
cp PKGBUILD .SRCINFO /tmp/aur-push/
cd /tmp/aur-push
git add PKGBUILD .SRCINFO
git commit -m "Initial import"
git push
```

## After each upstream release

```sh
./aur/update.sh   # refreshes pkgver, source URL, sha256sums, .SRCINFO
# then copy PKGBUILD + .SRCINFO into your aur/songnest-bin checkout, commit, push
```

Notes:

- `sha256sums=('SKIP')` until the first real release exists (there are no
  release assets yet, so checksums can't be computed). Run `./update.sh`
  once `v0.1.0-alpha.1` assets are published, then submit.
- `_amd64.deb` naming follows the Tauri v2 bundler convention; `update.sh`
  detects the real name, so a mismatch self-heals on first run.
