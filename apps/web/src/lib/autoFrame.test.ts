import { describe, expect, it } from 'vitest';
import { toBodyId, type BodyRepresentation } from '@openzcad/shared';
import { bodiesReachingNewSpace } from './autoFrame';

function body(
  id: string,
  min: [number, number, number],
  max: [number, number, number],
  consumed = false
): BodyRepresentation {
  return {
    bodyId: toBodyId(id),
    name: id,
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array(),
      indices: new Uint32Array()
    },
    faceCount: 6,
    color: '#ffffff',
    exportableStep: true,
    consumed,
    volume: 1,
    bbox: {
      min: { x: min[0], y: min[1], z: min[2] },
      max: { x: max[0], y: max[1], z: max[2] }
    }
  };
}

function map(...bodies: BodyRepresentation[]) {
  return Object.fromEntries(bodies.map((entry) => [entry.bodyId, entry]));
}

describe('bodiesReachingNewSpace', () => {
  const plate = body('plate', [0, 0, 0], [80, 40, 5]);

  it('names a body the commit created', () => {
    // The bracket recipe's second box: the flange did not exist before.
    const flange = body('flange', [0, 0, 0], [80, 5, 40]);
    expect(bodiesReachingNewSpace(map(plate), map(plate, flange))).toEqual([
      toBodyId('flange')
    ]);
  });

  it('names a body that grew or moved past its old bounds', () => {
    const wider = body('plate', [0, 0, 0], [120, 40, 5]);
    expect(bodiesReachingNewSpace(map(plate), map(wider))).toEqual([
      toBodyId('plate')
    ]);
    const moved = body('plate', [200, 0, 0], [280, 40, 5]);
    expect(bodiesReachingNewSpace(map(plate), map(moved))).toEqual([
      toBodyId('plate')
    ]);
  });

  it('ignores a body that kept or shrank its bounds', () => {
    const filleted = body('plate', [0, 0, 0], [80, 40, 5 - 1e-9]);
    const narrower = body('plate', [0, 0, 0], [60, 40, 5]);
    expect(bodiesReachingNewSpace(map(plate), map(filleted))).toEqual([]);
    expect(bodiesReachingNewSpace(map(plate), map(narrower))).toEqual([]);
  });

  it('skips consumed bodies and treats a revived one as new', () => {
    const consumedPlate = body('plate', [0, 0, 0], [80, 40, 5], true);
    const union = body('union', [0, 0, 0], [80, 40, 40]);
    expect(
      bodiesReachingNewSpace(map(plate), map(consumedPlate, union))
    ).toEqual([toBodyId('union')]);
    expect(bodiesReachingNewSpace(map(consumedPlate), map(plate))).toEqual([
      toBodyId('plate')
    ]);
  });
});
