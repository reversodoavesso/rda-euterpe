"""Read the account using NTify and the explicitly captured desktop credential."""
import json
import os
from pathlib import Path
import subprocess
import urllib.request

from spotapi.client import BaseClient
from spotapi.http.request import TLSClient

LAB = Path(__file__).resolve().parents[1]


def main():
    classes = LAB / "runs/ntify-classes"
    jar = LAB / "repos/ntify-spotapi/target/NTify-SpotAPI.jar"
    subprocess.run(["javac", "-encoding", "UTF-8", "-cp", str(jar), "-d", str(classes),
                    str(LAB / "harness/NtifyAccountRead.java")], check=True)
    auth = json.loads((LAB / "private/desktop-migration/desktop-auth.json").read_text(encoding="utf-8"))
    if not auth.get("access_token"):
        raise RuntimeError("Temporary token was discarded after migration; capture a fresh token before this optional probe")
    # The client token identifies the client, not the user's session.
    client = TLSClient("chrome120", "", auto_retries=0)
    client.timeout = 10
    base = BaseClient(client=client)
    base.get_session()
    base.get_client_token()
    with urllib.request.urlopen("https://apresolve.spotify.com/?type=spclient", timeout=10) as response:
        host = json.load(response)["spclient"][0]
    request = {"access_token": auth["access_token"], "username": auth["username"],
               "client_token": str(base.client_token), "user_agent": auth["user_agent"],
               "spclient_host": host}
    with (LAB / "private/desktop-migration/ntify-read.log").open("w", encoding="utf-8") as errors:
        completed = subprocess.run(["java", "-cp", str(classes) + os.pathsep + str(jar), "NtifyAccountRead"],
                                   input=json.dumps(request) + "\n", text=True, encoding="utf-8",
                                   stdout=subprocess.PIPE, stderr=errors, timeout=65, check=True)
    report = json.loads(completed.stdout)
    (LAB / "results/ntify-account-read.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    if report["status"] != "passed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
