import { describe, expect, it } from 'vitest';
import {
  describeReadingSize,
  historicalUnitlessReading,
  importedMeshUnitsReadout,
  isUnitlessMeshFileName,
  meshExtent,
  settledUnitlessReading,
  sketchObjectsExtent,
  verticesReadAs
} from './importUnits';

describe('unitless import readings', () => {
  it('knows which mesh formats state no unit', () => {
    expect(isUnitlessMeshFileName('part.STL')).toBe(true);
    expect(isUnitlessMeshFileName('scan.obj')).toBe(true);
    expect(isUnitlessMeshFileName('cloud.ply')).toBe(true);
    expect(isUnitlessMeshFileName('print.3mf')).toBe(false);
    expect(isUnitlessMeshFileName('view.glb')).toBe(false);
  });

  it('preselects what the import always assumed', () => {
    expect(historicalUnitlessReading('mesh', 'inch')).toBe('mm');
    expect(historicalUnitlessReading('dxf', 'inch')).toBe('inch');
  });

  it('settles without asking only when the preference names a unit', () => {
    expect(settledUnitlessReading('ask', 'mm')).toBeNull();
    expect(settledUnitlessReading('document', 'cm')).toBe('cm');
    expect(settledUnitlessReading('inch', 'mm')).toBe('inch');
  });

  it('turns the file numbers into millimetres for the chosen unit', () => {
    expect(verticesReadAs([1, 2, 10], 'inch')).toEqual([25.4, 50.8, 254]);
    expect(verticesReadAs([1, 2, 3], 'mm')).toEqual([1, 2, 3]);
  });
});

describe('sizing each choice', () => {
  it('measures a mesh on every axis', () => {
    expect(meshExtent([0, 0, 0, 20, 10, 5, -1, 2, 1])).toEqual([21, 10, 5]);
    expect(meshExtent([])).toEqual([0, 0, 0]);
  });

  it('measures sketch curves, arcs by the extremes they sweep', () => {
    expect(
      sketchObjectsExtent([
        { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
        {
          objectKind: 'arc',
          centerX: 10,
          centerY: 0,
          radius: 5,
          startAngleDeg: 0,
          endAngleDeg: 180
        }
      ])
    ).toEqual([15, 5]);
    expect(
      sketchObjectsExtent([
        { objectKind: 'circle', centerX: 0, centerY: 0, radius: 2 }
      ])
    ).toEqual([4, 4]);
  });

  it('states each reading in the project units', () => {
    expect(describeReadingSize([20, 10, 5], 'mm', 'mm')).toBe('20 × 10 × 5 mm');
    expect(describeReadingSize([20, 10, 5], 'inch', 'mm')).toBe(
      '508 × 254 × 127 mm'
    );
    expect(describeReadingSize([20, 10], 'mm', 'inch')).toBe(
      '0.787 × 0.394 in'
    );
    expect(describeReadingSize([1.5, 0], 'm', 'cm')).toBe('150 × 0 cm');
  });
});

describe('imported mesh units readout', () => {
  const documentWith = (data: Record<string, unknown>) =>
    ({
      nodes: {
        feature_1: {
          kind: 'feature',
          bodyId: 'body_1',
          data: {
            featureKind: 'imported-mesh',
            artifactId: 'artifact_1',
            triangleCount: 1,
            ...data
          }
        }
      }
    }) as unknown as Parameters<typeof importedMeshUnitsReadout>[0];

  it('names the unit a unitless file was read in', () => {
    expect(
      importedMeshUnitsReadout(
        documentWith({ sourceName: 'part.stl', assumedUnits: 'inch' }),
        'body_1'
      )
    ).toBe('Inches (the file stated none)');
  });

  it('says when an older unitless import did not record it', () => {
    expect(
      importedMeshUnitsReadout(
        documentWith({ sourceName: 'scan.obj' }),
        'body_1'
      )
    ).toBe('Not recorded (imported before units were saved)');
  });

  it('says nothing for files that declare a unit, or other bodies', () => {
    expect(
      importedMeshUnitsReadout(
        documentWith({ sourceName: 'print.3mf' }),
        'body_1'
      )
    ).toBeNull();
    expect(
      importedMeshUnitsReadout(
        documentWith({ sourceName: 'part.stl', assumedUnits: 'mm' }),
        'body_2'
      )
    ).toBeNull();
    expect(importedMeshUnitsReadout(null, 'body_1')).toBeNull();
  });
});
