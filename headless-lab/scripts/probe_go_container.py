"""Boot the real Linux daemon and test its pre-login API, then stop/remove it."""
import json
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

LAB = Path(__file__).resolve().parents[1]
IMAGE = "euterpe-headless-lab-go:bd3fa74"


def get(path):
    try:
        with urllib.request.urlopen("http://127.0.0.1:18379" + path, timeout=2) as response:
            data = response.read()
            return response.status, json.loads(data) if data else None
    except urllib.error.HTTPError as error:
        return error.code, None


def main():
    private = LAB / "private"
    private.mkdir(parents=True, exist_ok=True)
    # A fresh state directory prevents reuse of any authenticated session.
    state = Path(tempfile.mkdtemp(prefix="go-container-probe-", dir=private))
    config = LAB / "configs" / "go-librespot.yml"
    command = [
        "docker", "run", "-d", "--rm", "-p", "127.0.0.1:18379:3678",
        "--mount", f"type=bind,source={state},target=/config",
        "--mount", f"type=bind,source={config},target=/config/config.yml,readonly",
        IMAGE,
    ]
    container = subprocess.check_output(command, text=True).strip()
    report = {"candidate": "go-librespot", "mode": "linux_container_pre_login", "authenticated_account": False}
    try:
        deadline = time.monotonic() + 35
        last_error = None
        while time.monotonic() < deadline:
            try:
                status, pairing = get("/auth/code")
                report["pairing_endpoint_status"] = status
                if status == 200 and isinstance(pairing, dict):
                    # Only presence/shape is recorded. Pairing codes and URLs are private.
                    report["pairing_response_keys"] = sorted(pairing.keys())
                    report["pairing_details_available"] = bool(pairing.get("code") and pairing.get("url") and pairing.get("expires_at"))
                    break
            except (OSError, ValueError) as error:
                last_error = type(error).__name__
            time.sleep(0.5)
        status, body = get("/status")
        report["status_endpoint_status"] = status
        status, body = get("/library/playlists")
        report["library_before_login_status"] = status
        report["status"] = "passed" if report.get("pairing_details_available") and report.get("status_endpoint_status") == 204 and report.get("library_before_login_status") == 204 else "failed"
        if report["status"] == "failed":
            report["last_error_type"] = last_error
        report["image_id"] = subprocess.check_output(
            ["docker", "image", "inspect", "--format", "{{.Id}}", IMAGE], text=True
        ).strip()
    except Exception as error:
        report["status"] = "failed"
        report["error_type"] = type(error).__name__
    finally:
        with (LAB / "runs" / "go-container-private.log").open("w", encoding="utf-8") as log:
            subprocess.run(["docker", "logs", container], stdout=log, stderr=subprocess.STDOUT)
        subprocess.run(["docker", "stop", "--time", "5", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (LAB / "results" / "go-container.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))
    if report["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
