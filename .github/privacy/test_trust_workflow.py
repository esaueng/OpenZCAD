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

    def test_metadata_convenience_workflow_cannot_publish_a_required_check(self):
        text = (Path(__file__).parents[1] / 'workflows' / 'commit-privacy.yml').read_text()
        self.assertNotIn('secrets.', text)
        self.assertNotIn('environment:', text)
        self.assertNotRegex(text, r':\s*write\b')
        self.assertNotIn('--publish', text)
        self.assertIn('GH_READ_TOKEN: ${{ github.token }}', text)
