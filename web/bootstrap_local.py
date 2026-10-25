"""Provision this user's explicitly authorized migrated Spotify session in Web.

Run after docker compose up. Outputs a one-use access URL only. The generated
password stays in the ignored private directory and is never passed as argv.
"""
import json
from pathlib import Path
import secrets
import subprocess


def main():
    project = Path(__file__).resolve().parents[1]
    private = project / "headless-lab/private/web"
    private.mkdir(parents=True, exist_ok=True)
    credentials = private / "bootstrap-credentials.json"
    if credentials.exists():
        login = json.loads(credentials.read_text(encoding="utf-8"))
    else:
        login = {"username": "local", "display_name": "Seu espaço", "password": secrets.token_urlsafe(24)}
        credentials.write_text(json.dumps(login, ensure_ascii=False, indent=2), encoding="utf-8")
    payload = {**login, "action": "provision"}
    source = project / "headless-lab/private/desktop-migration/go-librespot/state.json"
    if source.exists():
        payload["spotify_state"] = json.loads(source.read_text(encoding="utf-8"))
    result = subprocess.run(["docker", "compose", "-f", str(project / "headless-lab/compose.web.yml"), "exec", "-T", "web", "python3", "/opt/euterpe-web/admin.py"], input=json.dumps(payload), text=True, capture_output=True, check=False)
    if result.returncode:
        raise SystemExit("Provisioning failed; inspect container status. No credentials were printed.")
    data = json.loads(result.stdout)
    if "access_path" not in data:
        raise SystemExit("Provisioning failed.")
    print("http://127.0.0.1:18339" + data["access_path"])


if __name__ == "__main__":
    main()
