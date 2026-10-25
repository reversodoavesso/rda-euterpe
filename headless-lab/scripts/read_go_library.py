"""Read-only account smoke test. Requires a paired lab daemon on localhost."""
import argparse
import json
from pathlib import Path
import urllib.error
import urllib.request
from urllib.parse import urlencode
import time

LAB = Path(__file__).resolve().parents[1]


def get(path):
    with urllib.request.urlopen("http://127.0.0.1:18378" + path, timeout=30) as response:
        data = response.read()
        return response.status, json.loads(data) if data else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true", help="Read every page of playlists")
    parser.add_argument("--context", action="store_true", help="Also inspect one small editable playlist, without playing it")
    args = parser.parse_args()
    report = {"candidate": "go-librespot", "mode": "authenticated_read_only", "mutations_performed": False}
    try:
        status, library = get("/library/playlists?offset=0&limit=25")
        report["http_status"] = status
        if status == 204:
            report["status"] = "not_authenticated"
        elif status == 200 and isinstance(library, dict) and isinstance(library.get("items"), list) and isinstance(library.get("total"), int):
            # Persist counts and schema only; no playlist names, URIs or account IDs.
            report["response_keys"] = sorted(library.keys())
            for key, value in library.items():
                if isinstance(value, list):
                    report[f"{key}_count"] = len(value)
                    if value and isinstance(value[0], dict):
                        report[f"{key}_item_keys"] = sorted(value[0].keys())
                elif key in ("total", "offset", "limit", "next_offset"):
                    report[key] = value
            report["status"] = "passed"
            all_items = list(library["items"])
            pages = 1
            if args.all:
                while len(all_items) < library["total"]:
                    page_status, page = get("/library/playlists?" + urlencode({"offset": len(all_items), "limit": 25}))
                    if page_status != 200 or not isinstance(page, dict) or not page.get("items"):
                        raise ValueError("Pagination did not return the expected next page")
                    all_items.extend(page["items"])
                    pages += 1
                    if pages > 1000:
                        raise ValueError("Pagination exceeded the lab limit")
                report["pagination"] = {"pages": pages, "items_returned": len(all_items),
                                        "complete": len(all_items) == library["total"]}
            if args.context:
                candidates = [item for item in all_items if item.get("can_edit") and 0 < item.get("length", 0) <= 800]
                if not candidates:
                    report["context_read"] = {"status": "no_suitable_playlist"}
                else:
                    preferred = [item for item in candidates if 20 <= item["length"] <= 100] or candidates
                    selected = min(preferred, key=lambda item: item["length"])
                    context = {}
                    deadline = time.monotonic() + 60
                    while time.monotonic() < deadline:
                        code, context = get("/context/tracks?" + urlencode({"uri": selected["uri"]}))
                        if code != 200 or not isinstance(context, dict):
                            raise ValueError("Unexpected context response")
                        if context.get("ready") and context.get("cached") == context.get("length"):
                            break
                        time.sleep(1)
                    report["context_read"] = {
                        "status": "passed" if context.get("ready") and context.get("length") == selected["length"] and context.get("cached") == context.get("length") else "incomplete",
                        "declared_length": selected["length"], "returned_length": context.get("length"),
                        "cached_metadata": context.get("cached"), "ready": context.get("ready"),
                        "playback_started": False,
                    }
        else:
            report["status"] = "unexpected_response"
    except urllib.error.HTTPError as error:
        report["status"] = "failed"
        report["http_status"] = error.code
    except (OSError, ValueError) as error:
        report["status"] = "failed"
        report["error_type"] = type(error).__name__
    (LAB / "results" / "go-account-read.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    if report["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
