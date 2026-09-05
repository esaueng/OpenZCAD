import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('workflow runner policy', () => {
  it('keeps ordinary workflows hosted with one restricted VPS exception', () => {
    const workflowDirectory = '.github/workflows';
    const expectedRunners: Record<string, string[]> = {
      'ci.yml': ['ubuntu-latest', 'ubuntu-latest', 'ubuntu-latest'],
      'cloudflare.yml': ['ubuntu-latest', 'ubuntu-latest'],
      'macos-desktop.yml': ['macos-26'],
      'production-health.yml': ['ubuntu-latest'],
      'update-remus.yml': ['ubuntu-latest'],
      'trusted-vps.yml': []
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
      const runners = [...workflow.matchAll(/^[ \t]+runs-on:[ \t]*(\S+)[ \t]*$/gm)].map(
        (match) => match[1]
      );

      expect(runners).toEqual(expectedRunners[workflowPath]);
      if (workflowPath === 'trusted-vps.yml') {
        expect(workflow).toMatch(/runs-on:\n +group: ci-trusted-main\n +labels: ci-small/);
        expect(workflow).toContain('persist-credentials: false');
        expect(workflow).not.toMatch(/workflow_call|workflow_run|pull_request_target|secrets\./);
        expect(workflow).not.toMatch(/^[ \t]+pull_request[ \t]*:/m);
      }
    }
  });
});
