"""Verify the trusted metadata workflow publishes the actual PR-head result."""

import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import sys
import importlib.util
import unittest
from unittest.mock import patch


class MetadataWorkflowTests(unittest.TestCase):
    def test_head_reporting_and_unrecognized_protected_display_name(self):
        script = Path(__file__).with_name("commit_privacy.py")
        spec = importlib.util.spec_from_file_location("commit_privacy", script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        scope = vars(module)
        scope["regression_checks"]()
        for compliant in (True, False):
            with self.subTest(compliant=compliant), tempfile.TemporaryDirectory() as directory:
                event = Path(directory) / "event.json"
                head, base = "b" * 40, "a" * 40
                event.write_text(json.dumps({"pull_request": {"base": {"sha": base}, "head": {"sha": head, "ref": "topic"}}}))
                env = dict(GITHUB_EVENT_NAME="pull_request_target", GITHUB_EVENT_PATH=str(event),
                           GITHUB_API_URL="https://api.github.com", GITHUB_REPOSITORY="example/repo",
                           GH_TOKEN="synthetic-publisher", GH_READ_TOKEN="synthetic-reader",
                           GITHUB_SHA=base, COMMIT_PRIVACY_SELF_TEST="0")
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

                with patch.dict(os.environ, env), patch("urllib.request.urlopen", side_effect=respond), patch.object(module.Path, "read_text", return_value=json.dumps({"baseline": base})):
                    with contextlib.redirect_stdout(io.StringIO()):
                        result = scope["main"](publish=True)
                self.assertEqual(bool(result), not compliant)
                posted = json.loads(calls[0].data)
                self.assertEqual(posted["head_sha"], head)
                self.assertEqual(posted["name"], "commit-privacy")
                for call in calls:
                    self.assertEqual(call.get_header("Authorization"), "Bearer " +
                                     ("synthetic-publisher" if call.method in ("POST", "PATCH") else "synthetic-reader"))
                self.assertEqual(json.loads(calls[-1].data)["conclusion"], "success" if compliant else "failure")


if __name__ == "__main__":
    unittest.main()
