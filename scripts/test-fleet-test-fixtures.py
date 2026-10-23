#!/usr/bin/env python3
"""Exercise fixture correctness and the real Vitest deadline without a network."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
GIT = shutil.which("git")


@contextmanager
def git_fixture(*, main_is_pin=False, missing_pins=False):
    repository_environment = {
        "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE", "GIT_SHALLOW_FILE",
    }
    clean_env = {key: value for key, value in os.environ.items()
                 if key not in repository_environment}

    def git(*args, env=clean_env):
        return subprocess.check_output([GIT, *args], cwd=ROOT, env=env,
                                       text=True, stderr=subprocess.PIPE).strip()

    objects = Path(git("rev-parse", "--git-path", "objects"))
    if not objects.is_absolute():
        objects = ROOT / objects
    head = git("rev-parse", "HEAD")
    main = git("rev-parse", "refs/remotes/origin/main")
    caller = (ROOT / ".github/workflows/ci.yml").read_text()
    pin = re.search(r"fleet-ci(?:-v[0-9]+)?\.yml@([a-f0-9]{40})", caller)[1]

    if main_is_pin:
        main = pin

    with tempfile.TemporaryDirectory(prefix="fleet-git-fixtures-") as temporary:
        directory = Path(temporary)
        checkout = directory / "checkout"
        git("init", str(checkout))
        info = checkout / ".git/objects/info"
        info.mkdir(parents=True, exist_ok=True)
        (info / "alternates").write_text(str(objects.resolve()) + "\n")
        # Borrow real objects, initially hiding ancestry behind a depth-one
        # boundary. A local fetch fixture restores their prepared boundary.
        shallow = Path(git("rev-parse", "--git-path", "shallow"))
        if not shallow.is_absolute():
            shallow = ROOT / shallow
        prepared_boundary = directory / "prepared-shallow"
        boundaries = set(shallow.read_text().splitlines()) if shallow.exists() else set()
        if head != main:
            boundaries.add(head)
        prepared_boundary.write_text("".join(boundary + "\n" for boundary in sorted(boundaries)))
        env = dict(clean_env, GIT_DIR=str(checkout / ".git"), GIT_WORK_TREE=str(ROOT))
        git("config", "user.name", "petertoday", env=env)
        git("config", "user.email", "171875562+petertoday@users.noreply.github.com", env=env)
        git("remote", "add", "origin", (directory / "unused-remote.git").as_uri(), env=env)
        # Model an Actions depth-one PR merge ref, independent of real main.
        # A prepared main fetch can leave that synthetic HEAD boundary intact.
        git("update-ref", "HEAD", head, env=env)
        (checkout / ".git/shallow").write_text(head + "\n")

        binaries = directory / "bin"
        binaries.mkdir()
        wrapper = binaries / "git"
        fetch_wrapper = binaries / "git-fetch.py"
        ready = directory / "pins-ready"
        fetch_wrapper.write_text(
            "#!" + sys.executable + "\n"
            "import os, subprocess, sys, time\n"
            "from pathlib import Path\n"
            "if os.environ.get('OPENZCAD_FIXTURE_MISSING_PINS') == '1' and len(sys.argv) > 2 and sys.argv[1] == 'show' and ':' in sys.argv[2] and not Path(os.environ['OPENZCAD_FIXTURE_PINS_READY']).exists():\n"
            "    sys.exit('fixture workflow object is not present yet')\n"
            "if len(sys.argv) > 1 and sys.argv[1] == 'fetch':\n"
            "    with open(os.environ['OPENZCAD_FIXTURE_FETCH_LOG'], 'a') as log:\n"
            "        log.write('fetch\\n')\n"
            "    if os.environ.get('OPENZCAD_FIXTURE_FETCH_BLOCKED') == '1':\n"
            "        sys.stderr.write('fixture deliberately blocks fetch\\n')\n"
            "        sys.exit(1)\n"
            "    if '+refs/heads/main:refs/remotes/origin/main' not in sys.argv:\n"
            "        sys.exit('unexpected fixture fetch')\n"
            "    time.sleep(float(os.environ.get('OPENZCAD_FIXTURE_FETCH_DELAY', '0')))\n"
            "    boundary = Path(os.environ['GIT_DIR']) / 'shallow'\n"
            "    prepared = Path(os.environ['OPENZCAD_FIXTURE_PREPARED_BOUNDARY']).read_bytes()\n"
            "    if prepared:\n"
            "        boundary.write_bytes(prepared)\n"
            "    else:\n"
            "        boundary.unlink(missing_ok=True)\n"
            f"    subprocess.run([{GIT!r}, 'update-ref', 'refs/remotes/origin/main', os.environ['OPENZCAD_FIXTURE_MAIN']], check=True)\n"
            "    Path(os.environ['OPENZCAD_FIXTURE_PINS_READY']).touch()\n"
            "    sys.exit(0)\n"
            f"os.execv({GIT!r}, [{GIT!r}, *sys.argv[1:]])\n"
        )
        # Ordinary Git reads must not start another Python interpreter. This
        # fixture is exercised repeatedly inside the unchanged five-second
        # test and by two nested Vitest workers inside the setup deadline.
        # Keep the slow, delayed fetch in Python; pass every other operation
        # straight to real Git after the same missing-object guard.
        wrapper.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = fetch ]; then exec "
            + shlex.quote(sys.executable) + " " + shlex.quote(str(fetch_wrapper))
            + " \"$@\"; fi\n"
            "if [ \"$OPENZCAD_FIXTURE_MISSING_PINS\" = 1 ] && [ \"$1\" = show ] "
            "&& [ \"$#\" -gt 1 ] && [ ! -e \"$OPENZCAD_FIXTURE_PINS_READY\" ]; then\n"
            "  case \"$2\" in *:*) echo 'fixture workflow object is not present yet' >&2; exit 1;; esac\n"
            "fi\nexec " + shlex.quote(GIT) + " \"$@\"\n"
        )
        wrapper.chmod(0o755)
        log = directory / "fetch.log"
        env.update(PATH=str(binaries) + os.pathsep + clean_env["PATH"],
                   OPENZCAD_FIXTURE_MAIN=main,
                   OPENZCAD_FIXTURE_MISSING_PINS="1" if missing_pins else "0",
                   OPENZCAD_FIXTURE_PINS_READY=str(ready),
                   OPENZCAD_FIXTURE_FETCH_LOG=str(log),
                   OPENZCAD_FIXTURE_PREPARED_BOUNDARY=str(prepared_boundary),
                   OPENZCAD_FIXTURE_FETCH_BLOCKED="1")
        yield env, log, pin, git


def run_script(script, env, *tests):
    return subprocess.run([sys.executable, str(ROOT / "scripts" / script), *tests],
                          cwd=ROOT, env=env, capture_output=True, text=True)


class FleetFixtureTests(unittest.TestCase):
    def test_prepare_keeps_all_policy_checks_offline_and_fails_closed(self):
        self.assertIsNotNone(GIT)
        for main_is_pin in (False, True):
            with self.subTest(main_is_pin=main_is_pin), git_fixture(main_is_pin=main_is_pin) as (env, log, pin, git):
                provenance = "DirectFleetTests.test_pin_is_a_commit_main_already_contains"
                cold = run_script("test-direct-fleet.py", env, provenance)
                self.assertNotEqual(cold.returncode, 0)
                self.assertIn("test_pin_is_a_commit_main_already_contains", cold.stderr)
                self.assertIn("fixture deliberately blocks fetch", cold.stderr)

                # Model both absent workflow objects, not just missing ancestry.
                # Reads delegate to real Git after the one main fetch completes.
                env["OPENZCAD_FIXTURE_MISSING_PINS"] = "1"
                comparison = json.loads((ROOT / "scripts/fleet-test-fixtures.json").read_text())["esaueng/OpenZCAD"]
                previous_pin = comparison["pin"]
                for revision, path in ((pin, ".github/workflows/fleet-ci-v2.yml"),
                                       (previous_pin, ".github/workflows/fleet-ci.yml")):
                    absent = subprocess.run(["git", "show", f"{revision}:{path}"],
                                            cwd=ROOT, env=env, capture_output=True)
                    self.assertNotEqual(absent.returncode, 0)
                env["OPENZCAD_FIXTURE_FETCH_BLOCKED"] = "0"
                prepared = run_script("prepare-fleet-test-fixtures.py", env)
                self.assertEqual(prepared.returncode, 0, prepared.stdout + prepared.stderr)
                self.assertIn("fetch\n", log.read_text())
                attempts = log.read_text()
                env["OPENZCAD_FIXTURE_FETCH_BLOCKED"] = "1"
                warm = run_script("test-direct-fleet.py", env)
                self.assertEqual(warm.returncode, 0, warm.stdout + warm.stderr)
                self.assertRegex(warm.stderr, r"Ran [1-9][0-9]* tests")
                self.assertEqual(log.read_text(), attempts, "prepared assertions attempted a fetch")

                # Cached fixture bytes cannot authorize a pin absent from main.
                git("update-ref", "refs/remotes/origin/main", pin + "^", env=env)
                stale = run_script("test-direct-fleet.py", env, provenance)
                self.assertNotEqual(stale.returncode, 0)
                self.assertIn("test_pin_is_a_commit_main_already_contains", stale.stderr)


def deadline_evidence():
    """Run the real test and a control without its preparation hook in parallel."""
    source = ROOT / "test/trusted-pr-policy.test.ts"
    text = source.read_text()
    start = text.index("  beforeAll(() => {")
    end = text.index("\n  });", start) + len("\n  });")
    if "scripts/prepare-fleet-test-fixtures.py" not in text[start:end]:
        raise AssertionError("The control must remove only the fixture-preparation hook")
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("Node is required for the actual Vitest deadline regression")
    with tempfile.NamedTemporaryFile(mode="w", prefix="routing-deadline-control-",
                                     suffix=".test.ts", dir=ROOT / "test", delete=False) as file:
        control = Path(file.name)
        file.write(text[:start] + text[end:])
    try:
        with ExitStack() as stack:
            cases = []
            for name, path in (("control", control), ("prepared", source)):
                env, log, _pin, _git = stack.enter_context(git_fixture(missing_pins=name == "prepared"))
                env = {key: value for key, value in env.items()
                       if key != "VITEST" and not key.startswith("VITEST_")
                       and key not in ("NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE")}
                env.update(OPENZCAD_FIXTURE_FETCH_BLOCKED="0", OPENZCAD_FIXTURE_FETCH_DELAY="6")
                cases.append((name, path, env, log))

            def run(case):
                name, path, env, log = case
                process = subprocess.Popen(
                    [node, str(ROOT / "node_modules/vitest/vitest.mjs"), "run",
                     str(path.relative_to(ROOT)), "-t", "retires the orphan OIDC workflow",
                     "--maxWorkers=1"], cwd=ROOT, env=env, text=True,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                try:
                    stdout, stderr = process.communicate(timeout=9)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    stdout, stderr = process.communicate()
                    raise AssertionError(f"{name} exceeded the existing setup deadline")
                output = stdout + stderr
                return name, {"exit_code": process.returncode,
                              "five_second_timeout": "Test timed out in 5000ms" in output,
                              "fetches": len(log.read_text().splitlines()) if log.exists() else 0}

            # The prepared case begins with both workflow objects unavailable;
            # exactly one main transfer must supply them and ancestry.
            # Both six-second waits fit the existing ten-second setup deadline;
            # neither child changes Vitest's five-second test deadline.
            with ThreadPoolExecutor(max_workers=2) as executor:
                result = dict(executor.map(run, cases))
            return dict(result, fixture_delay_seconds=6)
    finally:
        control.unlink()


if __name__ == "__main__":
    if sys.argv[1:] == ["--deadline-evidence"]:
        print(json.dumps(deadline_evidence()))
    else:
        unittest.main()
