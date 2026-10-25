"""Try one public playlist read, without a user session. Never log tokens/bodies."""
import json
from pathlib import Path
import time
from urllib.parse import urlsplit

from spotapi import PublicPlaylist
from spotapi.http.request import TLSClient

LAB = Path(__file__).resolve().parents[1]


def main():
    attempts = []
    original_send = TLSClient._send

    def observed_send(self, method, url, **kwargs):
        parts = urlsplit(str(url))
        attempt = {"method": str(method), "host": parts.hostname, "path": parts.path}
        attempts.append(attempt)
        kwargs.setdefault("timeout", 10)
        try:
            response = original_send(self, method, url, **kwargs)
            attempt["status"] = response.status_code
            return response
        except Exception as error:
            attempt["error_type"] = type(error).__name__
            raise

    TLSClient._send = observed_send
    result = {"candidate": "spotapi-python", "mode": "public_read_without_user_login", "authenticated_account": False}
    started = time.monotonic()
    try:
        client = TLSClient("chrome120", "", auto_retries=0)
        playlist = PublicPlaylist("37i9dQZF1DXcBWIGoYBM5M", client=client)
        response = playlist.get_playlist_info(limit=1)
        # A JSON response can contain GraphQL errors despite HTTP 200.
        node = response.get("data", {}).get("playlistV2") or {}
        content = node.get("content") or {}
        items = content.get("items")
        result["status"] = "passed" if isinstance(items, list) and items and not response.get("errors") else "failed"
        result["has_graphql_errors"] = bool(response.get("errors"))
        result["response_top_level_keys"] = sorted(response.keys())
        result["playlist_node_keys"] = sorted(node.keys())
        result["tracks_returned"] = len(items) if isinstance(items, list) else 0
    except Exception as error:
        result["status"] = "failed"
        result["error_type"] = type(error).__name__
    finally:
        result["duration_seconds"] = round(time.monotonic() - started, 2)
        result["http_attempts"] = attempts
        destination = LAB / "results" / "spotapi-public.json"
        destination.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result, indent=2))
    if result["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
