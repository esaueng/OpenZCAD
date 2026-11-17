import { describe, expect, it } from 'vitest';
import { toFeatureId, type FaceTopologyReferenceV5 } from '@openzcad/shared';
import { measurementProvenanceKey } from './exact-history-cache';
import type { ExactShape } from './exact-types';

function fixture() {
  const face: FaceTopologyReferenceV5 = {
    kind: 'face',
    producingFeatureId: toFeatureId('feat-a'),
    lineageName: 'primitive/top',
    currentHash: 12,
    witnessVersion: 1,
    witness: {
      surfaceType: 'plane',
      perimeter: 40,
      centroid: [0, 0, 0],
      analytic: { kind: 'plane', normal: [0, 0, 1], offset: 0 },
      closure: { u: 'open', v: 'open' }
    }
  };
  const shape: ExactShape = {
    solids: [1],
    lineage: {
      faceReferences: new Map([[2, face]]),
      edgeReferences: new Map(),
      diagnostics: []
    }
  };
  return { face, shape };
}

describe('measurement provenance encoding', () => {
  it('preserves the existing canonical bytes, including nested witness fields', () => {
    const { shape } = fixture();
    expect(measurementProvenanceKey(shape, undefined)).toBe(
      '{"lineage":{"diagnostics":[],"edges":[],"faces":[[2,{"currentHash":12,"kind":"face","lineageName":"primitive/top","producingFeatureId":"feat-a","witness":{"analytic":{"kind":"plane","normal":[0,0,1],"offset":0},"centroid":[0,0,0],"closure":{"u":"open","v":"open"},"perimeter":40,"surfaceType":"plane"},"witnessVersion":1}]]}}'
    );
  });

  it('ignores insertion order without retaining a stale mutable witness', () => {
    const { face, shape } = fixture();
    const original = measurementProvenanceKey(shape, undefined);
    const reordered: ExactShape = {
      ...shape,
      lineage: {
        ...shape.lineage!,
        faceReferences: new Map([
          [
            2,
            {
              ...face,
              witness: {
                closure: { v: 'open', u: 'open' },
                analytic: face.witness.analytic,
                centroid: face.witness.centroid,
                perimeter: 40,
                surfaceType: 'plane'
              }
            }
          ]
        ])
      }
    };
    expect(measurementProvenanceKey(reordered, undefined)).toBe(original);
    face.witness.centroid![0] = 1;
    expect(measurementProvenanceKey(shape, undefined)).not.toBe(original);
  });

  it('keeps native JSON number, escaping and custom serialization behavior', () => {
    const { face, shape } = fixture();
    face.lineageName = 'a"\\\n雪';
    face.witness.centroid = [-0, Number.NaN, Number.POSITIVE_INFINITY];
    const key = measurementProvenanceKey(shape, undefined);
    expect(key).toContain(`"lineageName":${JSON.stringify(face.lineageName)}`);
    expect(key).toContain('"centroid":[0,null,null]');
    Object.defineProperty(face.witness, 'toJSON', {
      value: () => ({ z: 2, a: 1 })
    });
    expect(measurementProvenanceKey(shape, undefined)).toContain(
      '"witness":{"a":1,"z":2}'
    );
  });
});
