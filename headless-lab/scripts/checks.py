"""Repeat the lab checks; account login and real mutations are never automatic."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

LAB = Path(__file__).resolve().parents[1]
REPOS = LAB / "repos"
RUNS = LAB / "runs"
RECORDS = []


def run(name, command, cwd=LAB, env=None, stdout_path=None, timeout=900):
    log_path = stdout_path or RUNS / f"{name}.log"
    started = time.monotonic()
    print(f"Running {name}...", flush=True)
    with log_path.open("w", encoding="utf-8") as output:
        try:
            completed = subprocess.run([str(arg) for arg in command], cwd=cwd, env=env,
                                       stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
            exit_code = completed.returncode
        except subprocess.TimeoutExpired:
            exit_code = 124
    RECORDS.append({"name": name, "exit_code": exit_code,
                    "duration_seconds": round(time.monotonic() - started, 2),
                    "log": str(log_path.relative_to(LAB)), "command": [str(arg) for arg in command]})
    print(f"{name}: exit {exit_code}", flush=True)
    return exit_code == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", default="ntify,go,librespot,spotify-player,spotapi")
    parser.add_argument("--containers", action="store_true", help="Build/test the real Linux daemon and pre-login API")
    parser.add_argument("--public", action="store_true", help="Also make one public playlist read, with no user login")
    args = parser.parse_args()
    selected = set(args.only.split(","))
    unknown = selected - {"ntify", "go", "librespot", "spotify-player", "spotapi"}
    if unknown:
        parser.error(f"Unknown candidates: {sorted(unknown)}")
    RUNS.mkdir(parents=True, exist_ok=True)
    (LAB / "results").mkdir(exist_ok=True)
    failures = []
    if "ntify" in selected:
        if not run("maven-bootstrap", [sys.executable, LAB / "scripts/bootstrap_maven.py"]):
            failures.append("maven-bootstrap")
        else:
            maven = LAB / "toolchains/apache-maven-3.9.11/bin" / ("mvn.cmd" if os.name == "nt" else "mvn")
            command = [maven, "-B", f"-Dmaven.repo.local={LAB / 'toolchains/m2'}", "-Dmaven.test.skip=true", "package"]
            if os.name == "nt":
                command = ["cmd", "/d", "/c", *command]
            if run("ntify-build", command, cwd=REPOS / "ntify-spotapi"):
                classes = RUNS / "ntify-classes"
                classes.mkdir(exist_ok=True)
                jar = REPOS / "ntify-spotapi/target/NTify-SpotAPI.jar"
                if run("ntify-javac", ["javac", "-encoding", "UTF-8", "-cp", jar, "-d", classes, LAB / "harness/NtifyOfflineSmoke.java"]):
                    # JVM warnings go to their own log; stdout is strictly JSON.
                    with (LAB / "results/ntify-offline.json").open("w", encoding="utf-8") as output, (RUNS / "ntify-smoke.log").open("w", encoding="utf-8") as errors:
                        result = subprocess.run(["java", "-cp", str(classes) + os.pathsep + str(jar), "NtifyOfflineSmoke"], stdout=output, stderr=errors, timeout=60)
                    if result.returncode:
                        failures.append("ntify-smoke")
                else:
                    failures.append("ntify-javac")
            else:
                failures.append("ntify-build")
    if "go" in selected:
        env = {**os.environ, "GOMODCACHE": str(LAB / "toolchains/gomodcache"), "GOCACHE": str(LAB / "toolchains/gocache")}
        if not run("go-librespot-unit", ["go", "test", "-tags=test_unit", "-json", "./spclient", "./login5", "./tracks", "./dealer", "./zeroconf"],
                   cwd=REPOS / "go-librespot", env=env, stdout_path=RUNS / "go-librespot-unit.jsonl"):
            failures.append("go-librespot-unit")
    for candidate, log, arguments in (
        ("librespot", "librespot-unit", ["-p", "librespot-oauth", "-p", "librespot-core", "--lib"]),
        ("spotify-player", "spotify-player-unit", []),
    ):
        if candidate in selected and not run(log, ["cargo", "+1.99.0", "test", "--locked", *arguments, "--no-default-features", "--features", "native-tls"], cwd=REPOS / candidate):
            failures.append(log)
    if "spotapi" in selected or args.public:
        python = LAB / "envs/spotapi" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if not python.exists():
            if not run("spotapi-venv", ["uv", "venv", "--python", "3.12", LAB / "envs/spotapi"]):
                failures.append("spotapi-venv")
        if not run("spotapi-install", ["uv", "pip", "install", "--python", python, "-r", LAB / "requirements-spotapi.lock", "-e", str(REPOS / "spotapi-python") + "[websocket]"]):
            failures.append("spotapi-install")
        else:
            if "spotapi" in selected and not run("spotapi-offline", [python, LAB / "scripts/test_spotapi_offline.py"]):
                failures.append("spotapi-offline")
            if args.public and not run("spotapi-public", [python, LAB / "scripts/probe_spotapi_public.py"], timeout=120):
                failures.append("spotapi-public")
    if args.containers:
        go_repo = REPOS / "go-librespot"
        image = "euterpe-headless-lab-go:bd3fa74"
        build_image = "euterpe-headless-lab-go-build:bd3fa74"
        if run("go-librespot-docker-build", ["docker", "build", "--progress=plain", "-t", image, "."], cwd=go_repo):
            if not run("go-container-probe", [sys.executable, LAB / "scripts/probe_go_container.py"], timeout=60):
                failures.append("go-container-probe")
        else:
            failures.append("go-librespot-docker-build")
        if run("go-librespot-docker-test-build", ["docker", "build", "--target", "build", "-t", build_image, "."], cwd=go_repo):
            if not run("go-librespot-linux-unit", ["docker", "run", "--rm", build_image, "go", "test", "-tags=test_unit", "-json", "./daemon", "./cmd/daemon"], stdout_path=RUNS / "go-librespot-linux-unit.jsonl"):
                failures.append("go-librespot-linux-unit")
    (RUNS / "commands.json").write_text(json.dumps(RECORDS, indent=2) + "\n", encoding="utf-8")
    subprocess.run([sys.executable, LAB / "scripts/summarize.py"], check=True)
    if failures:
        print("Checks requiring attention:", ", ".join(failures))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
