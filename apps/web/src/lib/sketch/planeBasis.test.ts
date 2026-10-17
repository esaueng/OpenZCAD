import { describe, expect, it } from 'vitest';
import { addDatumPlane, createProjectDocument } from '@openzcad/document-core';
import { toUserId, type FeatureId } from '@openzcad/shared';
import { resolvedSketchPlaneBasis } from './planeBasis';

describe('resolvedSketchPlaneBasis on a datum plane (R01)', () => {
  const planed = addDatumPlane(
    createProjectDocument('Datum sketch', toUserId('user_plane_basis')),
    {
      name: 'Lid plane',
      definition: {
        kind: 'offset',
        source: { type: 'canonical', plane: 'XY', offset: 0 },
        offset: 10
      }
    }
  );
  const frame = {
    origin: { x: 0, y: 0, z: 10 },
    u: { x: 1, y: 0, z: 0 },
    v: { x: 0, y: 1, z: 0 },
    normal: { x: 0, y: 0, z: 1 }
  };
  const planeRef = { type: 'datum', datumFeatureId: planed.featureId } as const;

  it('uses the frame the exact build published', () => {
    const document = {
      ...planed.document,
      derived: {
        ...planed.document.derived,
        datumFrames: { [planed.featureId]: frame }
      }
    };
    expect(
      resolvedSketchPlaneBasis(document, planeRef, () => 0, 'Lid sketch')
    ).toEqual(frame);
  });

  it('refuses by name rather than guessing a plane when none resolved', () => {
    expect(() =>
      resolvedSketchPlaneBasis(
        planed.document,
        { type: 'datum', datumFeatureId: 'feat_missing' as FeatureId },
        () => 0,
        'Lid sketch'
      )
    ).toThrow('Sketch "Lid sketch" is on a datum plane that has not resolved.');
  });
});
