import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('workflow runner policy', () => {
  it('keeps ordinary workflows hosted with a restricted trusted workflow', () => {
    const workflowDirectory = '.github/workflows';
    const expectedRunners: Record<string, string[]> = {
      'commit-privacy.yml': ['ubuntu-24.04'],
      'ci.yml': [],
      'public-commit-metadata.yml': ['ubuntu-24.04'],
      'fleet-ci.yml': Array(5).fill('*fleet-runner'),
      'cloudflare.yml': ['ubuntu-latest', 'ubuntu-latest'],
      'macos-desktop.yml': ['macos-26'],
      'production-health.yml': ['ubuntu-latest'],
      'update-remus.yml': ['ubuntu-latest'],
      'trusted-vps.yml': ['ubuntu-latest'],
      'dependency-audit.yml': ['ubuntu-latest', 'ubuntu-latest']
    };
    const workflowPaths = readdirSync(workflowDirectory)
      .filter((path) => path.endsWith('.yml') || path.endsWith('.yaml'))
      .sort();

    expect(workflowPaths).toEqual(Object.keys(expectedRunners).sort());
    for (const workflowPath of workflowPaths) {
      const workflow = readFileSync(
        `${workflowDirectory}/${workflowPath}`,
        'utf8'
      );
      const runners = [
        ...workflow.matchAll(/^[ \t]+runs-on:[ \t]*(\S+)[ \t]*$/gm)
      ].map((match) => match[1]);

      expect(runners).toEqual(expectedRunners[workflowPath]);
      if (workflowPath === 'trusted-vps.yml') {
        expect(workflow).toContain('workflow_dispatch:');
        expect(workflow).not.toMatch(
          /ci-trusted-main|self-hosted|actions\/checkout|workflow_call|workflow_run|pull_request|secrets\./
        );
      }
      if (workflowPath === 'public-commit-metadata.yml') {
        expect(workflow).toContain('push:\n    branches: [main]');
        expect(workflow).not.toMatch(/^[ \t]+merge_group:/m);
        expect(workflow).toContain('pull_request:');
        expect(workflow).toContain('workflow_dispatch:');
        expect(workflow).toContain('fetch-depth: 0');
        expect(workflow).toContain('persist-credentials: false');
        expect(workflow).toContain('PR_BASE: ${{ github.event.pull_request.base.sha }}');
        expect(workflow).toContain('PR_HEAD: ${{ github.event.pull_request.head.sha }}');
        expect(workflow).toContain('BEFORE_SHA: ${{ github.event.before }}');
        expect(workflow).toContain('elif [[ "$EVENT_NAME" == push ]]');
        expect(workflow).toContain('Commit metadata range is unavailable.');
        expect(workflow).toContain('contents: read');
        expect(workflow).not.toMatch(
          /pull_request_target|workflow_run|secrets(?:\.|:)|id-token: write|contents: write/
        );
      }
    }
  });
});
