import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveUnitSuite,
  ROOT_FULL_INCLUDE,
  unitTestInclude,
  validateUnitFiles
} from '../scripts/unit-suites.mjs';

describe('unit suite selection', () => {
  it('keeps full local and kernel-overlay runs, with explicit CI overrides', () => {
    expect(resolveUnitSuite({})).toBe('full');
    expect(resolveUnitSuite({ CI: 'true' })).toBe('smoke');
    expect(resolveUnitSuite({ CI: 'true', OPENZCAD_UNIT_SUITE: 'full' })).toBe(
      'full'
    );
    expect(resolveUnitSuite({ OPENZCAD_UNIT_SUITE: 'smoke' })).toBe('smoke');
    expect(resolveUnitSuite({ CI: 'true', REMUS_WASM_PKG: '/kernel' })).toBe(
      'full'
    );
    expect(
      resolveUnitSuite({ CI: 'true', REMUS_WASM_IO_PKG: '/translator' })
    ).toBe('full');
    expect(() => resolveUnitSuite({ OPENZCAD_UNIT_SUITE: 'typo' })).toThrow(
      'Unknown unit suite'
    );
    expect(unitTestInclude('root', {})).toEqual(ROOT_FULL_INCLUDE);
    expect(unitTestInclude('web', {})).toBeUndefined();
  });

  it('keeps the guard suites and representative coverage from every runtime layer', () => {
    const root = unitTestInclude('root', { CI: 'true' })!;
    for (const name of [
      'unit-suites',
      'unit-global-setup',
      'security-workflow',
      'trusted-pr-policy',
      'fleet-checkout-fixtures',
      'bundle-size-policy',
      'css-class-coverage',
      'deployment-config-validator',
      'desktop-release-privacy',
      'pin-remus',
      'private-artifacts',
      'roadmap-evidence',
      'security-boundary-regressions',
      'step-import-privacy',
      'beta-deployment-verification',
      'e2e-shards',
      'auth',
      'project-authorization',
      'exact-kernel-adapter'
    ])
      expect(root).toContain(`test/${name}.test.ts`);
    for (const name of [
      'shared',
      'document-core',
      'command-system',
      'kernel-adapter',
      'crypto',
      'mls',
      'io-step'
    ]) {
      expect(
        root.some((file) => file.startsWith(`packages/${name}/src/`))
      ).toBe(true);
    }
    const web = unitTestInclude('web', { CI: 'true' })!;
    expect(web).toContain('src/lib/localProjectAutosave.test.ts');
    expect(web).toContain('src/lib/useCollaborationEncrypted.test.tsx');
    expect(web).toContain('src/components/NumericKeypad.test.tsx');
    // Keep every Worker-owned suite, including newly added edge-route tests.
    const workerFiles = readdirSync('apps/web/worker', {
      recursive: true
    }).filter(
      (file): file is string =>
        typeof file === 'string' && /\.test\.ts$/.test(file)
    );
    for (const file of workerFiles) expect(web).toContain(`worker/${file}`);
  });

  it('rejects missing, empty, duplicate, globbed and out-of-project selections', () => {
    expect(() => validateUnitFiles('root', [])).toThrow('empty');
    expect(() =>
      validateUnitFiles('root', ['test/does-not-exist.test.ts'])
    ).toThrow('Missing');
    expect(() =>
      validateUnitFiles('root', ['test/auth.test.ts', 'test/auth.test.ts'])
    ).toThrow('Duplicate');
    for (const file of [
      'test/**/*.test.ts',
      '/test/auth.test.ts',
      'test/../test/auth.test.ts',
      'test//auth.test.ts',
      'src/auth.test.ts'
    ]) {
      expect(() => validateUnitFiles('root', [file])).toThrow('Invalid');
    }
    expect(() => validateUnitFiles('web', ['test/auth.test.ts'])).toThrow(
      'Invalid'
    );
  });

  it('keeps the full root and web entrypoints independent of the CI environment', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:full']).toBe(
      'pnpm test:unit:full && pnpm test:web:full'
    );
    expect(pkg.scripts['test:coverage']).toContain(
      '--config vitest.full.config.ts'
    );
    expect(readFileSync(resolve('vitest.full.config.ts'), 'utf8')).toContain(
      'include: ROOT_FULL_INCLUDE'
    );
    expect(
      readFileSync(resolve('apps/web/vitest.full.config.ts'), 'utf8')
    ).toContain('include: configDefaults.include');
  });
});
