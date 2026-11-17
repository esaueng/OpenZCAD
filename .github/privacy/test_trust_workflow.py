"""Regress the credential boundary with no production credentials."""
from pathlib import Path
import re
import unittest


class WorkflowTrustTests(unittest.TestCase):
    def test_privileged_workflow_uses_trusted_events_environment_and_publisher(self):
        workflow = Path(__file__).parents[1] / 'workflows' / 'history-privacy.yml'
        text = workflow.read_text()
        events = text.split('permissions:', 1)[0]
        self.assertNotRegex(events, r'(?m)^  (push|merge_group|pull_request):')
        for event in ('pull_request_target:', 'workflow_run:', 'workflow_dispatch:', 'schedule:'):
            self.assertIn(event, events)
        self.assertIn('environment: history-privacy', text)
        self.assertNotRegex(text, r'(?m)^\s+checks: write$')
        self.assertIn('permission-checks: write', text)
        self.assertIn('GH_TOKEN: ${{ steps.publisher.outputs.token }}', text)
        self.assertRegex(text, r'uses: actions/create-github-app-token@[0-9a-f]{40}')
        self.assertRegex(text, r'(?m)^          ref: [0-9a-f]{40}$')
        self.assertIn('persist-credentials: false', text)
        self.assertNotIn('github.event.pull_request.head', text)

    def test_requester_has_no_credentials_or_write_permissions(self):
        text = (Path(__file__).parents[1] / 'workflows' / 'history-privacy-request.yml').read_text()
        self.assertNotIn('secrets.', text)
        self.assertNotIn('environment:', text)
        self.assertNotRegex(text, r':\s*write\b')
        for event in ('push:', 'merge_group:'):
            self.assertIn(event, text)
        # Pull-request heads are audited by pull_request_target alone; main,
        # tags and queue candidates must keep requesting the all-refs audit.
        self.assertIn('  push:\n    branches: [main]\n    tags: ["**"]\n  merge_group:\n', text)
        self.assertNotRegex(text, r'(?m)^  pull_request')

    def test_identity_verdict_has_one_protected_publisher(self):
        workflows = Path(__file__).parents[1] / 'workflows'
        # The read-only duplicate is gone; nothing branch-controlled may
        # reintroduce a job that looks like the required context.
        self.assertFalse((workflows / 'commit-privacy.yml').exists())
        publishers = [path.name for path in sorted(workflows.glob('*.yml'))
                      if 'commit_privacy.py' in path.read_text()]
        self.assertEqual(publishers, ['history-privacy.yml'])
        text = (workflows / 'history-privacy.yml').read_text()
        self.assertIn('python3 .github/privacy/commit_privacy.py --publish', text)
        self.assertIn('GH_READ_TOKEN: ${{ github.token }}', text)
