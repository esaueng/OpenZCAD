#!/usr/bin/env python3
"""Exercise cold, prepared and stale Git evidence without a network remote."""

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
GIT = shutil.which("git")


class FleetFixtureTests(unittest.TestCase):
    def test_prepare_keeps_all_policy_checks_offline_and_fails_closed(self):
        self.assertIsNotNone(GIT)
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
        # The private fixture remote treats this checkout as its main. This
        # also works on activation PRs whose real origin/main is the pin itself;
        # the ordinary suite still checks that real ref independently.
        main = git("rev-parse", "HEAD")
        caller = (ROOT / ".github/workflows/ci.yml").read_text()
        pin = re.search(r"fleet-ci(?:-v[0-9]+)?\.yml@([a-f0-9]{40})", caller)[1]

        with tempfile.TemporaryDirectory(prefix="fleet-git-fixtures-") as temporary:
            directory = Path(temporary)
            checkout = directory / "checkout"
            git("init", str(checkout))
            info = checkout / ".git/objects/info"
            info.mkdir(parents=True, exist_ok=True)
            (info / "alternates").write_text(str(objects.resolve()) + "\n")
            # Borrow real immutable objects, but hide their ancestry behind a
            # depth-one boundary. The fetch fixture below restores the prepared
            # boundary without a network or a second, potentially shallow server.
            shallow = Path(git("rev-parse", "--git-path", "shallow"))
            if not shallow.is_absolute():
                shallow = ROOT / shallow
            prepared_boundary = directory / "prepared-shallow"
            prepared_boundary.write_bytes(shallow.read_bytes() if shallow.exists() else b"")
            env = dict(clean_env, GIT_DIR=str(checkout / ".git"),
                       GIT_WORK_TREE=str(ROOT))
            git("config", "user.name", "petertoday", env=env)
            git("config", "user.email", "171875562+petertoday@users.noreply.github.com", env=env)
            git("remote", "add", "origin", (directory / "unused-remote.git").as_uri(), env=env)
            git("update-ref", "refs/remotes/origin/main", main, env=env)
            (checkout / ".git/shallow").write_text(main + "\n")

            binaries = directory / "bin"
            binaries.mkdir()
            wrapper = binaries / "git"
            wrapper.write_text(
                "#!" + sys.executable + "\n"
                "import os, sys\n"
                "from pathlib import Path\n"
                "if len(sys.argv) > 1 and sys.argv[1] == 'fetch':\n"
                "    with open(os.environ['OPENZCAD_FIXTURE_FETCH_LOG'], 'a') as log:\n"
                "        log.write('fetch\\n')\n"
                "    if os.environ.get('OPENZCAD_FIXTURE_FETCH_BLOCKED') == '1':\n"
                "        sys.stderr.write('fixture deliberately blocks fetch\\n')\n"
                "        sys.exit(1)\n"
                "    if '+refs/heads/main:refs/remotes/origin/main' not in sys.argv:\n"
                "        sys.exit('unexpected fixture fetch')\n"
                "    boundary = Path(os.environ['GIT_DIR']) / 'shallow'\n"
                "    prepared = Path(os.environ['OPENZCAD_FIXTURE_PREPARED_BOUNDARY']).read_bytes()\n"
                "    if prepared:\n"
                "        boundary.write_bytes(prepared)\n"
                "    else:\n"
                "        boundary.unlink(missing_ok=True)\n"
                "    sys.exit(0)\n"
                f"os.execv({GIT!r}, [{GIT!r}, *sys.argv[1:]])\n"
            )
            wrapper.chmod(0o755)
            log = directory / "fetch.log"
            env.update(PATH=str(binaries) + os.pathsep + clean_env["PATH"],
                       OPENZCAD_FIXTURE_FETCH_LOG=str(log),
                       OPENZCAD_FIXTURE_PREPARED_BOUNDARY=str(prepared_boundary),
                       OPENZCAD_FIXTURE_FETCH_BLOCKED="1")

            def run(script, *tests):
                return subprocess.run([sys.executable, str(ROOT / "scripts" / script), *tests],
                                      cwd=ROOT, env=env, capture_output=True, text=True)

            provenance = "DirectFleetTests.test_pin_is_a_commit_main_already_contains"
            cold = run("test-direct-fleet.py", provenance)
            self.assertNotEqual(cold.returncode, 0)
            self.assertIn("test_pin_is_a_commit_main_already_contains", cold.stderr)
            self.assertIn("fixture deliberately blocks fetch", cold.stderr)

            env["OPENZCAD_FIXTURE_FETCH_BLOCKED"] = "0"
            prepared = run("prepare-fleet-test-fixtures.py")
            self.assertEqual(prepared.returncode, 0, prepared.stdout + prepared.stderr)
            self.assertIn("fetch\n", log.read_text())
            attempts = log.read_text()
            env["OPENZCAD_FIXTURE_FETCH_BLOCKED"] = "1"
            warm = run("test-direct-fleet.py")
            self.assertEqual(warm.returncode, 0, warm.stdout + warm.stderr)
            self.assertRegex(warm.stderr, r"Ran [1-9][0-9]* tests")
            self.assertEqual(log.read_text(), attempts, "prepared assertions attempted a fetch")

            # Cached fixture bytes cannot authorize a pin absent from main.
            git("update-ref", "refs/remotes/origin/main", pin + "^", env=env)
            stale = run("test-direct-fleet.py", provenance)
            self.assertNotEqual(stale.returncode, 0)
            self.assertIn("test_pin_is_a_commit_main_already_contains", stale.stderr)


if __name__ == "__main__":
    unittest.main()
