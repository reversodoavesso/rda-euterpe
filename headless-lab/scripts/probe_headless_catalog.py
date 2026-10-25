"""Read-only MCP checks for headless search, liked songs and metadata."""
from datetime import datetime, timezone
import json
from pathlib import Path
import urllib.request

LAB = Path(__file__).resolve().parents[1]


def main():
    secret = (LAB / "private/headless-mcp/ws-secret").read_text().strip()
    report = {"mode": "headless_catalog_read_only", "checked_at": datetime.now(timezone.utc).isoformat(),
              "mutations_performed": False, "checks": [], "status": "running"}
    def call(name, args):
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "spotify_" + name, "arguments": args}}
        req = urllib.request.Request("http://127.0.0.1:18337/mcp", data=json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=40) as response:
            result = json.load(response)["result"]
        data = json.loads(result["content"][0]["text"])
        if result.get("isError"):
            raise RuntimeError(data.get("code", "mcp_error"))
        return data
    def check(name, valid):
        if not valid:
            raise RuntimeError("verification_failed:" + name)
        report["checks"].append(name)
    stage = "search"
    try:
        found = call("search_spotify", {"q": "Miles Davis", "types": "track,artist,album,playlist", "limit": 3})
        report["search_counts"] = {k: len(found[k]) for k in ("tracks", "artists", "albums", "playlists")}
        check("search_four_categories", all(0 < n <= 3 for n in report["search_counts"].values()))
        check("search_entity_ids", all(item.get("id") and item.get("uri") and item.get("name") for kind in report["search_counts"] for item in found[kind]))
        stage = "metadata"
        uri = found["tracks"][0]["uri"]
        tracks = call("get_several_tracks", {"ids": [uri.rsplit(":", 1)[1], uri]})
        check("batch_metadata_order_and_duplicates", len(tracks) == 2 and all(t["uri"] == uri for t in tracks))
        check("batch_metadata_fields", all(t.get("name") and t.get("artists") and t.get("duration_ms", 0) > 0 for t in tracks))
        stage = "liked"
        saved = call("get_saved_tracks", {"limit": 3})
        next_page = call("get_saved_tracks", {"limit": 2, "offset": 1})
        report["liked_returned"] = len(saved)
        check("liked_read_with_added_dates", len(saved) == 3 and all(t.get("added_at") and t.get("uri") for t in saved))
        check("liked_offset", [t["uri"] for t in saved[1:]] == [t["uri"] for t in next_page])
        dates = [datetime.fromisoformat(t["added_at"].replace("Z", "+00:00")) for t in saved]
        check("liked_newest_first", dates == sorted(dates, reverse=True))
        stage = "resolve"
        resolved = call("resolve_tracks", {"tracks": [{"artist": "Miles Davis", "title": "So What"}, uri, uri]})
        check("resolve_names_and_uris", resolved["total"] == 3 and all(r["matched"] for r in resolved["results"]))
        check("resolve_unique_uris", resolved["resolved_count"] == len(set(resolved["uris"])))
        check("resolve_preserves_input_order", resolved["results"][1]["uri"] == uri and resolved["results"][2]["uri"] == uri)
        report["status"] = "passed"
    except Exception as error:
        report.update(status="failed", stage=stage, error=str(error)[:150])
    (LAB / "results/headless-catalog.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
