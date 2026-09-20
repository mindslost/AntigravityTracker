/* ──────────────────────────────────────────────────────────────────────────────
 * Antigravity Tracker — GNOME Shell Extension
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Jason / mindslost
 *
 * Displays Antigravity AI usage quotas in the top bar. Auto-discovers the
 * local language server, fetches quota data via Connect-RPC, and renders
 * circular progress rings for each model group.
 *
 * Target: GNOME Shell 45–50 (ESM modules, Soup 3.0, Wayland-ready)
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
 * Executes a subprocess asynchronously, returning {stdout, stderr, success}.
 */
function runCommandAsync(argv, cancellable = null) {
    return new Promise((resolve, reject) => {
        try {
            const proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(cancellable);
            proc.communicate_utf8_async(null, cancellable, (p, res) => {
                try {
                    const [ok, stdout, stderr] = p.communicate_utf8_finish(res);
                    resolve({
                        stdout: stdout || '',
                        stderr: stderr || '',
                        success: ok && p.get_successful(),
                    });
                } catch (err) {
                    if (cancellable?.is_cancelled() || err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        resolve({stdout: '', stderr: '', success: false, cancelled: true});
                    } else {
                        reject(err);
                    }
                }
            });
        } catch (e) {
            if (cancellable?.is_cancelled() || e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                resolve({stdout: '', stderr: '', success: false, cancelled: true});
            } else {
                reject(e);
            }
        }
    });
}

/**
 * Discovers the active server (or starts the CLI daemon) via discover_server.py.
 *
 * @param {string} extensionPath - Path to extension directory
 * @param {string[]} [extraArgs] - Optional flags like ['--start'] or ['--stop']
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<{csrfToken: string, ports: number[], pid: number, source: string}|null>}
 */
