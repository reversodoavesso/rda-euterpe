"""One-shot loopback transfer from Spotify DevTools; secrets stay in private/."""
import argparse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import secrets
import threading

LAB = Path(__file__).resolve().parents[1]
PRIVATE = LAB / "private" / "desktop-migration"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18937)
    args = parser.parse_args()
    PRIVATE.mkdir(parents=True, exist_ok=True)
    nonce = secrets.token_urlsafe(24)
    capture_path = "/capture/" + nonce
    origin = "https://xpui.app.spotify.com"
    script = """void (async () => {
      const token = Spicetify.Platform.AuthorizationAPI.getState().token.accessToken;
      if (!token || typeof token !== 'string') throw new Error('No Spotify token available');
      const reply = await fetch(URL, {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({access_token:token, user_agent:navigator.userAgent})});
      console.info('Euterpe headless lab: local transfer ' + (reply.ok ? 'completed' : 'failed'));
    })().catch(() => console.error('Euterpe headless lab: local transfer failed'));""".replace(
        "URL", json.dumps(f"http://127.0.0.1:{args.port}{capture_path}")
    )
    (PRIVATE / "capture-console.js").write_text(script, encoding="utf-8")
    completed = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send(self, status):
            self.send_response(status)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        def do_OPTIONS(self):
            self.send(204 if self.path == capture_path else 404)

        def do_POST(self):
            if self.path != capture_path or completed.is_set():
                self.send(404)
                return
            if self.headers.get("Origin") != origin:
                self.send(403)
                return
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 16384:
                self.send(400)
                return
            try:
                payload = json.loads(self.rfile.read(length))
                token = payload["access_token"]
                if not isinstance(token, str) or len(token) < 30:
                    raise ValueError("Invalid token shape")
                # Read only this service's account identifier, without logging it.
                prefs = Path(os.environ["APPDATA"]) / "Spotify" / "prefs"
                entries = dict(line.split("=", 1) for line in prefs.read_text(encoding="utf-8").splitlines() if "=" in line)
                username = json.loads(entries["autologin.canonical_username"])
                snapshot = {"access_token": token, "username": username,
                            "user_agent": payload.get("user_agent", ""),
                            "captured_at": datetime.now(timezone.utc).isoformat()}
                destination = PRIVATE / "desktop-auth.json"
                descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                    json.dump(snapshot, output)
                completed.set()
                self.send(204)
            except (KeyError, ValueError, OSError):
                self.send(400)

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    server.timeout = 1
    print("Loopback receiver ready; console script is in private/desktop-migration/.", flush=True)
    deadline = datetime.now(timezone.utc).timestamp() + 300
    try:
        while not completed.is_set() and datetime.now(timezone.utc).timestamp() < deadline:
            server.handle_request()
    finally:
        server.server_close()
    print("Desktop session captured locally." if completed.is_set() else "Capture expired without credentials.", flush=True)
    if not completed.is_set():
        raise SystemExit(1)


if __name__ == "__main__":
    main()
