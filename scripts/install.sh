#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Antigravity Tracker — Install Script
#
# Creates a development symlink and enables the extension.
# Run from anywhere; the script auto-detects its project directory.
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

UUID="antigravity-tracker@mindslost.com"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "╭──────────────────────────────────────────────╮"
echo "│  Antigravity Tracker — Extension Installer   │"
echo "╰──────────────────────────────────────────────╯"
echo ""
echo "  UUID:    $UUID"
echo "  Source:  $PROJECT_DIR"
echo "  Target:  $EXT_DIR"
echo ""

# Create parent directory if needed
mkdir -p "$(dirname "$EXT_DIR")"

# Remove existing installation
if [ -L "$EXT_DIR" ]; then
    rm "$EXT_DIR"
    echo "  ✓ Removed existing symlink"
elif [ -d "$EXT_DIR" ]; then
    echo "  ⚠ Removing existing directory installation…"
    rm -rf "$EXT_DIR"
fi

# Create development symlink
ln -s "$PROJECT_DIR" "$EXT_DIR"
echo "  ✓ Symlink created"

# Enable the extension
if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "  ✓ Extension enabled"
else
    echo "  ⚠ Could not enable (you may need to restart GNOME Shell first)"
fi

echo ""
echo "┌─ Next Steps ─────────────────────────────────────────────────────┐"
echo "│                                                                  │"
echo "│  To test in a nested Wayland session (no logout required):       │"
echo "│                                                                  │"
echo "│    MUTTER_DEBUG_DUMMY_MODE_SPECS=1920x1080 \                     │"
echo "│      dbus-run-session gnome-shell --nested --wayland             │"
echo "│                                                                  │"
echo "│  To view extension logs:                                         │"
echo "│                                                                  │"
echo "│    journalctl -f -o cat /usr/bin/gnome-shell                     │"
echo "│                                                                  │"
echo "│  To disable:                                                     │"
echo "│                                                                  │"
echo "│    gnome-extensions disable $UUID               │"
echo "│                                                                  │"
echo "└──────────────────────────────────────────────────────────────────┘"
