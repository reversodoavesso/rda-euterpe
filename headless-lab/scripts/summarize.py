"""Generate a small, shareable report from lab outputs, excluding private logs."""
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

LAB = Path(__file__).resolve().parents[1]


def load(name):
    path = LAB / "results" / name
    return json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else None


def go_summary(name, expected_packages):
    path = LAB / "runs" / name
    if not path.exists():
        return {"status": "not_run"}
    cases, packages = {}, {}
    for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        action = event.get("Action")
        if action not in ("pass", "fail", "skip"):
            continue
        if event.get("Test"):
            cases[(event["Package"], event["Test"])] = action
        else:
            packages[event["Package"]] = action
    # A Go suite and each subtest emit separate pass events. Count leaf cases once.
    leaves = {key: action for key, action in cases.items()
              if not any(other[0] == key[0] and other[1].startswith(key[1] + "/") for other in cases)}
    counts = Counter(leaves.values())
    return {
        "status": "passed" if len(packages) == expected_packages and all(value == "pass" for value in packages.values()) else "failed_or_incomplete",
        "leaf_cases_passed": counts["pass"], "leaf_cases_failed": counts["fail"],
        "leaf_cases_skipped": counts["skip"], "packages": packages,
        "scope": "offline_upstream_unit_tests",
    }


def rust_summary(name):
    path = LAB / "runs" / name
    if not path.exists():
        return {"status": "not_run"}
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    groups = re.findall(r"test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored", text)
    return {
        "status": "passed" if groups and all(group[0] == "ok" for group in groups) and "error:" not in text else "failed_or_incomplete",
        "cases_passed": sum(int(group[1]) for group in groups),
        "cases_failed": sum(int(group[2]) for group in groups),
        "cases_ignored": sum(int(group[3]) for group in groups),
        "scope": "offline_upstream_unit_tests_no_audio_features",
    }


def main():
    java = load("ntify-offline.json")
    ntify = {"status": "not_run"}
    if java:
        counts = Counter(case["status"] for case in java["cases"])
        ntify = {"status": "passed_with_confirmed_gaps" if not counts["failed"] else "failed",
                 "protocol_cases_passed": counts["passed"], "confirmed_gaps": counts["gap_confirmed"],
                 "cases_failed": counts["failed"], "scope": java["mode"]}
    python = {"status": "not_run"}
    xml = LAB / "runs" / "spotapi-offline.xml"
    if xml.exists():
        suites = ET.parse(xml).getroot().iter("testsuite")
        totals = Counter()
        for suite in suites:
            totals.update({key: int(suite.get(key, 0)) for key in ("tests", "failures", "errors", "skipped")})
        python = {"status": "passed" if not totals["failures"] and not totals["errors"] else "failed",
                  **dict(totals), "scope": "unchanged_upstream_offline_tests_staged_without_broken_package_initializer"}
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "authenticated_spotify_operations_validated": False,
        "authenticated_playlist_mutations_validated": False,
        "checks": {
            "ntify": ntify,
            "ntify_public": load("ntify-public.json"),
            "ntify_account": load("ntify-account-read.json"),
            "desktop_migration": load("desktop-migration.json"),
            "headless_mcp": load("headless-mcp.json"),
            "headless_validation": load("headless-validation.json"),
            "headless_catalog": load("headless-catalog.json"),
            "headless_pairing": load("headless-pairing.json"),
            "go_native": go_summary("go-librespot-unit.jsonl", 5),
            "go_linux": go_summary("go-librespot-linux-unit.jsonl", 2),
            "librespot": rust_summary("librespot-unit.log"),
            "spotify_player": rust_summary("spotify-player-unit.log"),
            "spotapi_python": python,
            "go_container": load("go-container.json"),
            "spotapi_public": None,
        },
        "account_read": load("go-account-read.json") or {"status": "pending_user_pairing"},
    }
    public = load("spotapi-public.json")
    if public:
        report["checks"]["spotapi_public"] = {
            key: value for key, value in public.items() if key != "http_attempts"
        }
        report["checks"]["spotapi_public"]["http_requests"] = len(public.get("http_attempts", []))
    if report["account_read"].get("status") == "passed":
        report["authenticated_spotify_operations_validated"] = True
    headless = report["checks"]["headless_mcp"] or {}
    if headless.get("status") == "passed" and headless.get("mutations_requested"):
        report["authenticated_playlist_mutations_validated"] = True
    (LAB / "results" / "summary.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    for name, result in report["checks"].items():
        print(f"{name}: {result.get('status') if result else 'not_run'}")
    print("account_read:", report["account_read"]["status"])


if __name__ == "__main__":
    main()