async function discoverServerAsync(extensionPath, extraArgs = [], cancellable = null) {
    try {
        const scriptPath = GLib.build_filenamev([extensionPath, 'discover_server.py']);
        const res = await runCommandAsync(['/usr/bin/python3', scriptPath, ...extraArgs], cancellable);
        if (!res.success || res.cancelled || cancellable?.is_cancelled()) return null;

        const text = res.stdout.trim();
        if (!text || text === 'null') return null;

        const info = JSON.parse(text);
        if (!info || !info.port || !info.csrfToken) return null;

        return {
            csrfToken: info.csrfToken,
            ports: [info.port],
            pid: info.pid,
            source: info.source || 'cli_daemon',
        };
    } catch (e) {
        if (!cancellable?.is_cancelled()) {
            console.error(`[AntigravityTracker] Discovery error: ${e.message}`);
        }
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
        this._isDiscovering = false;
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

        // Kick off initial server discovery (with auto-start enabled)
        this._startDiscovery(true);
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

        if (this._statusLabel) {
            this._statusLabel.destroy();
            this._statusLabel = null;
        }
        if (this._statusItem) {
            this._statusItem.destroy();
            this._statusItem = null;
        }
        if (this._startDaemonItem) {
            this._startDaemonItem.destroy();
            this._startDaemonItem = null;
        }
        if (this._quotaSection) {
            this._quotaSection.destroy();
            this._quotaSection = null;
        }
        if (this._refreshLabel) {
            this._refreshLabel.destroy();
            this._refreshLabel = null;
        }
        if (this._sourceLabel) {
            this._sourceLabel.destroy();
            this._sourceLabel = null;
        }
        if (this._lastUpdateLabel) {
            this._lastUpdateLabel.destroy();
            this._lastUpdateLabel = null;
        }
        if (this._refreshItem) {
            this._refreshItem.destroy();
            this._refreshItem = null;
        }
        if (this._stopDaemonItem) {
            this._stopDaemonItem.destroy();
            this._stopDaemonItem = null;
        }

        this._groupWidgets = [];
        this._quotaData = null;
        this._serverInfo = null;
        this._activePort = null;
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

        // "Start CLI Daemon" action (visible when disconnected)
        this._startDaemonItem = new PopupMenu.PopupBaseMenuItem({
            reactive: true,
            can_focus: true,
        });
        this._startDaemonItem.add_style_class_name('agt-launch-item');
        const daemonBox = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        const daemonIcon = new St.Label({text: '▶'});
        daemonIcon.set_style('margin-right: 8px;');
        daemonBox.add_child(daemonIcon);
        const daemonLabel = new St.Label({text: 'Start Antigravity Daemon'});
        daemonLabel.add_style_class_name('agt-launch-label');
        daemonBox.add_child(daemonLabel);
        this._startDaemonItem.add_child(daemonBox);
        this._startDaemonItem.connect('activate', () => this._startDaemon());
        this._startDaemonItem.visible = false;
        menu.addMenuItem(this._startDaemonItem);

        // Scrollable section for quota groups
        this._quotaSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._quotaSection);

        // ── Bottom bar: Refresh + source indicator + timestamp ──
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

        this._sourceLabel = new St.Label({text: ''});
        this._sourceLabel.add_style_class_name('agt-source-label');
        this._sourceLabel.set_style('margin-right: 12px;');
        refreshBox.add_child(this._sourceLabel);

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

        // "Stop Daemon" action item (visible when connected to CLI daemon)
        this._stopDaemonItem = new PopupMenu.PopupBaseMenuItem({
            reactive: true,
            can_focus: true,
        });
        const stopBox = new St.BoxLayout({
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        const stopLabel = new St.Label({text: '⏹  Stop Antigravity Daemon'});
        stopLabel.add_style_class_name('agt-stop-label');
        stopBox.add_child(stopLabel);
        this._stopDaemonItem.add_child(stopBox);
        this._stopDaemonItem.connect('activate', () => this._stopDaemon());
        this._stopDaemonItem.visible = false;
        menu.addMenuItem(this._stopDaemonItem);
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
            this._updateMenuState();
            return;
        }

        this._updateMenuState();

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
        if (!data?.groups || !this._indicator || this._cancellable?.is_cancelled()) return;

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

    _updateMenuState() {
        const isConnected = !!(this._serverInfo && this._activePort);

        if (this._statusItem)
            this._statusItem.visible = !isConnected;

        if (this._startDaemonItem)
            this._startDaemonItem.visible = !isConnected;

        if (this._stopDaemonItem)
            this._stopDaemonItem.visible = isConnected;

        if (this._sourceLabel) {
            if (isConnected) {
                this._sourceLabel.text = 'CLI Daemon';
                this._sourceLabel.visible = true;
            } else {
                this._sourceLabel.visible = false;
            }
        }
    }

    async _startDiscovery(autostart = true) {
        if (this._isDiscovering) return;
        if (this._cancellable?.is_cancelled()) return;
        this._isDiscovering = true;

        try {
            const args = autostart ? ['--autostart'] : ['--no-autostart'];
            this._serverInfo = await discoverServerAsync(this.path, args, this._cancellable);
            if (this._cancellable?.is_cancelled() || !this._statusLabel) return;

            if (this._serverInfo) {
                const port = await this._probeConnectPort();
                if (this._cancellable?.is_cancelled() || !this._statusLabel) return;
                if (port) {
                    this._activePort = port;
                    await this._fetchQuota();
                    if (this._cancellable?.is_cancelled() || !this._statusLabel) return;
                    this._startPolling();
                    this._updateMenuState();
                    return;
                }
            }

            // Server not found
            this._statusLabel.text = 'Antigravity not running';
            this._updateMenuState();
            this._scheduleDiscoveryRetry();
        } catch (e) {
            if (this._cancellable?.is_cancelled()) return;
            console.error(`[AntigravityTracker] Discovery error: ${e.message}`);
            if (this._statusLabel) {
                this._statusLabel.text = 'Discovery failed';
                this._updateMenuState();
            }
            this._scheduleDiscoveryRetry();
        } finally {
            this._isDiscovering = false;
        }
    }

    _scheduleDiscoveryRetry() {
        if (this._discoveryTimerId || this._cancellable?.is_cancelled()) return;
        this._discoveryTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, DISCOVERY_RETRY_INTERVAL, () => {
                this._discoveryTimerId = 0;
                if (!this._cancellable?.is_cancelled()) {
                    this._startDiscovery(true);
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /**
     * Start the CLI background daemon and discover it.
     */
    async _startDaemon() {
        if (this._cancellable?.is_cancelled() || !this._statusLabel) return;
        this._statusLabel.text = 'Starting CLI daemon…';
        this._statusItem.visible = true;
        this._startDaemonItem.visible = false;

        const info = await discoverServerAsync(this.path, ['--start'], this._cancellable);
        if (this._cancellable?.is_cancelled() || !this._statusLabel) return;

        if (info && info.ports?.length) {
            this._serverInfo = info;
            this._activePort = info.ports[0];
            await this._fetchQuota();
            if (this._cancellable?.is_cancelled()) return;
            this._startPolling();
        } else {
            this._statusLabel.text = 'Failed to start CLI daemon';
        }
        this._updateMenuState();
    }

    /**
     * Stop the running CLI background daemon.
     */
    async _stopDaemon() {
        this._stopPolling();
        this._serverInfo = null;
        this._activePort = null;
        this._quotaData = null;
        if (this._quotaSection) this._quotaSection.removeAll();

        if (this._cancellable?.is_cancelled() || !this._statusLabel) return;
        this._statusLabel.text = 'Stopping CLI daemon…';
        this._statusItem.visible = true;
        this._updateMenuState();

        await discoverServerAsync(this.path, ['--stop'], this._cancellable);
        if (this._cancellable?.is_cancelled() || !this._statusLabel) return;
        this._statusLabel.text = 'CLI daemon stopped';
        this._updateMenuState();
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
        const certId = message.connect('accept-certificate', () => true);

        try {
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
        } finally {
            if (certId)
                message.disconnect(certId);
        }
    }

    async _fetchQuota() {
        if (!this._serverInfo || !this._activePort) {
            this._startDiscovery(true);
            return;
        }

        try {
            const data = await this._rpcRequest(this._activePort);
            if (this._cancellable?.is_cancelled() || !this._indicator) return;

            this._quotaData = data;
            this._updateQuotaDisplay(data);

            // Update last-refreshed timestamp
            if (this._lastUpdateLabel) {
                const now = new Date();
                this._lastUpdateLabel.text =
                    `Last: ${now.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
            }
            this._updateMenuState();

        } catch (e) {
            if (this._cancellable?.is_cancelled() || !this._indicator) return;

            console.error(`[AntigravityTracker] Fetch error: ${e.message}`);

            // Connection likely stale — clear and retry discovery
            this._activePort = null;
            this._serverInfo = null;
            this._stopPolling();
            if (this._statusLabel) {
                this._statusLabel.text = 'Connection lost — retrying…';
            }
            this._updateMenuState();
            this._scheduleDiscoveryRetry();
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
