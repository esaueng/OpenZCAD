import { describe, expect, it } from 'vitest';
import { planStartScreenImport, projectNameForFile } from './startScreenImport';

const file = (name: string) => new File(['x'], name);

describe('planStartScreenImport', () => {
  it('restores a lone backup', () => {
    const backup = file('Lid.openzcad');
    expect(planStartScreenImport([backup])).toEqual({
      kind: 'backup',
      file: backup
    });
  });

  it('makes a project named for a CAD file', () => {
    const step = file('bracket_v2.STEP');
    expect(planStartScreenImport([step])).toEqual({
      kind: 'cad',
      name: 'bracket_v2',
      files: [step]
    });
  });

  it('names a Shapr3D pair for the .shapr file', () => {
    const plan = planStartScreenImport([
      file('export.step'),
      file('Gearbox.shapr')
    ]);
    expect(plan).toMatchObject({ kind: 'cad', name: 'Gearbox' });
  });

  it('refuses a backup dropped with other files', () => {
    expect(planStartScreenImport([file('a.openzcad'), file('b.step')])).toEqual(
      {
        kind: 'refuse',
        message: '2 files dropped. Drop one .openzcad backup on its own.'
      }
    );
  });

  it('refuses a format it cannot import before making a project', () => {
    const plan = planStartScreenImport([file('model.FCStd')]);
    expect(plan.kind).toBe('refuse');
    expect(plan.kind === 'refuse' && plan.message).toContain(
      'can’t import .FCStd files'
    );
  });
});

describe('projectNameForFile', () => {
  it('drops the extension and falls back when nothing is left', () => {
    expect(projectNameForFile('Pump housing.stp')).toBe('Pump housing');
    expect(projectNameForFile('.stl')).toBe('Imported part');
    expect(projectNameForFile(`${'x'.repeat(250)}.stl`)).toHaveLength(200);
  });
});
