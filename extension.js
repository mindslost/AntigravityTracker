/* ──────────────────────────────────────────────────────────────────────────────
 * Antigravity Tracker — GNOME Shell Extension
 *
 * Displays Antigravity AI usage quotas in the top bar. Auto-discovers the
 * local language server, fetches quota data via Connect-RPC, and renders
 * circular progress rings for each model group.
 *
 * Target: GNOME Shell 48–50 (ESM modules, Soup 3.0, Wayland-only)
 * ────────────────────────────────────────────────────────────────────────── */

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Promisify Soup 3.0 async methods for async/await
Gio._promisify(
    Soup.Session.prototype,
    'send_and_read_async',
    'send_and_read_finish'
);

// ─── Constants ───────────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 120;        // seconds between quota polls
const DISCOVERY_RETRY_INTERVAL = 30; // seconds between server discovery retries
const CONNECT_TIMEOUT = 10;          // HTTP request timeout in seconds
const RPC_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';

// Color palette (RGBA) — matches the Antigravity dark theme
const COLOR_GREEN  = [0.298, 0.686, 0.314, 1.0]; // #4CAF50
const COLOR_AMBER  = [1.0,   0.757, 0.027, 1.0]; // #FFC107
const COLOR_RED    = [0.898, 0.224, 0.208, 1.0]; // #E53935
const COLOR_TRACK  = [0.35,  0.35,  0.35,  0.5]; // dim gray track

// ─── Circular Progress Ring Widget ───────────────────────────────────────────

const CircularProgress = GObject.registerClass(
class CircularProgress extends St.DrawingArea {
    /**
     * @param {number} size - Diameter in pixels
     * @param {number} lineWidth - Stroke width of the ring
     */
    _init(size = 32, lineWidth = 3.5) {
        super._init({width: size, height: size});
        this._lineWidth = lineWidth;
        this._fraction = 1.0;
    }

    set fraction(value) {
        this._fraction = Math.max(0, Math.min(1, value));
        this.queue_repaint();
    }

    get fraction() {
        return this._fraction;
    }

    /** Pick ring color based on remaining fraction. */
    _getProgressColor() {
        if (this._fraction > 0.50) return COLOR_GREEN;
        if (this._fraction > 0.25) return COLOR_AMBER;
        return COLOR_RED;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();

        if (width <= 0 || height <= 0) {
            cr.$dispose();
            return;
        }

        const cx = width / 2;
        const cy = height / 2;
        const radius = Math.min(width, height) / 2 - this._lineWidth;
        const startAngle = -Math.PI / 2; // 12-o'clock position

        // Background track circle
        cr.setLineWidth(this._lineWidth);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(...COLOR_TRACK);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        // Foreground progress arc
        if (this._fraction > 0.002) {
            const color = this._getProgressColor();
            cr.setSourceRGBA(...color);
            cr.setLineWidth(this._lineWidth);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.arc(cx, cy, radius, startAngle,
                startAngle + 2 * Math.PI * this._fraction);
            cr.stroke();
        }

        cr.$dispose(); // prevent GJS Cairo memory leak
    }
});

// ─── Server Auto-Discovery ───────────────────────────────────────────────────

/**
 * Scans running processes for an Antigravity `language_server` instance,
 * extracts its CSRF token and listening TCP ports.
 *
 * @returns {{csrfToken: string, ports: number[], pid: number}|null}
 */
