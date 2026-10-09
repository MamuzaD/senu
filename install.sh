#!/bin/sh
# Install senu from GitHub releases.
#
#   curl -fsSL https://raw.githubusercontent.com/MamuzaD/senu/main/install.sh | sh
#
# Env:
#   SENU_VERSION      release tag to install, e.g. v0.1.0 (default: latest)
#   SENU_INSTALL_DIR  where to put the binary (default: ~/.local/bin)
#   SENU_BASE_URL     download base, assets fetched from $SENU_BASE_URL/<asset>

set -eu

REPO="MamuzaD/senu"

say() { printf 'senu: %s\n' "$*"; }
warn() { printf 'senu: warning: %s\n' "$*" >&2; }
die() {
  printf 'senu: error: %s\n' "$*" >&2
  exit 1
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "need curl or wget"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "need sha256sum or shasum to verify the download"
  fi
}

detect_asset() {
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die "unsupported OS: $(uname -s) (senu runs on macOS and Linux)" ;;
  esac

  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) die "unsupported architecture: $(uname -m) (need arm64 or x86_64)" ;;
  esac

  # A shell running under Rosetta reports x86_64 on Apple silicon.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
    [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi

  echo "senu-$os-$arch"
}

main() {
  asset=$(detect_asset)
  version=${SENU_VERSION:-latest}
  install_dir=${SENU_INSTALL_DIR:-$HOME/.local/bin}

  if [ -n "${SENU_BASE_URL:-}" ]; then
    base=${SENU_BASE_URL%/}
  elif [ "$version" = latest ]; then
    base="https://github.com/$REPO/releases/latest/download"
  else
    base="https://github.com/$REPO/releases/download/$version"
  fi

  staged=
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t senu)
  trap 'rm -rf "$tmp"; [ -z "$staged" ] || rm -f "$staged"' EXIT
  trap 'exit 1' HUP INT TERM

  say "downloading $asset ($version)"
  fetch "$base/$asset" "$tmp/$asset" || die "download failed: $base/$asset"
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "download failed: $base/SHA256SUMS"

  expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f {print $1; exit}' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || die "no checksum for $asset in SHA256SUMS"
  actual=$(sha256 "$tmp/$asset")
  [ "$expected" = "$actual" ] || die "checksum mismatch for $asset (expected $expected, got $actual)"

  # An update replaces an existing senu and skips the first-run setup tips.
  upgrade=
  [ ! -e "$install_dir/senu" ] || upgrade=1

  mkdir -p "$install_dir" || die "cannot create $install_dir"
  chmod 755 "$tmp/$asset"
  # Stage beside the target so the final mv is an atomic rename.
  staged="$install_dir/.senu.tmp.$$"
  cp "$tmp/$asset" "$staged" || die "cannot write to $install_dir"
  mv -f "$staged" "$install_dir/senu" || die "cannot install to $install_dir/senu"
  staged=
  say "installed $install_dir/senu"
  [ -z "$upgrade" ] || return 0

  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) warn "$install_dir is not on your PATH; add it to your shell profile" ;;
  esac

  command -v tmux >/dev/null 2>&1 || warn "tmux not found; senu needs tmux to watch agents"
  say "next: add the lines from https://github.com/$REPO/blob/main/tmux.example.conf to your tmux.conf"
}

main "$@"
