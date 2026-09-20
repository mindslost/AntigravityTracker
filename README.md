# Antigravity Tracker

A GNOME Shell extension that displays your [Antigravity](https://antigravity.google) AI usage quotas in the top bar.

![Screenshot](docs/screenshot.png)

## Features

- **Top bar indicator** — system monitor icon in the GNOME Shell panel
- **Quota dashboard** — click to see remaining usage for all model groups:
  - **Gemini Models** (Flash, Pro) — weekly & 5-hour limits
  - **Claude and GPT models** (Opus, Sonnet, GPT-OSS) — weekly & 5-hour limits
- **Circular progress rings** — color-coded: green (>50%), amber (25–50%), red (<25%)
- **Auto-discovery** — automatically finds the running Antigravity language server
- **Periodic refresh** — polls every 2 minutes; also refreshes on menu open

## Requirements

- **GNOME Shell 45–50** (Fedora, Ubuntu 24.04+, Debian, Arch, openSUSE)
- **Google Antigravity CLI** (`agy`)
- **Python 3** (standard library only)

## Installation

### From Source (Development)

```bash
chmod +x scripts/install.sh
./scripts/install.sh
```

This creates a symlink from the project directory into `~/.local/share/gnome-shell/extensions/` and enables the extension.

### Packaging for GNOME Extensions (EGO)

To build a clean `.zip` bundle for upload to [extensions.gnome.org](https://extensions.gnome.org/upload/):

```bash
chmod +x scripts/package.sh
./scripts/package.sh
```

The resulting bundle is saved in `build/antigravity-tracker@mindslost.com.shell-extension.zip`.

### Manual Installation

```bash
# Copy to extensions directory
mkdir -p ~/.local/share/gnome-shell/extensions/antigravity-tracker@mindslost.com
cp -r metadata.json extension.js stylesheet.css discover_server.py icons/ LICENSE ~/.local/share/gnome-shell/extensions/antigravity-tracker@mindslost.com/

# Enable
gnome-extensions enable antigravity-tracker@mindslost.com
```

### After installing

On Wayland, you may need to **log out and back in** for GNOME Shell to register newly added extensions. Alternatively, test with a nested session:

```bash
MUTTER_DEBUG_DUMMY_MODE_SPECS=1920x1080 dbus-run-session gnome-shell --nested --wayland
```

## How It Works

The extension auto-discovers the local language server by:

1. Checking for a running `agy remote-control serve` CLI daemon via `/proc`
2. Automatically starting the headless CLI daemon if it is not currently running
3. Extracting the local listening port and CSRF authentication token from process memory/environment
4. Querying `RetrieveUserQuotaSummary` over local loopback TLS Connect-RPC (`127.0.0.1`)

All communication is strictly local (`127.0.0.1`) — no telemetry or credentials ever leave your machine.

## Debugging

```bash
# View GNOME Shell logs
journalctl -f -o cat /usr/bin/gnome-shell

# Check extension status
gnome-extensions info antigravity-tracker@mindslost.com

# Disable
gnome-extensions disable antigravity-tracker@mindslost.com
```

## Project Structure

```
├── metadata.json          # Extension manifest (UUID, GNOME versions, URL)
├── extension.js           # Main GNOME Shell extension logic (ESM)
├── discover_server.py     # Local daemon discovery & auto-start helper
├── stylesheet.css         # UI styling matching Antigravity aesthetics
├── icons/                 # Symbolic gauge icon
├── scripts/
│   ├── install.sh         # Development symlink installer
│   └── package.sh         # EGO submission zip packager
├── LICENSE                # GNU General Public License v3.0
└── README.md              # Project documentation
```

## License

GNU General Public License v3.0 or later ([GPL-3.0-or-later](LICENSE)).
