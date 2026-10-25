"""MCP end-to-end probe. --mutations touches only a new disposable lab playlist."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import urllib.request
import uuid

LAB = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:18337")
    parser.add_argument("--mutations", action="store_true")
    parser.add_argument("--resolve-create", action="store_true", help="Also test a named track while creating the disposable playlist")
    args = parser.parse_args()
    if args.resolve_create and not args.mutations:
        parser.error("--resolve-create requires --mutations")
    secret_file = LAB / "private/headless-mcp/ws-secret"
    secret = secret_file.read_text().strip()
    report = {"mode": "headless_mcp", "checked_at": datetime.now(timezone.utc).isoformat(),
              "mutations_requested": args.mutations, "checks": [], "status": "running"}
    journal = LAB / "private/headless-mcp/disposable-playlist.json"
    playlist = None
    stage = "initialize"

    def request(path, body=None, auth=True):
        headers = {"Content-Type": "application/json"}
        if auth:
            headers["Authorization"] = "Bearer " + secret
        req = urllib.request.Request(args.base + path,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers=headers)
        with urllib.request.urlopen(req, timeout=150) as response:
            return json.load(response)

    def rpc(name, arguments):
        response = request("/mcp", {"jsonrpc": "2.0", "id": uuid.uuid4().hex,
                                   "method": "tools/call", "params": {
                                       "name": "spotify_" + name, "arguments": arguments}})
        result = response["result"]
        data = json.loads(result["content"][0]["text"])
        if result.get("isError"):
            code = data.get("code", "mcp_error")
            if data.get("follow_error"):
                code += ":" + data["follow_error"]
            if name == "create_playlist" and data.get("playlist_id"):
                journal.write_text(json.dumps({"playlist_id": data["playlist_id"],
                                               "code": code, "creation_uncertain": True}), encoding="utf-8")
            raise RuntimeError(code)
        return data

    def mutation(name, arguments, proposal_name=None, proposal_args=None, decision="approve"):
        # Match the exact proposal from this probe. Never approve unrelated work.
        expected_name = proposal_name or name
        expected_args = proposal_args if proposal_args is not None else arguments
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(rpc, name, arguments)
            deadline = time.monotonic() + 90
            replied = False
            while not pending.done() and time.monotonic() < deadline:
                proposals = request("/proposals", auth=True)["proposals"]
                for p in proposals:
                    if p["name"] == expected_name and p["args"] == expected_args:
                        request("/proposals/" + p["proposalId"], {"decision": decision}, auth=True)
                        replied = True
                        break
                if replied:
                    break
                time.sleep(0.1)
            result = pending.result()
            if not replied:
                raise RuntimeError("confirmation_was_not_requested")
            return result

    def check(name, condition):
        if not condition:
            raise RuntimeError("verification_failed:" + name)
        report["checks"].append(name)

    def uris():
        return [item["uri"] for item in rpc("get_playlist_tracks", {"playlist_id": playlist})]

    try:
        health = request("/health")
        check("zero_extension_clients", health["clients"] == 0 and health["spotify_backend"] == "headless")
        library = rpc("get_playlists", {})
        report["playlists_total_before"] = library["total"]
        check("authenticated_library_read", library["total"] > 0 and bool(library["playlists"]))
        candidates = [p for p in library["playlists"] if 2 <= p.get("tracks", 0) <= 100]
        tracks = rpc("get_playlist_tracks", {"playlist_id": candidates[0]["id"]})
        seeds = list(dict.fromkeys(t["uri"] for t in tracks if t["uri"].startswith("spotify:track:")))[:2]
        report["read_track_count"] = len(tracks)
        check("track_metadata", len(seeds) == 2 and any(t.get("name") and t.get("artists") for t in tracks))
        try:
            rpc("get_top_tracks", {})
            raise RuntimeError("unsupported_tool_was_silently_accepted")
        except RuntimeError as error:
            check("unsupported_tool_explicit", str(error) == "unsupported_in_headless")
        if args.mutations:
            a, b = seeds
            label = "Euterpe Headless Lab " + uuid.uuid4().hex[:8]
            stage = "reject_confirmation"
            try:
                mutation("create_playlist", {"name": label + " rejected", "tracks": []}, decision="reject")
                raise RuntimeError("rejected_mutation_executed")
            except RuntimeError as error:
                check("web_rejection", str(error) == "user_rejected")
            stage = "create"
            created = mutation("create_playlist", {"name": label, "description": "Disposable headless migration test", "tracks": ["Miles Davis - So What"] if args.resolve_create else []})
            playlist = created["playlist_id"]
            journal.write_text(json.dumps({"playlist_id": playlist, "name": label, "cleanup_needed": True}), encoding="utf-8")
            if args.resolve_create:
                check("create_resolves_track_names", len(uris()) == 1)
                mutation("replace_playlist_tracks", {"playlist_id": playlist, "uris": []})
            check("create_empty", uris() == [])
            stage = "append"
            mutation("add_tracks", {"playlist_id": playlist, "uris": [a, b, a]})
            check("append_deduplicates_input", uris() == [a, b])
            mutation("add_tracks", {"playlist_id": playlist, "uris": [a]})
            check("append_keeps_existing_duplicates", uris() == [a, b, a])
            stage = "replace"
            mutation("replace_playlist_tracks", {"playlist_id": playlist, "uris": [b, a, a]})
            check("replace_order_and_duplicates", uris() == [b, a, a])
            stage = "undo"
            mutation("undo_last_mutation", {"playlist_id": playlist},
                     proposal_name="replace_playlist_tracks",
                     proposal_args={"playlist_id": playlist, "uris": [a, b, a]})
            check("server_undo_snapshot", uris() == [a, b, a])
            stage = "details"
            patch = {"playlist_id": playlist, "name": label + " verified", "description": "Verified headless write"}
            mutation("set_playlist_details", patch)
            updated = next(p for p in rpc("get_playlists", {})["playlists"] if p["id"] == playlist)
            check("name_and_description", updated["name"] == patch["name"] and updated["description"] == patch["description"])
            mutation("set_playlist_details", {"playlist_id": playlist, "description": ""})
            updated = next(p for p in rpc("get_playlists", {})["playlists"] if p["id"] == playlist)
            check("clear_description_only", updated["description"] == "" and updated["name"] == patch["name"])
            stage = "remove"
            mutation("remove_tracks", {"playlist_id": playlist, "uris": [a]})
            check("remove_all_duplicate_occurrences", uris() == [b])
            mutation("replace_playlist_tracks", {"playlist_id": playlist, "uris": []})
            check("replace_with_empty", uris() == [])
        report["status"] = "passed"
    except Exception as error:
        report.update(status="failed", stage=stage, error=str(error)[:150])
    finally:
        if playlist:
            try:
                deleted = mutation("delete_playlist", {"playlist_id": playlist})
                check("disposable_playlist_unfollowed", deleted["deleted_count"] == 1)
                after = rpc("get_playlists", {})
                report["playlists_total_after"] = after["total"]
                check("original_library_count_restored", after["total"] == report["playlists_total_before"])
                journal.write_text(json.dumps({"playlist_id": playlist, "cleanup_needed": False}), encoding="utf-8")
                report["cleanup"] = "passed"
            except Exception as error:
                report.update(status="failed", cleanup="failed", cleanup_error=str(error)[:150])
        (LAB / "results/headless-mcp.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
