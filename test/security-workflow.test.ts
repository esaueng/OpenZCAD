import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('workflow runner policy', () => {
  it('keeps every workflow on GitHub-hosted runners', () => {
    const workflowDirectory = '.github/workflows';
    const expectedRunners: Record<string, string[]> = {
      'ci.yml': ['ubuntu-latest', 'ubuntu-latest', 'ubuntu-latest'],
      'cloudflare.yml': ['ubuntu-latest', 'ubuntu-latest'],
      'macos-desktop.yml': ['macos-26'],
      'production-health.yml': ['ubuntu-latest'],
      'update-remus.yml': ['ubuntu-latest']
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
      const runners = [...workflow.matchAll(/^\s+runs-on:\s*(\S+)\s*$/gm)].map(
        (match) => match[1]
      );

      expect(runners).toEqual(expectedRunners[workflowPath]);
    }
  });
});
