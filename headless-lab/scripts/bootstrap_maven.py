"""Install a pinned Maven distribution in the lab, verifying its SHA-512."""
import hashlib
import io
import os
from pathlib import Path
import urllib.request
import zipfile

LAB = Path(__file__).resolve().parents[1]
VERSION = "3.9.11"
NAME = f"apache-maven-{VERSION}-bin.zip"
BASE = f"https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/{VERSION}"


def main():
    destination = LAB / "toolchains"
    executable = destination / f"apache-maven-{VERSION}" / "bin" / ("mvn.cmd" if os.name == "nt" else "mvn")
    if executable.exists():
        print(executable)
        return
    with urllib.request.urlopen(f"{BASE}/{NAME}.sha512", timeout=60) as response:
        expected = response.read().decode().split()[0].lower()
    with urllib.request.urlopen(f"{BASE}/{NAME}", timeout=60) as response:
        archive = response.read()
    actual = hashlib.sha512(archive).hexdigest()
    if actual != expected:
        raise RuntimeError("Maven archive SHA-512 mismatch")
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        for member in bundle.infolist():
            target = (destination / member.filename).resolve()
            if destination.resolve() not in target.parents:
                raise RuntimeError("Archive entry escapes toolchains directory")
        bundle.extractall(destination)
    if os.name != "nt":
        executable.chmod(0o755)
    print(f"Maven {VERSION}: verified SHA-512 {actual}")
    print(executable)


if __name__ == "__main__":
    main()
