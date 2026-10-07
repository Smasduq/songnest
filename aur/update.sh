#!/usr/bin/env bash
# Refresh PKGBUILD + .SRCINFO from the latest GitHub release.
# Finds the actual *_amd64.deb asset (no naming assumptions), updates
# pkgver/_upstreamver/source URL, downloads the .deb, and recomputes sums.
set -euo pipefail
cd "$(dirname "$0")/songnest"

TAG=$(gh release list --repo Smasduq/songnest --limit 1 --json tagName -q '.[0].tagName')
echo "latest tag: $TAG"
ASSET=$(gh release view "$TAG" --repo Smasduq/songnest --json assets -q \
  '.assets[].name' | grep -m1 '_amd64\.deb$' || true)
if [ -z "$ASSET" ]; then
  echo "ERROR: no *_amd64.deb on $TAG yet" >&2
  exit 1
fi
echo "asset: $ASSET"

UPSTREAM="${TAG#v}"
PKGVER="${UPSTREAM//-/.}"

sed -i -E \
  -e "s/^pkgver=.*/pkgver=$PKGVER/" \
  -e "s/^pkgrel=.*/pkgrel=1/" \
  -e "s/^_upstreamver=.*/_upstreamver=$UPSTREAM/" \
  PKGBUILD

rm -f "$ASSET"
gh release download "$TAG" --repo Smasduq/songnest --pattern "$ASSET" --dir .
SUM=$(sha256sum "$ASSET" | cut -d' ' -f1)
rm -f "$ASSET"
sed -i -E "s/^sha256sums=.*/sha256sums=('$SUM')/" PKGBUILD

makepkg --printsrcinfo > .SRCINFO
echo "updated to $TAG ($ASSET)"
echo "verify with: makepkg -sri   (or: namcap PKGBUILD)"
