"""Issue and cancel a real pairing code in a separate, empty account instance."""
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from urllib.parse import urlparse
import urllib.error
import urllib.request

LAB = Path(__file__).resolve().parents[1]


def main():
    secret = (LAB / "private/web-pairing-mcp/ws-secret").read_text().strip()
    state = LAB / "private/web-pairing/state.json"
    report = {"checked_at": datetime.now(timezone.utc).isoformat(), "mode": "headless_pairing_code_and_cancel",
              "user_completed_authorization": False, "checks": [], "status": "running"}
    pending = False
    def request(path, method="GET", auth=True):
        headers = {"Authorization": "Bearer " + secret} if auth else {}
        req = urllib.request.Request("http://127.0.0.1:18338" + path, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, json.load(response)
    def check(name, valid):
        if not valid:
            raise RuntimeError("verification_failed:" + name)
        report["checks"].append(name)
    try:
        check("separate_empty_state", not state.exists())
        try:
            request("/spotify/auth", auth=False)
            raise RuntimeError("anonymous_pairing_access")
        except urllib.error.HTTPError as error:
            check("pairing_requires_auth", error.code == 401)
        _, status = request("/spotify/auth")
        check("initially_unpaired", status["status"] == "idle" and status["authenticated"] is False)
        http_status, _ = request("/spotify/auth/start", method="POST")
        check("pairing_start_accepted", http_status == 202)
        pending = True
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            _, status = request("/spotify/auth")
            if status.get("error"):
                raise RuntimeError(status["error"])
            if status.get("user_code"):
                break
            time.sleep(0.25)
        check("real_pairing_code_available", bool(status.get("user_code")))
        url = urlparse(status.get("verification_url", ""))
        check("spotify_verification_url", url.scheme == "https" and (url.hostname == "spotify.com" or url.hostname.endswith(".spotify.com")))
        expiry = datetime.fromisoformat(status["expires_at"].replace("Z", "+00:00"))
        check("code_has_future_expiry", expiry > datetime.now(timezone.utc))
        _, repeated = request("/spotify/auth/start", method="POST")
        check("start_does_not_duplicate_pending_flow", repeated.get("user_code") == status["user_code"])
        _, cancelled = request("/spotify/auth", method="DELETE")
        pending = False
        check("cancel_returns_idle", cancelled["status"] == "idle" and not cancelled["authenticated"])
        _, cancelled = request("/spotify/auth")
        check("cancel_removes_code", not cancelled.get("user_code"))
        check("cancel_saves_no_account", not state.exists())
        report["status"] = "passed"
    except Exception as error:
        report.update(status="failed", error=str(error)[:150])
    finally:
        if pending:
            try:
                request("/spotify/auth", method="DELETE")
            except Exception:
                report["cancel_cleanup"] = "failed"
        (LAB / "results/headless-pairing.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
