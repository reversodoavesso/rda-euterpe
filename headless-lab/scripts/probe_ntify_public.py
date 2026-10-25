"""Provide anonymous guest credentials to a read-only Java probe through stdin."""
import json
import os
from pathlib import Path
import subprocess

from spotapi.client import BaseClient
from spotapi.http.request import TLSClient

LAB = Path(__file__).resolve().parents[1]


def main():
    classes = LAB / "runs/ntify-classes"
    classes.mkdir(exist_ok=True)
    jar = LAB / "repos/ntify-spotapi/target/NTify-SpotAPI.jar"
    subprocess.run(["javac", "-encoding", "UTF-8", "-cp", str(jar), "-d", str(classes),
                    str(LAB / "harness/NtifyPublicRead.java")], check=True)
    client = TLSClient("chrome120", "", auto_retries=0)
    client.timeout = 10
    base = BaseClient(client=client)
    base.get_session()
    base.get_client_token()
    auth = {"access_token": str(base.access_token), "client_token": str(base.client_token),
            "user_agent": client.headers["User-Agent"]}
    # Tokens are never command arguments, environment variables, result files or logs.
    try:
        with (LAB / "runs/ntify-public-java.log").open("w", encoding="utf-8") as errors:
            completed = subprocess.run(["java", "-cp", str(classes) + os.pathsep + str(jar), "NtifyPublicRead"],
                                       input=json.dumps(auth) + "\n", text=True, encoding="utf-8",
                                       stdout=subprocess.PIPE, stderr=errors, timeout=45, check=True)
        report = json.loads(completed.stdout)
    except (subprocess.SubprocessError, ValueError) as error:
        report = {"candidate": "ntify-spotapi", "mode": "live_public_search_with_guest_tokens",
                  "authenticated_account": False, "status": "failed", "error_type": type(error).__name__}
    (LAB / "results/ntify-public.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    if report["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
