#!/usr/bin/env sh
# Canvazz installer / updater.
#
#   curl -fsSL https://raw.githubusercontent.com/pedrobzz/canvazz/main/install.sh | sh
#
# Downloads the latest standalone canvazz binary into ~/.local/bin and verifies
# its checksum. Re-run any time to update. The prebuilt binary is darwin-arm64
# (Apple Silicon) only — other platforms build from source (see the README).
#
# Env overrides:
#   CANVAZZ_VERSION   release tag to install (default: latest), e.g. v0.2.0
#   CANVAZZ_BIN_DIR   install directory (default: ~/.local/bin)
set -eu

REPO="pedrobzz/canvazz"
ASSET="canvazz-darwin-arm64"
BIN_DIR="${CANVAZZ_BIN_DIR:-$HOME/.local/bin}"
VERSION="${CANVAZZ_VERSION:-latest}"

err() { printf '%s\n' "$*" >&2; }

os="$(uname -s)"
arch="$(uname -m)"
if [ "$os" != "Darwin" ] || [ "$arch" != "arm64" ]; then
  err "canvazz prebuilt binaries are darwin-arm64 (Apple Silicon) only."
  err "Detected: $os $arch"
  err ""
  err "On other platforms, run from source:"
  err "  git clone https://github.com/$REPO.git"
  err "  cd canvazz && bun install && bun run dev"
  exit 1
fi

for cmd in curl shasum; do
  command -v "$cmd" >/dev/null 2>&1 || { err "Required command not found: $cmd"; exit 1; }
done

if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp="$(mktemp)"
sha_tmp="$tmp.sha256"
cleanup() { rm -f "$tmp" "$sha_tmp"; }
trap cleanup EXIT INT TERM

printf 'Downloading canvazz (%s, darwin-arm64)...\n' "$VERSION"
curl -fSL --proto '=https' --tlsv1.2 --progress-bar "$base/$ASSET" -o "$tmp"

if curl -fsSL --proto '=https' "$base/$ASSET.sha256" -o "$sha_tmp" 2>/dev/null; then
  expected="$(awk '{print $1}' "$sha_tmp")"
  actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  if [ "$expected" != "$actual" ]; then
    err "Checksum mismatch — refusing to install."
    err "  expected: $expected"
    err "  actual:   $actual"
    exit 1
  fi
  printf 'Checksum verified.\n'
else
  err "Warning: checksum file not found; skipping verification."
fi

mkdir -p "$BIN_DIR"
chmod +x "$tmp"
# Clear any quarantine flag so Gatekeeper doesn't block the fresh binary.
xattr -d com.apple.quarantine "$tmp" 2>/dev/null || true
mv -f "$tmp" "$BIN_DIR/canvazz"
trap - EXIT INT TERM
rm -f "$sha_tmp"

printf 'Installed canvazz -> %s\n' "$BIN_DIR/canvazz"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    err ""
    err "$BIN_DIR is not on your PATH. Add this to your shell profile:"
    err "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

printf '\nRun:  canvazz\n'
printf 'MCP:  claude mcp add --transport http canvazz http://localhost:47823/mcp\n'
