import { describe, expect, it } from 'vitest';
import {
  toBodyId,
  toFeatureId,
  toEntityId,
  type BodyRepresentation,
  type FeatureData,
  type FeatureNode
} from '@openzcad/shared';
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

function feature(id: string, data: FeatureData): FeatureNode {
  return {
    id: toEntityId(`feature_${id}`),
    kind: 'feature',
    name: id,
    parentId: null,
    revisionId: null,
    featureId: toFeatureId(id),
    bodyId: toBodyId(id),
    featureKind: data.featureKind,
    data
  };
}

function replacement(id: string, target: string) {
  return feature(id, {
    featureKind: 'shell',
    targetBodyId: toBodyId(target),
    openingFaceHashes: [],
    thickness: 1
  });
}

describe('createdBodiesToFrame', () => {
  const plate = body('plate', [0, 0, 0], [80, 40, 5]);

  it('names a body the commit created', () => {
    // The bracket recipe's second box: the flange did not exist before.
    const flange = body('flange', [0, 0, 0], [80, 5, 40]);
    expect(createdBodiesToFrame(map(plate), map(plate, flange), [])).toEqual([
      toBodyId('flange')
    ]);
  });

  it('preserves the camera when an existing body grows or moves', () => {
    const wider = body('plate', [0, 0, 0], [120, 40, 5]);
    expect(createdBodiesToFrame(map(plate), map(wider), [])).toEqual([]);
    const moved = body('plate', [200, 0, 0], [280, 40, 5]);
    expect(createdBodiesToFrame(map(plate), map(moved), [])).toEqual([]);
  });

  it('ignores a body that kept or shrank its bounds', () => {
    const filleted = body('plate', [0, 0, 0], [80, 40, 5 - 1e-9]);
    const narrower = body('plate', [0, 0, 0], [60, 40, 5]);
    expect(createdBodiesToFrame(map(plate), map(filleted), [])).toEqual([]);
    expect(createdBodiesToFrame(map(plate), map(narrower), [])).toEqual([]);
  });

  it('preserves the camera when an edit replaces or revives a body', () => {
    const consumedPlate = body('plate', [0, 0, 0], [80, 40, 5], true);
    const union = body('union', [0, 0, 0], [80, 40, 40]);
    const history = [replacement('union', 'plate')];
    expect(
      createdBodiesToFrame(map(plate), map(consumedPlate, union), history)
    ).toEqual([]);
    expect(createdBodiesToFrame(map(plate), map(union), history)).toEqual([]);
    expect(createdBodiesToFrame(map(consumedPlate), map(plate), [])).toEqual(
      []
    );
    expect(createdBodiesToFrame(map(plate), map(consumedPlate), [])).toEqual(
      []
    );
  });

  it('frames an unrelated addition alongside a chain of existing-body edits', () => {
    const consumedPlate = { ...plate, consumed: true };
    const shell = body('shell', [0, 0, 0], [80, 40, 5], true);
    const offset = body('offset', [0, 0, 0], [120, 60, 10]);
    const flange = body('flange', [200, 0, 0], [280, 5, 40]);
    const history = [
      replacement('shell', 'plate'),
      replacement('offset', 'shell')
    ];
    expect(
      createdBodiesToFrame(
        map(plate),
        map(consumedPlate, shell, offset, flange),
        history
      )
    ).toEqual([flange.bodyId]);
  });

  it('frames a new part finished by result features in the same transaction', () => {
    const blank = body('blank', [200, 0, 0], [280, 40, 5], true);
    const shell = body('shell', [200, 0, 0], [280, 40, 5]);
    expect(
      createdBodiesToFrame(map(plate), map(plate, blank, shell), [
        replacement('shell', 'blank')
      ])
    ).toEqual([shell.bodyId]);
  });

  it('frames an independent mirror but keeps both halves of an existing-body split still', () => {
    const mirror = body('mirror', [200, 0, 0], [280, 40, 5]);
    const positive = body('positive', [0, 0, 0], [40, 40, 5]);
    const negative = body('negative', [40, 0, 0], [80, 40, 5]);
    const plane = {
      origin: { x: 40, y: 0, z: 0 },
      normal: { x: 1, y: 0, z: 0 }
    };
    const history = [
      feature('mirror', {
        featureKind: 'mirror',
        targetBodyId: plate.bodyId,
        plane
      }),
      feature('positive', {
        featureKind: 'split',
        targetBodyId: plate.bodyId,
        plane,
        secondBodyId: negative.bodyId
      })
    ];
    expect(
      createdBodiesToFrame(
        map(plate),
        map({ ...plate, consumed: true }, mirror, positive, negative),
        history
      )
    ).toEqual([mirror.bodyId]);
  });
});
