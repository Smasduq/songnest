# Install Songnest via a package manager

All packages track GitHub releases — every published version stays installable.

## Debian / Ubuntu (apt)

```sh
echo "deb [trusted=yes] https://raw.githubusercontent.com/Smasduq/songnest/pkg stable main" \
  | sudo tee /etc/apt/sources.list.d/songnest.list
sudo apt update
sudo apt install songnest
```

Any version:

```sh
sudo apt install songnest=0.1.0-alpha.1
apt list -a songnest   # all available versions
```

The repo is published unsigned for now (alpha), hence `[trusted=yes]`.
It is rebuilt automatically from each release's `.deb` bundles, so new
versions appear without reinstalling anything.

## Fedora / RHEL (dnf)

```sh
sudo tee /etc/yum.repos.d/songnest.repo <<'EOF'
[songnest]
name=Songnest
baseurl=https://raw.githubusercontent.com/Smasduq/songnest/pkg/rpms
enabled=1
gpgcheck=0
EOF
sudo dnf install songnest
```

Any version: `sudo dnf install songnest-0.1.0-alpha.1`.

## Arch Linux (AUR)

Binary package (repacks the official `.deb`):

```sh
yay -S songnest
# or: paru -S songnest
```

The AUR package is maintained from `aur/songnest/` in this repo.

## Rust (cargo)

Installs the `songnest` backend/server binary:

```sh
cargo install songnest
songnest serve   # backend API + queue workers (http://127.0.0.1:8787)
```

Check available versions: `cargo search songnest`.
