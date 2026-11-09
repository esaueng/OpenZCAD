import { describe, expect, it } from 'vitest';
import {
  additiveUnitManifest,
  browserSpecsFromChanges,
  selectCI
} from '../scripts/ci-selection.mjs';
import {
  relatedFiles,
  runUnits,
  selectedFiles
} from '../scripts/run-ci-units.mjs';
import { unitTestInclude } from '../scripts/unit-suites.mjs';
import { resolve } from 'node:path';

describe('critical and affected CI selection', () => {
  it('narrows only semantic additions that preserve both critical manifests', () => {
    const before = { root: ['test/auth.test.ts'], web: ['src/App.test.tsx'] };
    const after = { ...before, root: [...before.root, 'test/io.test.ts'] };
    expect(
      additiveUnitManifest(JSON.stringify(before), JSON.stringify(after))
    ).toBe(true);
    for (const invalid of [
      before,
      { ...after, root: ['test/io.test.ts'] },
      { ...after, web: [] },
      { ...after, root: [...after.root, 'test/io.test.ts'] },
      { ...after, extra: [] },
      { ...after, root: ['../auth.test.ts'] }
    ])
      expect(
        additiveUnitManifest(JSON.stringify(before), JSON.stringify(invalid))
      ).toBe(false);
    expect(additiveUnitManifest('not JSON', JSON.stringify(after))).toBe(false);
    expect(
      selectCI(['test/unit-ci-files.json'], { manifestAdditions: true }).unit
    ).toBe('smoke');
    expect(selectCI(['test/unit-ci-files.json']).unit).toBe('full');
    expect(
      selectCI(['test/unit-ci-files.json', 'pnpm-lock.yaml'], {
        manifestAdditions: true
      }).unit
    ).toBe('full');
  });

  it('retains critical policy tests and invalidates dynamically loaded package assets', () => {
    for (const path of [
      '.github/workflows/dependency-audit.yml',
      'scripts/dependency-audit-selection.mjs',
      'scripts/install-cargo-audit.sh'
    ])
      expect(selectCI([path]).unit).toBe('smoke');
    for (const path of [
      'packages/kernel-adapter/src/fixture.json',
      'packages/kernel-adapter/src/kernel.wasm',
      'packages/shared/src/template.svg'
    ])
      expect(selectCI([path]).unit).toBe('full');
    expect(unitTestInclude('root', { CI: 'true' })).toContain(
      'test/css-class-coverage.test.ts'
    );
    expect(unitTestInclude('root', { CI: 'true' })).toContain(
      'test/ci-runtime-optimization.test.ts'
    );
  });
  it('runs the full project on failed discovery and preserves the real test exit code', () => {
    const calls: string[][] = [];
    const status = runUnits(
      ['root'],
      { OPENZCAD_UNIT_SUITE: 'smoke' },
      (_file, args, options) => {
        calls.push(args);
        expect(options.env.OPENZCAD_UNIT_SUITE).toBe('full');
        expect(options.env.OPENZCAD_UNIT_FILES).toBeUndefined();
        return { status: 17 };
      }
    );
    expect(status).toBe(17);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('vitest.full.config.ts');
  });
  it('retains complete unit validation for unknown and foundational inputs', () => {
    for (const paths of [
      [],
      ['pnpm-lock.yaml'],
      ['package.json'],
      ['scripts/new.mjs'],
      ['.github/workflows/ci.yml'],
      ['test/support/kernel.ts'],
      ['new-configuration.json'],
      ['packages/kernel-adapter/package.json']
    ]) {
      expect(selectCI(paths)).toEqual({ unit: 'full', e2e: 'smoke' });
    }
    for (const options of [
      { event: 'schedule' },
      { event: 'workflow_dispatch' },
      { labels: ['ci:full'] },
      { labels: ['kernel-bump'] },
      { deleted: true }
    ])
      expect(
        selectCI(['apps/web/src/components/TopBar.tsx'], options).unit
      ).toBe('full');
    expect(selectCI(['apps/web/src/components/TopBar.tsx'])).toEqual({
      unit: 'smoke',
      e2e: 'smoke'
    });
  });

  it('reserves full browsers for explicit qualification and removed browser regressions', () => {
    for (const options of [
      { event: 'schedule' },
      { event: 'workflow_dispatch' },
      { labels: ['ci:full'] }
    ])
      expect(selectCI(['apps/web/src/App.tsx'], options)).toEqual({
        unit: 'full',
        e2e: 'full'
      });
    expect(selectCI(['pnpm-lock.yaml'], { labels: ['kernel-bump'] })).toEqual({
      unit: 'full',
      e2e: 'smoke'
    });
    expect(selectCI(['test/e2e/deleted.spec.ts'], { deleted: true })).toEqual({
      unit: 'full',
      e2e: 'full'
    });
    expect(
      selectCI(['.github/workflows/fleet-ci-v6.yml'], { deleted: true })
    ).toEqual({ unit: 'full', e2e: 'smoke' });
  });

  it('selects changed untagged browser regressions and refuses deleted specs', () => {
    expect(
      browserSpecsFromChanges(
        ['test/e2e/new-regression.spec.ts', 'apps/web/src/App.tsx'],
        ['new-regression.spec.ts', 'modeling.spec.ts']
      )
    ).toEqual(['new-regression.spec.ts']);
    expect(() =>
      browserSpecsFromChanges(['test/e2e/deleted.spec.ts'], [])
    ).toThrow('missing');
  });

  it('adds affected files outside the smoke manifest without dropping critical contracts', () => {
    const extra = 'test/account-deletion.test.ts';
    const selected = selectedFiles('root', [extra, extra], {});
    expect(selected.filter((name) => name === extra)).toHaveLength(1);
    for (const file of unitTestInclude('root', { CI: 'true' })!)
      expect(selected).toContain(file);
    expect(
      unitTestInclude('root', {
        OPENZCAD_UNIT_SUITE: 'smoke',
        OPENZCAD_UNIT_FILES: JSON.stringify({ root: selected })
      })
    ).toEqual(selected);
  });

  it('validates Vitest discovery against real project files and refuses escaped or stale inventories', () => {
    expect(
      relatedFiles(
        'root',
        [{ file: resolve('test/auth.test.ts') }],
        process.cwd()
      )
    ).toEqual(['test/auth.test.ts']);
    expect(relatedFiles('root', [], process.cwd())).toEqual([]);
    expect(() => relatedFiles('root', {}, process.cwd())).toThrow('array');
    expect(() =>
      relatedFiles('root', [{ file: '../outside.test.ts' }], process.cwd())
    ).toThrow('escaped');
    expect(() =>
      relatedFiles('root', [{ file: 'test/missing.test.ts' }], process.cwd())
    ).toThrow('Missing');
    expect(() => relatedFiles('root', [{}], process.cwd())).toThrow(
      'lacks a file'
    );
  });
});
