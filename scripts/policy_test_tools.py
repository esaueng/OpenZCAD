"""Native subprocess tools shared by the policy fixture harnesses."""
from functools import lru_cache
import os
from pathlib import Path
import subprocess


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
