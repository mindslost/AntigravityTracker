#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Antigravity Tracker — GNOME Shell Extension Packager
#
# Generates a clean, validated extension zip bundle ready for submission
# to extensions.gnome.org (EGO).
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build"

UUID="antigravity-tracker@mindslost.com"
ZIP_NAME="${UUID}.shell-extension.zip"

echo "╭──────────────────────────────────────────────╮"
echo "│  Antigravity Tracker — Extension Packager    │"
echo "╰──────────────────────────────────────────────╯"
echo ""

mkdir -p "$BUILD_DIR"

# Ensure executable permissions on helper script
chmod +x "$PROJECT_DIR/discover_server.py"

echo "→ Packaging extension with gnome-extensions pack..."
gnome-extensions pack \
    --extra-source=discover_server.py \
    --extra-source=icons \
    --extra-source=stylesheet.css \
    --extra-source=LICENSE \
    --force \
    --out-dir="$BUILD_DIR" \
    "$PROJECT_DIR"

echo "✓ Bundle created at: $BUILD_DIR/$ZIP_NAME"
echo ""
echo "Archive contents:"
unzip -l "$BUILD_DIR/$ZIP_NAME"
echo ""
echo "Ready for upload to: https://extensions.gnome.org/upload/"
