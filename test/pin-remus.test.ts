import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pinRemus } from '../scripts/pin-remus.mjs';

describe('immutable Remus updates', () => {
  const sha = 'a'.repeat(40);
  const manifest = JSON.parse(
    readFileSync('packages/kernel-adapter/package.json', 'utf8')
  ) as { name: string; dependencies: Record<string, string> };

  it.each(['main', 'b'.repeat(40)])(
    'advances both packages from %s without changing other fields',
    (oldRef) => {
      const input = structuredClone(manifest);
      input.dependencies['remus-wasm'] =
        `github:esaueng/remus#${oldRef}&path:/crates/wasm/pkg`;
      input.dependencies['remus-wasm-io'] =
        `github:esaueng/remus#${oldRef}&path:/crates/wasm-io/pkg`;
      const before = structuredClone(input);
      const next = pinRemus(input, sha);
      expect(input).toEqual(before);
      expect(next).toEqual({
        ...before,
        dependencies: {
          ...before.dependencies,
          'remus-wasm': `github:esaueng/remus#${sha}&path:/crates/wasm/pkg`,
          'remus-wasm-io': `github:esaueng/remus#${sha}&path:/crates/wasm-io/pkg`
        }
      });
    }
  );

  it('rejects moving refs and incomplete manifests', () => {
    for (const ref of ['main', '', 'a'.repeat(39), `${sha}&path:/elsewhere`]) {
      expect(() => pinRemus(manifest, ref)).toThrow('Invalid Remus commit');
    }
    expect(() => pinRemus({ dependencies: {} }, sha)).toThrow(
      'Missing remus-wasm'
    );
  });

  it('requires upstream ancestry before changing a pin and keeps the publication diff narrow', () => {
    const workflow = readFileSync('.github/workflows/update-remus.yml', 'utf8');
    const guard = workflow.indexOf('case "$comparison" in');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(workflow.indexOf('node scripts/pin-remus.mjs'));
    expect(workflow).toContain('ahead|identical) ;;');
    expect(workflow).toContain(
      'git add -- packages/kernel-adapter/package.json pnpm-lock.yaml'
    );
    expect(workflow).toContain(
      'packages/kernel-adapter/package\\.json|pnpm-lock\\.yaml'
    );
  });

  it('reviews kernel load time against the current pin without blocking the update', () => {
    const workflow = readFileSync('.github/workflows/update-remus.yml', 'utf8');
    const start = workflow.indexOf(
      '- name: Measure kernel load time against the current pin'
    );
    const end = workflow.indexOf('- name:', start + 1);
    const step = workflow.slice(start, end);

    expect(start).toBeGreaterThan(
      workflow.indexOf('pnpm install --frozen-lockfile')
    );
    expect(end).toBe(
      workflow.indexOf('- name: Require CI-triggering GitHub App credentials')
    );
    expect(step).toContain('continue-on-error: true');
    expect(step).toContain('set -euo pipefail');
    expect(step).toContain('--baseline-package "$baseline"');
    expect(step).toContain('--runs 20');
    expect(step).toMatch(/for profile in desktop mobile/);
    // Measurement output stays out of the checkout, so it can never join
    // the narrow manifest-and-lockfile commit.
    expect(step).not.toMatch(/--(?:out|markdown) (?!"\$RUNNER_TEMP|"\$report)/);
    expect(workflow).toContain('cat "$RUNNER_TEMP/kernel-load.md"');
  });
});
