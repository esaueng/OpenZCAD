import { describe, expect, it } from 'vitest';
import { toBodyId, type BodyRepresentation } from '@openzcad/shared';
import { createdBodiesToFrame } from './autoFrame';

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

describe('createdBodiesToFrame', () => {
  const plate = body('plate', [0, 0, 0], [80, 40, 5]);

  it('names a body the commit created', () => {
    // The bracket recipe's second box: the flange did not exist before.
    const flange = body('flange', [0, 0, 0], [80, 5, 40]);
    expect(createdBodiesToFrame(map(plate), map(plate, flange))).toEqual([
      toBodyId('flange')
    ]);
  });

  it('preserves the camera when an existing body grows or moves', () => {
    const wider = body('plate', [0, 0, 0], [120, 40, 5]);
    expect(createdBodiesToFrame(map(plate), map(wider))).toEqual([]);
    const moved = body('plate', [200, 0, 0], [280, 40, 5]);
    expect(createdBodiesToFrame(map(plate), map(moved))).toEqual([]);
  });

  it('ignores a body that kept or shrank its bounds', () => {
    const filleted = body('plate', [0, 0, 0], [80, 40, 5 - 1e-9]);
    const narrower = body('plate', [0, 0, 0], [60, 40, 5]);
    expect(createdBodiesToFrame(map(plate), map(filleted))).toEqual([]);
    expect(createdBodiesToFrame(map(plate), map(narrower))).toEqual([]);
  });

  it('preserves the camera when an edit replaces or revives a body', () => {
    const consumedPlate = body('plate', [0, 0, 0], [80, 40, 5], true);
    const union = body('union', [0, 0, 0], [80, 40, 40]);
    expect(createdBodiesToFrame(map(plate), map(consumedPlate, union))).toEqual(
      []
    );
    expect(createdBodiesToFrame(map(plate), map(union))).toEqual([]);
    expect(createdBodiesToFrame(map(consumedPlate), map(plate))).toEqual([]);
    expect(createdBodiesToFrame(map(plate), map(consumedPlate))).toEqual([]);
  });
});
