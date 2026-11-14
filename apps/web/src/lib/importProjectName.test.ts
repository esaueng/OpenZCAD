import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from '@openzcad/shared';
import { isCutePartName } from './cutePartName';
import { importNamingFor, importNamingStep } from './importProjectName';

type Doc = Parameters<typeof importNamingStep>[1];

function doc(overrides: Partial<Doc> = {}): Doc {
  return {
    projectId: 'proj_a' as ProjectDocument['projectId'],
    name: 'Lucky Quokka',
    featureOrder: [],
    sketchOrder: [],
    nodes: {},
    ...overrides
  };
}

function withFeature(featureKind: string, base: Partial<Doc> = {}): Doc {
  return doc({
    ...base,
    featureOrder: ['feat_1' as never],
    nodes: {
      n1: {
        id: 'n1',
        parentId: null,
        revisionId: null,
        name: 'Imported',
        kind: 'feature',
        featureId: 'feat_1',
        featureKind,
        data: { featureKind }
      } as never
    }
  });
}

function withSketch(name: string): Doc {
  return doc({
    sketchOrder: ['sk_1' as never],
    nodes: {
      s1: {
        id: 's1',
        parentId: null,
        revisionId: null,
        name,
        kind: 'sketch',
        sketchId: 'sk_1'
      } as never
    }
  });
}

describe('suggested project names', () => {
  it('recognises the suggestions and nothing else', () => {
    expect(isCutePartName('Lucky Quokka')).toBe(true);
    expect(isCutePartName('Tiny Fox')).toBe(true);
    expect(isCutePartName('Lucky Quokka 2')).toBe(false);
    expect(isCutePartName('Pump housing')).toBe(false);
    expect(isCutePartName('lucky quokka')).toBe(false);
    expect(isCutePartName('Quokka')).toBe(false);
  });
});

describe('naming a new project for its first import', () => {
  it('names an empty, suggested-name project for the file', () => {
    const naming = importNamingFor(doc(), [{ name: 'pump-housing.step' }]);
    expect(naming).toEqual({
      projectId: 'proj_a',
      name: 'pump-housing',
      dxf: false
    });
    expect(importNamingStep(naming!, doc())).toEqual({ kind: 'wait' });
    expect(importNamingStep(naming!, withFeature('imported-step'))).toEqual({
      kind: 'rename',
      name: 'pump-housing'
    });
    expect(importNamingStep(naming!, withFeature('imported-mesh'))).toEqual({
      kind: 'rename',
      name: 'pump-housing'
    });
  });

  it('takes a Shapr3D pair’s name from the .shapr file', () => {
    expect(
      importNamingFor(doc(), [
        { name: 'companion.step' },
        { name: 'Gearbox.shapr' }
      ])?.name
    ).toBe('Gearbox');
  });

  it('leaves a named or non-empty project alone', () => {
    const files = [{ name: 'pump-housing.step' }];
    expect(importNamingFor(doc({ name: 'Pump' }), files)).toBeNull();
    expect(importNamingFor(withFeature('extrude'), files)).toBeNull();
    expect(importNamingFor(withSketch('Sketch 1'), files)).toBeNull();
    expect(importNamingFor(doc(), [])).toBeNull();
  });

  it('drops the naming when something else lands first', () => {
    const naming = importNamingFor(doc(), [{ name: 'pump-housing.step' }])!;
    // A box drawn after a cancelled import.
    expect(importNamingStep(naming, withFeature('extrude'))).toEqual({
      kind: 'drop'
    });
    expect(importNamingStep(naming, withSketch('Sketch 1'))).toEqual({
      kind: 'drop'
    });
    // Renamed meanwhile, or a different project on screen.
    expect(
      importNamingStep(naming, withFeature('imported-step', { name: 'Mine' }))
    ).toEqual({
      kind: 'drop'
    });
    expect(
      importNamingStep(naming, doc({ projectId: 'proj_b' as never }))
    ).toEqual({ kind: 'drop' });
  });

  it('names a DXF import from the sketch it makes', () => {
    const naming = importNamingFor(doc(), [{ name: 'floor-plan.dxf' }])!;
    expect(naming.dxf).toBe(true);
    expect(importNamingStep(naming, withSketch('floor-plan'))).toEqual({
      kind: 'rename',
      name: 'floor-plan'
    });
    expect(importNamingStep(naming, withSketch('Sketch 1'))).toEqual({
      kind: 'drop'
    });
    expect(importNamingStep(naming, withFeature('imported-step'))).toEqual({
      kind: 'drop'
    });
  });
});
