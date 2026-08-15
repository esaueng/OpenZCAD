import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('secret-bearing automation', () => {
  it('keeps the BrepKit updater on a GitHub-hosted runner', () => {
    const workflow = readFileSync(
      '.github/workflows/update-brepkit.yml',
      'utf8'
    );

    expect(workflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).not.toContain('blacksmith-');
  });
});
