"""Exercise the final gate without running repository code on a trusted host."""
import itertools
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / '.github/workflows/trusted-pr.yml').read_text()


class FleetRoutingTests(unittest.TestCase):
    def test_only_selected_success_passes(self):
        complete = WORKFLOW.split('\n  complete:\n', 1)[1]
        command = complete.split('        run: |\n', 1)[1]
        for trusted, target, route, vps, hosted in itertools.product(
                ('true', 'false'), ('ci-server-jane', 'ci-server-john', 'github-hosted'),
                ('success', 'failure'), ('success', 'failure', 'skipped'),
                ('success', 'failure', 'skipped')):
            expected = (route == 'success' if trusted == 'true' else True) and (
                vps == 'success' and hosted == 'skipped'
                if trusted == 'true' and target != 'github-hosted'
                else hosted == 'success' and vps == 'skipped')
            result = subprocess.run(['bash', '-e', '-c', command], env=dict(os.environ,
                SELECT_RESULT='success', TRUSTED=trusted, TARGET=target,
                ROUTE_RESULT=route, VPS_RESULT=vps, HOSTED_RESULT=hosted), capture_output=True)
            self.assertEqual(result.returncode == 0, expected,
                             (trusted, target, route, vps, hosted))

    def test_untrusted_jobs_do_not_request_fleet_identity(self):
        route = WORKFLOW.split('\n  route:\n', 1)[1].split('\n  vps:\n', 1)[0]
        self.assertIn("if: needs.select.outputs.trusted == 'true'", route)
        self.assertIn('needs: select', route)
        self.assertNotIn('checkout', route)
        self.assertNotIn('id-token: write', WORKFLOW.split('\n  vps:\n', 1)[1])
        self.assertIn("needs.select.outputs.trusted == 'false' || needs.route.outputs.target == 'github-hosted'", WORKFLOW)


if __name__ == '__main__':
    unittest.main()
