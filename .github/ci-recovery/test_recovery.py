"""Exercise the actual metadata-only recovery script without GitHub access."""

import copy
import json
import os
from pathlib import Path
import subprocess
import textwrap
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / '.github/workflows/ci-recovery.yml').read_text()
SCRIPT = textwrap.dedent(WORKFLOW.split("python3 - <<'PY'\n", 1)[1]).rsplit('\nPY', 1)[0]


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.pr = {
            'state': 'open',
            'head': {'sha': 'current', 'ref': 'feature/one', 'repo': {'id': 42}},
            'base': {'repo': {'id': 42, 'full_name': 'owner/repo'}},
        }
        self.run = {
            'id': 123, 'workflow_id': 7, 'event': 'pull_request',
            'status': 'queued', 'head_sha': 'old', 'head_branch': 'feature/one',
            'head_repository': {'id': 42},
            'pull_requests': [{'number': 5, 'head': {'repo': {'id': 42}},
                               'base': {'repo': {'id': 42}}}],
        }
        self.trigger = self.run | {'id': 100, 'head_sha': 'current'}
        self.pages = [[copy.deepcopy(self.run)]]
        self.live = copy.deepcopy(self.run)
        self.pr_reads = 0
        self.before_cancel = None
        self.cancel_error = False
        self.finished = False
        self.posts = []
        self.paths = []

    def request(self, command, text):
        self.assertEqual(command[:2], ['gh', 'api'])
        self.assertTrue(text)
        path, flag, method = command[2:]
        self.assertEqual(flag, '--method')
        self.paths.append(path)
        if path == 'repos/owner/repo/actions/workflows/ci.yml':
            response = {'id': 7}
        elif path == 'repos/owner/repo/pulls/5':
            self.pr_reads += 1
            if self.pr_reads > 1 and self.before_cancel:
                self.before_cancel()
            response = self.pr
        elif '/runs?event=pull_request' in path:
            self.assertIn('branch=feature%2Fone&per_page=100&page=', path)
            page = int(path.rsplit('=', 1)[1])
            response = {'workflow_runs': self.pages[page - 1]}
        elif path.endswith('/force-cancel'):
            self.assertEqual(method, 'POST')
            self.posts.append(path)
            if self.cancel_error:
                self.finished = True
                raise subprocess.CalledProcessError(1, command)
            return ''
        elif path == 'repos/owner/repo/actions/runs/100':
            response = self.trigger
        elif path == 'repos/owner/repo/actions/runs/123':
            response = self.live | ({'status': 'completed'} if self.finished else {})
        else:
            self.fail(f'Unexpected API request: {method} {path}')
        self.assertEqual(method, 'GET')
        return json.dumps(response)

    def execute(self):
        with patch.dict(os.environ, {'REPOSITORY': 'owner/repo', 'TRIGGER_RUN_ID': '100'}):
            with patch('subprocess.check_output', side_effect=self.request):
                exec(compile(SCRIPT, 'ci-recovery.yml', 'exec'), {})

    def test_cancels_only_superseded_ci(self):
        self.execute()
        self.assertEqual(self.posts, ['repos/owner/repo/actions/runs/123/force-cancel'])

    def test_keeps_current_heads_queue_candidates_other_workflows_and_other_prs(self):
        changes = [
            {'head_sha': 'current'}, {'event': 'merge_group'},
            {'event': 'workflow_dispatch'}, {'event': 'push'},
            {'workflow_id': 8}, {'status': 'completed'},
            {'head_branch': 'other'}, {'head_repository': {'id': 99}},
            {'head_repository': None}, {'head_sha': None},
            {'pull_requests': []},
            {'pull_requests': [{'number': 6}]},
            {'pull_requests': [{'number': 5, 'head': {'repo': {'id': 99}},
                                'base': {'repo': {'id': 42}}}]},
        ]
        for change in changes:
            with self.subTest(change=change):
                self.pages = [[self.run | change]]
                self.execute()
                self.assertEqual(self.posts, [])

    def test_other_workflows_and_merge_groups_cannot_trigger_cleanup(self):
        for change in ({'workflow_id': 8}, {'event': 'merge_group'},
                       {'event': 'push'}, {'pull_requests': []}):
            with self.subTest(change=change):
                self.trigger = self.run | change
                self.execute()
                self.assertEqual(self.posts, [])

    def test_rechecks_live_run_before_writing(self):
        for change in ({'status': 'completed'}, {'event': 'merge_group'},
                       {'head_sha': 'current'}, {'workflow_id': 8}):
            with self.subTest(change=change):
                self.live = self.run | change
                self.execute()
                self.assertEqual(self.posts, [])

    def test_rechecks_pr_after_delayed_events_and_branch_resets(self):
        def reset():
            self.pr['head']['sha'] = 'old'
        self.before_cancel = reset
        self.execute()
        self.assertEqual(self.posts, [])

    def test_closed_or_deleted_pr_heads_are_untouched(self):
        for change in ({'state': 'closed'}, {'head': {'repo': None}}):
            with self.subTest(change=change):
                self.pr.update(change)
                self.execute()
                self.assertEqual(self.posts, [])

    def test_pr_closed_between_read_and_write_is_untouched(self):
        self.before_cancel = lambda: self.pr.update(state='closed')
        self.execute()
        self.assertEqual(self.posts, [])

    def test_paginates_past_completed_and_current_runs(self):
        self.pages = [[self.run | {'status': 'completed'}] * 100, [self.run]]
        self.execute()
        self.assertEqual(len(self.posts), 1)
        self.assertTrue(any(path.endswith('page=2') for path in self.paths))

    def test_run_finishing_during_cancel_is_harmless(self):
        self.cancel_error = True
        self.execute()
        self.assertEqual(len(self.posts), 1)

    def test_cancellation_failure_is_reported(self):
        self.cancel_error = True
        self.finished = False
        original = self.request
        def fail(command, text):
            try:
                return original(command, text)
            finally:
                self.finished = False
        with patch.dict(os.environ, {'REPOSITORY': 'owner/repo', 'TRIGGER_RUN_ID': '100'}):
            with patch('subprocess.check_output', side_effect=fail):
                with self.assertRaises(subprocess.CalledProcessError):
                    exec(compile(SCRIPT, 'ci-recovery.yml', 'exec'), {})


if __name__ == '__main__':
    unittest.main()