function discoverServer() {
    try {
        // Step 1 — Find the language_server process and its CSRF token
        const [ok, stdout] = GLib.spawn_command_line_sync(
            '/bin/bash -c "ps -eo pid,args 2>/dev/null | grep language_server | grep csrf_token | grep -v grep"'
        );
        if (!ok) return null;

        const output = new TextDecoder().decode(stdout).trim();
        if (!output) return null;

        const csrfMatch = output.match(/--csrf_token\s+(\S+)/);
        if (!csrfMatch) return null;
        const csrfToken = csrfMatch[1];

        const pidMatch = output.match(/^\s*(\d+)/m);
        if (!pidMatch) return null;
        const pid = parseInt(pidMatch[1]);

        // Step 2 — Find loopback listening ports for this PID
        const [ok2, stdout2] = GLib.spawn_command_line_sync(
            `/bin/bash -c "ss -tlnp 2>/dev/null | grep 'pid=${pid},'"`
        );
        if (!ok2) return null;

        const portOutput = new TextDecoder().decode(stdout2);
        const ports = [...portOutput.matchAll(/127\.0\.0\.1:(\d+)/g)]
            .map(m => parseInt(m[1]))
            .filter(p => p > 1024);

        if (ports.length === 0) return null;

        return {csrfToken, ports, pid};
    } catch (e) {
        console.error(`[AntigravityTracker] Discovery error: ${e.message}`);
        return null;
    }
}

// ─── Main Extension ──────────────────────────────────────────────────────────

export default class AntigravityTrackerExtension extends Extension {

    // ── Lifecycle ────────────────────────────────────────────────────────

    enable() {
        this._cancellable = new Gio.Cancellable();
        this._httpSession = new Soup.Session({timeout: CONNECT_TIMEOUT});
        this._serverInfo = null;
        this._activePort = null;
        this._quotaData = null;
        this._timerId = 0;
        this._discoveryTimerId = 0;
        this._groupWidgets = [];

        // Panel button with custom gauge icon
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        const iconFile = Gio.File.new_for_path(GLib.build_filenamev([
            this.path, 'icons', 'antigravity-tracker-symbolic.svg',
        ]));
        const icon = new St.Icon({
            gicon: new Gio.FileIcon({file: iconFile}),
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);

        this._buildMenu();

        Main.panel.addToStatusArea(this.metadata.uuid, this._indicator);

        // Refresh data whenever the popup opens
        this._menuOpenId = this._indicator.menu.connect(
            'open-state-changed', (_menu, isOpen) => {
                if (isOpen) this._fetchQuota();
            }
        );

        // Kick off initial server discovery
        this._startDiscovery();
    }

    disable() {
        this._stopPolling();

        if (this._discoveryTimerId) {
            GLib.source_remove(this._discoveryTimerId);
            this._discoveryTimerId = 0;
        }

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._httpSession) {
            this._httpSession.abort();
            this._httpSession = null;
        }

        if (this._indicator) {
            if (this._menuOpenId) {
                this._indicator.menu.disconnect(this._menuOpenId);
                this._menuOpenId = 0;
            }
            this._indicator.destroy();
            this._indicator = null;
        }

        this._groupWidgets = [];
        this._quotaData = null;
        this._serverInfo = null;
        this._activePort = null;
        this._statusItem = null;
        this._statusLabel = null;
        this._quotaSection = null;
        this._refreshItem = null;
        this._refreshLabel = null;
        this._lastUpdateLabel = null;
        this._launchItem = null;
    }

    // ── Menu Construction ────────────────────────────────────────────────

