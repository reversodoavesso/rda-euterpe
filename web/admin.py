"""Container-local account provisioning. All secrets arrive on stdin, never argv."""
import json
import os
import sys
from pathlib import Path

from server import APIError, Store, Workers


def main():
    os.umask(0o077)
    request = json.load(sys.stdin)
    store = Store(os.getenv("WEB_DATA_DIR", "/data"))
    bootstrap = store.root / "bootstrap-credentials.json"
    if bootstrap.exists():
        os.chmod(bootstrap, 0o600)
    username = request.get("username", "local")
    with store.db() as c:
        row = c.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    if row:
        user = store.user(row["id"])
    elif request.get("action") == "provision":
        user = store.register(request)
    else:
        raise APIError("account_not_found", 404)
    if request.get("spotify_state"):
        spotify = request["spotify_state"]
        if not all((spotify.get("device_id"), spotify.get("credentials", {}).get("username"), spotify.get("credentials", {}).get("data"))):
            raise APIError("invalid_spotify_state")
        workers = Workers(store)
        try:
            root = workers.folder(user)
            target = root / "spotify/state.json"
            if not target.exists():
                with target.open("x", encoding="utf-8") as f:
                    json.dump(spotify, f)
                os.chmod(target, 0o600)
                uid = 20000 + user["number"]
                os.chown(target, uid, uid)
        finally:
            workers.close()
    print(json.dumps({"id": user["id"], "username": user["username"], "access_path": "/access/" + store.ticket(user["id"])}))


if __name__ == "__main__":
    try:
        main()
    except APIError as error:
        print(json.dumps({"error": error.code}))
        sys.exit(1)
