import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  scripts?: Record<string, string>;
}

function packageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

describe('beta deployment safety', () => {
  it('applies remote D1 migrations before publishing the Worker', () => {
    const command = packageJson('apps/web/package.json').scripts?.[
      'deploy:beta'
    ];

    expect(command).toBeDefined();
    expect(command).toContain('wrangler d1 migrations apply');
    expect(command).toContain('wrangler deploy');
    expect(command!.indexOf('wrangler d1 migrations apply')).toBeLessThan(
      command!.indexOf('wrangler deploy')
    );
  });

  it('keeps the root release command delegated to the guarded web script', () => {
    expect(packageJson('package.json').scripts?.['deploy:beta']).toBe(
      'pnpm --filter @openzcad/web deploy:beta'
    );
  });
});
