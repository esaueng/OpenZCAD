"""Native subprocess tools shared by the policy fixture harnesses."""
from functools import lru_cache
import os
from pathlib import Path
import subprocess
import sys


def git_command(*arguments, env=None):
    # CreateProcess cannot execute the POSIX PATH shim used by the fetch
    # fixture. Invoke that fixture's Python entry point explicitly on Windows.
    environment = os.environ if env is None else env
    wrapper = environment.get("OPENZCAD_FIXTURE_GIT_WRAPPER") if os.name == "nt" else None
    return [sys.executable, wrapper, *arguments] if wrapper else ["git", *arguments]


@lru_cache
def bash_executable():
    if os.environ.get("OPENZCAD_BASH"):
        return os.environ["OPENZCAD_BASH"]
    if os.name != "nt":
        return "bash"
    directory = Path(subprocess.check_output(["git", "--exec-path"], text=True).strip())
    for parent in (directory, *directory.parents):
        for folder in ("bin", "usr/bin"):
            candidate = parent / folder / "bash.exe"
            if candidate.is_file():
                return str(candidate)
    raise RuntimeError("Git Bash is required; set OPENZCAD_BASH to its executable")