    _buildMenu() {
        const menu = this._indicator.menu;

        // Status message (visible when not connected)
        this._statusItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._statusLabel = new St.Label({
            text: 'Connecting to Antigravity…',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._statusLabel.add_style_class_name('agt-status-label');
        this._statusItem.add_child(this._statusLabel);
        menu.addMenuItem(this._statusItem);

        // "Launch Antigravity" action (visible when server not found)
        this._launchItem = new PopupMenu.PopupBaseMenuItem({
            reactive: true,
            can_focus: true,
        });
        this._launchItem.add_style_class_name('agt-launch-item');
        const launchBox = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        const launchIcon = new St.Label({text: '🚀'});
        launchIcon.set_style('margin-right: 8px;');
        launchBox.add_child(launchIcon);
        const launchLabel = new St.Label({text: 'Launch Antigravity'});
        launchLabel.add_style_class_name('agt-launch-label');
        launchBox.add_child(launchLabel);
        this._launchItem.add_child(launchBox);
        this._launchItem.connect('activate', () => this._launchAntigravity());
        this._launchItem.visible = false;
        menu.addMenuItem(this._launchItem);

        // Scrollable section for quota groups
        this._quotaSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._quotaSection);

        // ── Bottom bar: Refresh + timestamp ──
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._refreshItem = new PopupMenu.PopupBaseMenuItem({
            reactive: true,
            can_focus: true,
        });

        const refreshBox = new St.BoxLayout({x_expand: true});

        this._refreshLabel = new St.Label({
            text: '↻  Refresh',
            x_expand: true,
        });
        this._refreshLabel.add_style_class_name('agt-refresh-label');
        refreshBox.add_child(this._refreshLabel);

        this._lastUpdateLabel = new St.Label({text: ''});
        this._lastUpdateLabel.add_style_class_name('agt-last-update');
        this._lastUpdateLabel.x_align = Clutter.ActorAlign.END;
        refreshBox.add_child(this._lastUpdateLabel);

        this._refreshItem.add_child(refreshBox);

        // Override activate to prevent the popup from closing on click
        this._refreshItem.activate = (_event) => {
            this._refreshLabel.text = '↻  Refreshing…';
            this._fetchQuota().then(() => {
                if (this._refreshLabel)
                    this._refreshLabel.text = '↻  Refresh';
            });
        };

        menu.addMenuItem(this._refreshItem);
    }

    /**
     * Build (or rebuild) the quota group widgets from API data.
     * Called when the group/bucket structure changes.
     */
    _buildQuotaGroups(data) {
        this._quotaSection.removeAll();
        this._groupWidgets = [];

        if (!data?.groups?.length) {
            this._statusLabel.text = 'No quota data available';
            this._statusItem.visible = true;
            return;
        }

        this._statusItem.visible = false;
        this._launchItem.visible = false;

        for (let gi = 0; gi < data.groups.length; gi++) {
            const group = data.groups[gi];

            // Spacer between groups
            if (gi > 0) {
                const spacer = new PopupMenu.PopupSeparatorMenuItem();
                spacer.add_style_class_name('agt-group-spacer');
                this._quotaSection.addMenuItem(spacer);
            }

            // ── Group header ──
            const headerItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });
            headerItem.add_style_class_name('agt-group-header-item');

            const headerBox = new St.BoxLayout({x_expand: true});
            const headerLabel = new St.Label({
                text: group.displayName,
                x_expand: true,
            });
            headerLabel.add_style_class_name('agt-group-header');
            headerBox.add_child(headerLabel);

            // Info icon showing group description on hover
            if (group.description) {
                const infoIcon = new St.Label({text: 'ⓘ'});
                infoIcon.add_style_class_name('agt-info-icon');
                infoIcon.y_align = Clutter.ActorAlign.CENTER;
                headerBox.add_child(infoIcon);
            }

            headerItem.add_child(headerBox);
            this._quotaSection.addMenuItem(headerItem);

            // ── Bucket rows ──
            const groupEntry = {groupName: group.displayName, buckets: []};

            for (let bi = 0; bi < group.buckets.length; bi++) {
                const bucket = group.buckets[bi];

                // Thin separator between buckets in the same group
                if (bi > 0) {
                    const sep = new PopupMenu.PopupSeparatorMenuItem();
                    sep.add_style_class_name('agt-bucket-separator');
                    this._quotaSection.addMenuItem(sep);
                }

                const bucketItem = new PopupMenu.PopupBaseMenuItem({
                    reactive: false,
                    can_focus: false,
                });
                bucketItem.add_style_class_name('agt-bucket-item');

                const rowBox = new St.BoxLayout({
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                // Left column — title + description
                const textBox = new St.BoxLayout({
                    vertical: true,
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                const titleLabel = new St.Label({text: bucket.displayName});
                titleLabel.add_style_class_name('agt-bucket-title');
                textBox.add_child(titleLabel);

                let descLabel = null;
                if (bucket.description) {
                    descLabel = new St.Label({text: bucket.description});
                    descLabel.add_style_class_name('agt-bucket-description');
                    descLabel.clutter_text.line_wrap = true;
                    descLabel.clutter_text.line_wrap_mode =
                        Pango.WrapMode.WORD_CHAR;
                    descLabel.clutter_text.ellipsize =
                        Pango.EllipsizeMode.NONE;
                    textBox.add_child(descLabel);
                }

                rowBox.add_child(textBox);

                // Right column — percentage + ring
                const pct = Math.round(bucket.remainingFraction * 100);
                const pctLabel = new St.Label({text: `${pct}%`});
                pctLabel.add_style_class_name('agt-bucket-percentage');
                pctLabel.y_align = Clutter.ActorAlign.CENTER;
                rowBox.add_child(pctLabel);

                const ring = new CircularProgress(32, 3.5);
                ring.fraction = bucket.remainingFraction;
                ring.y_align = Clutter.ActorAlign.CENTER;
                ring.set_style('margin-left: 10px;');
                rowBox.add_child(ring);

                bucketItem.add_child(rowBox);
                this._quotaSection.addMenuItem(bucketItem);

                groupEntry.buckets.push({
                    titleLabel, descLabel, pctLabel, ring,
                    bucketId: bucket.bucketId,
                });
            }

            this._groupWidgets.push(groupEntry);
        }
    }

    /**
     * Update existing widgets in-place with fresh data.
     * Falls back to a full rebuild if the structure has changed.
     */
    _updateQuotaDisplay(data) {
        if (!data?.groups) return;

        // Check if structure changed (different number of groups or buckets)
        const structureMatch = this._groupWidgets.length === data.groups.length
            && this._groupWidgets.every(
                (gw, i) => gw.buckets.length === data.groups[i].buckets.length
            );

        if (!structureMatch) {
            this._buildQuotaGroups(data);
            return;
        }

        // Fast-path: update existing widgets without rebuild
        for (let gi = 0; gi < data.groups.length; gi++) {
            const group = data.groups[gi];
            const gw = this._groupWidgets[gi];

            for (let bi = 0; bi < group.buckets.length; bi++) {
                const bucket = group.buckets[bi];
                const bw = gw.buckets[bi];

                const pct = Math.round(bucket.remainingFraction * 100);
                bw.pctLabel.text = `${pct}%`;
                bw.ring.fraction = bucket.remainingFraction;
                bw.titleLabel.text = bucket.displayName;
                if (bw.descLabel && bucket.description)
                    bw.descLabel.text = bucket.description;
            }
        }
    }

    // ── Server Discovery & Connection ────────────────────────────────────

    async _startDiscovery() {
        this._serverInfo = discoverServer();

        if (this._serverInfo) {
            const port = await this._probeConnectPort();
            if (port) {
                this._activePort = port;
                await this._fetchQuota();
                this._startPolling();
                return;
            }
        }

        // Server not found — show status and offer to launch
        this._statusLabel.text = 'Antigravity not running';
        this._statusItem.visible = true;
        this._launchItem.visible = !!this._findAntigravityBinary();
        this._scheduleDiscoveryRetry();
    }

    _scheduleDiscoveryRetry() {
        if (this._discoveryTimerId) return;
        this._discoveryTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, DISCOVERY_RETRY_INTERVAL, () => {
                this._discoveryTimerId = 0;
                this._startDiscovery();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /**
     * Probe each discovered port to find the one serving Connect-RPC.
     * @returns {Promise<number|null>}
     */
    async _probeConnectPort() {
        if (!this._serverInfo) return null;

        for (const port of this._serverInfo.ports) {
            try {
                const result = await this._rpcRequest(port);
                if (result !== null) return port;
            } catch {
                continue; // port didn't respond, try next
            }
        }
        return null;
    }

    // ── Quota Fetching ───────────────────────────────────────────────────

    /**
     * Make a Connect-RPC POST to RetrieveUserQuotaSummary on the given port.
     * @param {number} port
     * @returns {Promise<object|null>} Parsed response data or null
     */
    async _rpcRequest(port) {
        const url = `https://127.0.0.1:${port}${RPC_PATH}`;
        const message = Soup.Message.new('POST', url);

        // Accept the language server's self-signed TLS certificate
        message.connect('accept-certificate', () => true);

        // Connect-RPC headers
        message.request_headers.append('Content-Type', 'application/json');
        message.request_headers.append('Connect-Protocol-Version', '1');
        message.request_headers.append(
            'X-Codeium-Csrf-Token', this._serverInfo.csrfToken
        );

        // Empty JSON body
        message.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(new TextEncoder().encode('{}'))
        );

        const bytes = await this._httpSession.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, this._cancellable
        );

        if (message.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${message.get_status()}`);

        const text = new TextDecoder().decode(bytes.get_data());
        const json = JSON.parse(text);

        // The API wraps data in a "response" envelope
        return json.response || json;
    }

    async _fetchQuota() {
        if (!this._serverInfo || !this._activePort) {
            this._startDiscovery();
            return;
        }

        try {
            const data = await this._rpcRequest(this._activePort);
            this._quotaData = data;
            this._updateQuotaDisplay(data);

            // Update last-refreshed timestamp
            const now = new Date();
            this._lastUpdateLabel.text =
                `Last: ${now.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;

        } catch (e) {
            if (this._cancellable?.is_cancelled()) return;

            console.error(`[AntigravityTracker] Fetch error: ${e.message}`);

            // Connection likely stale — clear and retry discovery
            this._activePort = null;
            this._serverInfo = null;
            this._stopPolling();
            this._statusLabel.text = 'Connection lost — retrying…';
            this._statusItem.visible = true;
            this._launchItem.visible = !!this._findAntigravityBinary();
            this._scheduleDiscoveryRetry();
        }
    }

    // ── Antigravity Launcher ──────────────────────────────────────────────

    /**
     * Search common locations for an Antigravity executable.
     * @returns {string|null} Path to executable, or null
     */
    _findAntigravityBinary() {
        const home = GLib.get_home_dir();
        const candidates = [
            GLib.build_filenamev([home, 'Programs', 'Antigravity', 'antigravity']),
            GLib.build_filenamev([home, '.local', 'share', 'antigravity', 'antigravity']),
            GLib.build_filenamev([home, '.local', 'bin', 'antigravity']),
            '/usr/bin/antigravity',
            '/usr/local/bin/antigravity',
            '/opt/antigravity/antigravity',
        ];

        // Also check PATH
        const inPath = GLib.find_program_in_path('antigravity');
        if (inPath) candidates.unshift(inPath);

        for (const path of candidates) {
            if (path && GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
                return path;
        }
        return null;
    }

    /**
     * Launch the Antigravity desktop app in the background.
     * After launch, schedule a discovery attempt to pick up the new server.
     */
    _launchAntigravity() {
        const binary = this._findAntigravityBinary();
        if (!binary) {
            this._statusLabel.text = 'Antigravity binary not found';
            return;
        }

        try {
            GLib.spawn_command_line_async(binary);
            this._statusLabel.text = 'Launching Antigravity…';
            this._launchItem.visible = false;

            // Give the app time to start its language server, then re-discover
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
                this._startDiscovery();
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            console.error(`[AntigravityTracker] Launch failed: ${e.message}`);
            this._statusLabel.text = `Launch failed: ${e.message}`;
        }
    }

    // ── Timer Management ─────────────────────────────────────────────────

    _startPolling() {
        this._stopPolling();
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL, () => {
                this._fetchQuota();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopPolling() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }
}
