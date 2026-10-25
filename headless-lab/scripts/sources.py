"""Fetch candidate repos or record the exact upstream revisions under test."""
import argparse
import json
from pathlib import Path
import subprocess

LAB = Path(__file__).resolve().parents[1]


def git(repo, *args):
    return subprocess.check_output(
        ["git", "-C", str(repo), *args], text=True, encoding="utf-8"
    ).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["fetch", "record"])
    args = parser.parse_args()
    candidates = json.loads((LAB / "candidates.json").read_text())["candidates"]
    lock_path = LAB / "sources.lock.json"
    previous = json.loads(lock_path.read_text()) if lock_path.exists() else {}
    previous = {item["id"]: item for item in previous.get("sources", [])}
    records = []
    for candidate in candidates:
        repo = LAB / "repos" / candidate["id"]
        if not repo.exists():
            if args.action != "fetch":
                raise RuntimeError(f"Missing checkout: {repo}")
            subprocess.run(
                ["git", "clone", "--depth", "1", candidate["url"], str(repo)],
                check=True,
            )
            if candidate["id"] in previous:
                revision = previous[candidate["id"]]["commit"]
                subprocess.run(["git", "-C", str(repo), "fetch", "--depth", "1", "origin", revision], check=True)
                subprocess.run(["git", "-C", str(repo), "checkout", "--detach", revision], check=True)
        commit = git(repo, "rev-parse", "HEAD")
        if candidate["id"] in previous and previous[candidate["id"]]["commit"] != commit:
            raise RuntimeError(f"Revision changed for {candidate['id']}; review before replacing the lock")
        records.append({
            **candidate,
            "commit": commit,
            "committed_at": git(repo, "show", "-s", "--format=%cI", "HEAD"),
            "subject": git(repo, "show", "-s", "--format=%s", "HEAD"),
            "license_files": [p.name for p in repo.glob("*LICENSE*") if p.is_file()],
        })
        print(f"{candidate['id']}: {commit}")
    lock_path.write_text(json.dumps({"sources": records}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
