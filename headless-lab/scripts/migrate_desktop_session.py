"""Bootstrap a lab daemon from the captured desktop token; verify stored reconnect."""
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

LAB = Path(__file__).resolve().parents[1]
PRIVATE = LAB / "private/desktop-migration"
NAME = "euterpe-headless-lab-desktop-session"
IMAGE = "euterpe-headless-lab-go:bd3fa74"


def read_library():
    try:
        with urllib.request.urlopen("http://127.0.0.1:18378/library/playlists?offset=0&limit=25", timeout=3) as response:
            body = response.read()
            return response.status, json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        return error.code, None


def wait_library(seconds=60):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        try:
            status, data = read_library()
            last = {"http_status": status}
            if status == 200 and isinstance(data, dict) and isinstance(data.get("items"), list):
                return data
        except (OSError, ValueError) as error:
            last = {"error_type": type(error).__name__}
        time.sleep(0.5)
    raise RuntimeError("Library did not become ready: " + json.dumps(last))


def public_library(data):
    return {"total": data.get("total"), "items_returned": len(data["items"]),
            "response_keys": sorted(data.keys()),
            "item_keys": sorted(data["items"][0].keys()) if data["items"] else []}


def main():
    auth = json.loads((PRIVATE / "desktop-auth.json").read_text(encoding="utf-8"))
    state_dir = PRIVATE / "go-librespot"
    state_dir.mkdir(exist_ok=True)
    config_path = state_dir / "config.yml"
    config = {
        "device_name": "Euterpe Headless Lab", "device_type": "computer", "log_level": "info",
        "zeroconf_enabled": False,
        "credentials": {"type": "spotify_token", "spotify_token": {"username": auth["username"], "access_token": auth["access_token"]}},
        "server": {"enabled": True, "address": "0.0.0.0", "port": 3678},
        "audio_backend": "pipe", "audio_output_pipe": "/tmp/euterpe-headless-audio", "audio_output_pipe_wait_for_reader": True,
        "prefer_firewall_friendly_ports": True,
        "metadata": {"enabled": True, "context_sweep": False, "max_tracks": 800},
    }
    existing = subprocess.check_output(["docker", "ps", "-a", "--filter", "name=^/" + NAME + "$", "--format", "{{.ID}}"], text=True).strip()
    if existing:
        raise RuntimeError("The named migration container already exists; inspect it before rerunning")
    config_path.write_text(json.dumps(config), encoding="utf-8")
    command = ["docker", "run", "-d", "--name", NAME,
               "--label", "euterpe.lab=desktop-migration", "-p", "127.0.0.1:18378:3678",
               "--mount", f"type=bind,source={state_dir},target=/config", IMAGE]
    subprocess.run(command, stdout=subprocess.DEVNULL, check=True)
    report = {"candidate": "go-librespot", "mode": "desktop_session_migration_read_only",
              "mutations_performed": False, "playback_started": False}
    try:
        before = wait_library()
        report["first_read"] = public_library(before)
        state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
        creds = state.get("credentials", {})
        report["stored_credentials_created"] = bool(creds.get("data"))
        report["same_account_confirmed"] = creds.get("username") == auth["username"]
        if not report["stored_credentials_created"] or not report["same_account_confirmed"]:
            raise RuntimeError("Persistent credentials/account verification failed")
        # Eliminate the bootstrap access token from the daemon's configuration.
        config["credentials"] = {"type": "device_auth"}
        config_path.write_text(json.dumps(config), encoding="utf-8")
        report["bootstrap_token_removed_from_config"] = True
        subprocess.run(["docker", "restart", "--time", "5", NAME], stdout=subprocess.DEVNULL, check=True)
        after = wait_library()
        report["after_restart_read"] = public_library(after)
        report["same_library_after_restart"] = before.get("total") == after.get("total") and [item.get("uri") for item in before["items"]] == [item.get("uri") for item in after["items"]]
        report["status"] = "passed" if report["same_library_after_restart"] else "failed"
    except Exception as error:
        report["status"] = "failed"
        report["error_type"] = type(error).__name__
    finally:
        # Always remove the temporary access token from config, including failure.
        config["credentials"] = {"type": "device_auth"}
        config_path.write_text(json.dumps(config), encoding="utf-8")
        with (PRIVATE / "daemon.log").open("w", encoding="utf-8") as log:
            subprocess.run(["docker", "logs", NAME], stdout=log, stderr=subprocess.STDOUT)
        (LAB / "results/desktop-migration.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2), flush=True)
    if report["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
