"""Verify the trusted metadata workflow publishes the actual PR-head result."""

import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import textwrap
import unittest
from unittest.mock import patch


class MetadataWorkflowTests(unittest.TestCase):
    def test_head_reporting_and_unrecognized_protected_display_name(self):
        workflow = Path(__file__).resolve().parents[1] / "workflows/commit-privacy.yml"
        source = textwrap.dedent(workflow.read_text().split("python3 - <<'PY'\n", 1)[1].split("\n          PY", 1)[0])
        source = source.rsplit("\ntry:", 1)[0]
        scope = {}
        exec(compile(source, "trusted-metadata-workflow", "exec"), scope)
        scope["regression_checks"]()
        for compliant in (True, False):
            with self.subTest(compliant=compliant), tempfile.TemporaryDirectory() as directory:
                event = Path(directory) / "event.json"
                head, base = "b" * 40, "a" * 40
                event.write_text(json.dumps({"pull_request": {"base": {"sha": base}, "head": {"sha": head}}}))
                env = dict(GITHUB_EVENT_NAME="pull_request_target", GITHUB_EVENT_PATH=str(event),
                           GITHUB_API_URL="https://api.github.com", GITHUB_REPOSITORY="example/repo",
                           GH_TOKEN="synthetic-token", COMMIT_PRIVACY_SELF_TEST="0")
                calls = []

                def respond(request, timeout):
                    calls.append(request)
                    if request.method == "POST":
                        result = {"id": 42}
                    elif request.method == "PATCH":
                        result = {}
                    else:
                        raw = {"name": "Peter", "email": "123+petertoday@users.noreply.github.com"
                               if compliant else "fixture@example.invalid"}
                        result = {"total_commits": 1, "commits": [{"sha": head,
                                  "commit": {"author": raw, "committer": raw},
                                  "author": None, "committer": None}]}
                    return io.BytesIO(json.dumps(result).encode())

                with patch.dict(os.environ, env), patch("urllib.request.urlopen", side_effect=respond):
                    with contextlib.redirect_stdout(io.StringIO()):
                        result = scope["main"]()
                self.assertEqual(bool(result), not compliant)
                posted = json.loads(calls[0].data)
                self.assertEqual(posted["head_sha"], head)
                self.assertEqual(posted["name"], "commit-privacy")
                self.assertEqual(json.loads(calls[-1].data)["conclusion"], "success" if compliant else "failure")


if __name__ == "__main__":
    unittest.main()
