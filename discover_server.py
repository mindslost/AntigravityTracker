#!/usr/bin/env python3
"""
Server discovery and auto-start helper for Antigravity Tracker GNOME Shell Extension.
Finds the active Antigravity language server instance (CLI daemon or Desktop app),
extracts its listening port and CSRF token, and optionally auto-starts the CLI daemon
if not running.
"""

import argparse
import glob
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.request

CACHE_FILE = "/tmp/antigravity_tracker_cache.json"
RPC_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary"


def is_pid_alive(pid: int) -> bool:
    """Check if process is still running."""
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def check_rpc(port: int, token: str, timeout: float = 0.6) -> bool:
    """Verify if port and CSRF token respond with quota data."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    req = urllib.request.Request(
        f"https://127.0.0.1:{port}{RPC_PATH}",
        data=b"{}",
        headers={
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "x-codeium-csrf-token": token,
        },
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as resp:
            data = resp.read().decode("utf-8", errors="ignore")
            return "groups" in data
    except Exception:
        return False


def get_cached_server():
    """Check if previously cached server info is still valid."""
    if not os.path.exists(CACHE_FILE):
        return None
    try:
        with open(CACHE_FILE, "r") as f:
            data = json.load(f)
        pid = data.get("pid")
        port = data.get("port")
        token = data.get("csrfToken")
        if pid and port and token and is_pid_alive(pid):
            if check_rpc(port, token, timeout=0.3):
                return data
    except Exception:
        pass
    return None


def save_cache(data: dict):
    """Save server info to temporary cache."""
    try:
        with open(CACHE_FILE, "w") as f:
            json.dump(data, f)
    except Exception:
        pass


def discover_desktop_app():
    """Check for Antigravity desktop Electron app (language_server process)."""
    try:
        output = subprocess.check_output(
            ["/bin/bash", "-c", "ps -eo pid,args 2>/dev/null | grep language_server | grep csrf_token | grep -v grep"],
            text=True,
            timeout=1.0,
        )
    except Exception:
        return None

    if not output.strip():
        return None

    pid_match = re.search(r"^\s*(\d+)", output, re.MULTILINE)
    csrf_match = re.search(r"--csrf_token\s+(\S+)", output)
    if not pid_match or not csrf_match:
        return None

    pid = int(pid_match.group(1))
    csrf_token = csrf_match.group(1)

    # Find listening ports via ss
    try:
        ss_out = subprocess.check_output(
            ["/bin/bash", "-c", f"ss -tlnp 2>/dev/null | grep 'pid={pid},'"],
            text=True,
            timeout=1.0,
        )
        ports = [int(p) for p in re.findall(r"127\.0\.0\.1:(\d+)", ss_out) if int(p) > 1024]
    except Exception:
        ports = []

    for port in ports:
        if check_rpc(port, csrf_token, timeout=0.5):
            res = {"pid": pid, "port": port, "csrfToken": csrf_token, "source": "desktop_app"}
            save_cache(res)
            return res

    return None


def get_cli_daemon_pid() -> int | None:
    """Get PID of running antigravity-cli-daemon."""
    # Method 1: systemd user service
    try:
        val = subprocess.check_output(
            ["systemctl", "--user", "show", "antigravity-cli-daemon.service", "--property=MainPID", "--value"],
            text=True,
            timeout=1.0,
        ).strip()
        if val and val != "0":
            pid = int(val)
            if is_pid_alive(pid):
                return pid
    except Exception:
        pass

    # Method 2: pgrep for agy remote-control serve
    try:
        pids = subprocess.check_output(
            ["pgrep", "-f", "agy remote-control serve"],
            text=True,
            timeout=1.0,
        ).split()
        if pids:
            pid = int(pids[0])
            if is_pid_alive(pid):
                return pid
    except Exception:
        pass

    return None


def start_cli_daemon() -> bool:
    """Start the CLI daemon via systemd user service or agy CLI."""
    # Method 1: systemctl --user start
    try:
        res = subprocess.run(
            ["systemctl", "--user", "start", "antigravity-cli-daemon.service"],
            timeout=3.0,
            capture_output=True,
        )
        if res.returncode == 0:
            return True
    except Exception:
        pass

    # Method 2: agy remote-control start --session
    home = os.path.expanduser("~")
    for agy_path in [
        os.path.join(home, ".local", "bin", "agy"),
        os.path.join(home, ".gemini", "bin", "agy"),
        "/usr/local/bin/agy",
        "/usr/bin/agy",
    ]:
        if os.path.isfile(agy_path) and os.access(agy_path, os.X_OK):
            try:
                res = subprocess.run(
                    [agy_path, "remote-control", "start", "--session"],
                    timeout=4.0,
                    capture_output=True,
                )
                if res.returncode == 0:
                    return True
            except Exception:
                pass

    return False


def get_cli_daemon_port(pid: int) -> int | None:
    """Find the HTTPS port of the CLI daemon."""
    # Try reading from the daemon's open stdout/stderr fd
    try:
        fd1 = os.readlink(f"/proc/{pid}/fd/1")
        if os.path.exists(fd1):
            with open(fd1, "r", errors="ignore") as f:
                for line in f:
                    m = re.search(r"listening on random port at (\d+) for HTTPS", line)
                    if m:
                        return int(m.group(1))
    except Exception:
        pass

    # Fallback to the latest CLI log file
    home = os.path.expanduser("~")
    logs = sorted(
        glob.glob(os.path.join(home, ".gemini", "antigravity-cli", "log", "cli-*.log")),
        key=os.path.getmtime,
        reverse=True,
    )
    if logs:
        try:
            with open(logs[0], "r", errors="ignore") as f:
                for line in f:
                    m = re.search(r"listening on random port at (\d+) for HTTPS", line)
                    if m:
                        return int(m.group(1))
        except Exception:
            pass

    # Fallback: scan listening ports for this PID
    try:
        ss_out = subprocess.check_output(
            ["/bin/bash", "-c", f"ss -tlnp 2>/dev/null | grep 'pid={pid},'"],
            text=True,
            timeout=1.0,
        )
        ports = [int(p) for p in re.findall(r"127\.0\.0\.1:(\d+)", ss_out) if int(p) > 1024]
        if ports:
            return max(ports)
    except Exception:
        pass

    return None


def extract_csrf_token_from_mem(pid: int, port: int) -> str | None:
    """Scans agy process heap memory for the active CSRF token UUID."""
    try:
        with open(f"/proc/{pid}/maps", "r") as f:
            maps = f.readlines()
    except Exception:
        return None

    candidate_uuids = []
    uuid_pattern = re.compile(rb"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

    try:
        with open(f"/proc/{pid}/mem", "rb", 0) as mem:
            for line in maps:
                parts = line.split()
                if len(parts) >= 2 and "rw" in parts[1]:
                    addr_range = parts[0].split("-")
                    start, end = int(addr_range[0], 16), int(addr_range[1], 16)
                    if 1024 * 1024 <= (end - start) <= 150 * 1024 * 1024:
                        try:
                            mem.seek(start)
                            data = mem.read(end - start)
                            for match in uuid_pattern.finditer(data):
                                u = match.group(0).decode("ascii")
                                if u not in candidate_uuids:
                                    candidate_uuids.append(u)
                        except Exception:
                            continue
    except Exception:
        return None

    for u in candidate_uuids:
        if check_rpc(port, u, timeout=0.4):
            return u

    return None


def stop_cli_daemon() -> bool:
    """Stop the CLI daemon via systemd user service or agy CLI."""
    try:
        subprocess.run(
            ["systemctl", "--user", "stop", "antigravity-cli-daemon.service"],
            timeout=5.0,
            capture_output=True,
        )
    except Exception:
        pass

    try:
        if os.path.exists(CACHE_FILE):
            os.remove(CACHE_FILE)
    except Exception:
        pass

    # Ensure any remaining agy serve process is stopped
    try:
        subprocess.run(["pkill", "-f", "agy remote-control serve"], timeout=2.0)
    except Exception:
        pass
    return True


def discover_cli_daemon(autostart: bool = True):
    """Discover the running CLI daemon, optionally auto-starting it."""
    pid = get_cli_daemon_pid()

    if not pid and autostart:
        if start_cli_daemon():
            for _ in range(25):  # wait up to 5s for PID
                time.sleep(0.2)
                pid = get_cli_daemon_pid()
                if pid:
                    break

    if not pid:
        return None

    # Wait up to 6s for the language server port to become available
    port = None
    for _ in range(30):
        port = get_cli_daemon_port(pid)
        if port:
            break
        time.sleep(0.2)

    if not port:
        return None

    # Extract CSRF token from process memory (retry up to 5s while daemon initializes)
    token = None
    for _ in range(15):
        token = extract_csrf_token_from_mem(pid, port)
        if token:
            break
        time.sleep(0.3)

    if not token:
        return None

    res = {"pid": pid, "port": port, "csrfToken": token, "source": "cli_daemon"}
    save_cache(res)
    return res


def main():
    parser = argparse.ArgumentParser(description="Antigravity Server Discovery & Management")
    parser.add_argument("--autostart", action="store_true", default=True, help="Auto-start CLI daemon if not running")
    parser.add_argument("--no-autostart", action="store_false", dest="autostart", help="Do not auto-start CLI daemon")
    parser.add_argument("--status-only", action="store_true", help="Only check if server is currently running")
    parser.add_argument("--start", action="store_true", help="Explicitly start the CLI daemon")
    parser.add_argument("--stop", action="store_true", help="Explicitly stop the CLI daemon")
    parser.add_argument("--restart", action="store_true", help="Explicitly restart the CLI daemon")
    args = parser.parse_args()

    if args.stop:
        stop_cli_daemon()
        print(json.dumps({"status": "stopped"}))
        return 0

    if args.start or args.restart:
        if args.restart:
            stop_cli_daemon()
            time.sleep(0.5)
        daemon = discover_cli_daemon(autostart=True)
        print(json.dumps(daemon))
        return 0 if daemon else 1

    # 1. Quick check: cached valid session
    cached = get_cached_server()
    if cached:
        print(json.dumps(cached))
        return 0

    # 2. Discover or auto-start CLI daemon (preferred by user)
    daemon = discover_cli_daemon(autostart=args.autostart and not args.status_only)
    if daemon:
        print(json.dumps(daemon))
        return 0

    # 3. Fallback: check desktop app if actively running
    desktop = discover_desktop_app()
    if desktop:
        print(json.dumps(desktop))
        return 0

    print(json.dumps(None))
    return 1


if __name__ == "__main__":
    sys.exit(main())
