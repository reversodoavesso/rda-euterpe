"""Stage only known offline tests, avoiding the upstream test package initializer."""
from pathlib import Path
import shutil
import subprocess
import sys

LAB = Path(__file__).resolve().parents[1]
FILES = ["client_refresh_test.py", "saver_test.py", "annotations_test.py"]


def main():
    staged = LAB / "runs" / "spotapi-offline-tests"
    staged.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        shutil.copy2(LAB / "repos" / "spotapi-python" / "spotapi" / "_tests" / name, staged / name)
    command = [sys.executable, "-m", "pytest", str(staged), "-q", f"--junitxml={LAB / 'runs' / 'spotapi-offline.xml'}"]
    print("Staged unchanged upstream offline tests; live feature tests are excluded.", flush=True)
    raise SystemExit(subprocess.call(command, cwd=LAB))


if __name__ == "__main__":
    main()
