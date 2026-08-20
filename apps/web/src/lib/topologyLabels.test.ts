import { describe, expect, it } from 'vitest';
import type { BodyRepresentation } from '@openzcad/shared';
import {
  edgeLabel,
  edgeLength,
  edgeLengthMeasurement,
  faceLabel,
  topologySelectionLabel
} from './topologyLabels';

function makeBody(): BodyRepresentation {
  return {
    bodyId: 'body-1' as BodyRepresentation['bodyId'],
    name: 'Box',
    source: 'primitive',
    mesh: { kind: 'mesh', vertices: Float32Array.from([]), indices: Uint32Array.from([]) },
    faceCount: 6,
    color: '#fff',
    exportableStep: true,
    consumed: false,
    volume: 1000,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
    topology: {
      faces: [
        {
          topologyId: 'face:1',
          hash: 1,
          triangleStart: 0,
          triangleCount: 2,
          geometry: {
            surfaceType: 'plane',
            area: 100,
            center: { x: 5, y: 5, z: 10 },
            normal: { x: 0, y: 0, z: 1 }
          }
        },
        {
          topologyId: 'face:2',
          hash: 2,
          triangleStart: 2,
          triangleCount: 2,
          geometry: {
            surfaceType: 'plane',
            area: 100,
            center: { x: 5, y: 5, z: 0 },
            normal: { x: 0, y: 0, z: -1 }
          }
        },
        {
          topologyId: 'face:3',
          hash: 3,
          triangleStart: 4,
          triangleCount: 2,
          geometry: {
            surfaceType: 'cylinder',
            area: 50,
            center: { x: 5, y: 5, z: 5 },
            radius: 4,
            diameter: 8,
            featureType: 'through-hole'
          }
        },
        {
          topologyId: 'face:4',
          hash: 4,
          triangleStart: 6,
          triangleCount: 2
        }
      ],
      edges: [
        {
          topologyId: 'edge:1',
          hash: 11,
          points: [0, 0, 0, 3, 0, 0, 3, 4, 0]
        },
        { topologyId: 'edge:2', hash: 12, points: [0, 0, 0] }
      ]
    }
  };
}

describe('faceLabel', () => {
  const body = makeBody();

  it('names axis-aligned planar faces by direction', () => {
    expect(faceLabel(body, 1)).toBe('Top face');
    expect(faceLabel(body, 2)).toBe('Bottom face');
  });

  it('names through holes with their diameter', () => {
    expect(faceLabel(body, 3)).toBe('Through hole Ø8');
  });

  it('names recognized blends by their rolling-ball radius', () => {
    const blend = makeBody();
    blend.topology!.faces[3]!.geometry = {
      surfaceType: 'torus',
      area: 12,
      center: { x: 5, y: 5, z: 5 },
      featureType: 'blend',
      blendRadius: 1.25
    };
    expect(faceLabel(blend, 4)).toBe('Blend face R1.25');
  });

  it('falls back to a stable ordinal and never leaks the fingerprint', () => {
    expect(faceLabel(body, 4)).toBe('Face 4');
    expect(faceLabel(undefined, 99)).toBe('Face');
    expect(faceLabel(body, 4)).not.toContain('4'.repeat(6));
  });

  it('resolves faces by topologyId when the hash is absent', () => {
    expect(faceLabel(body, undefined, 'face:1')).toBe('Top face');
  });
});

describe('edgeLabel / edgeLength', () => {
  const body = makeBody();

  it('names edges by ordinal', () => {
    expect(edgeLabel(body, 11)).toBe('Edge 1');
    expect(edgeLabel(body, undefined, 'edge:2')).toBe('Edge 2');
    expect(edgeLabel(undefined, 11)).toBe('Edge');
  });

  it('names exact circular edges by radius', () => {
    const circular = makeBody();
    circular.topology!.edges[0]!.curve = {
      type: 'CIRCLE',
      circle: {
        center: { x: 0, y: 0, z: 0 },
        axis: { x: 0, y: 0, z: 1 },
        radius: 4
      }
    };
    expect(edgeLabel(circular, 11)).toBe('Edge R4');
  });

  it('measures the sampled polyline length', () => {
    expect(edgeLength(body, 11)).toBeCloseTo(7);
    expect(edgeLength(body, 12)).toBe(0);
    expect(edgeLength(undefined, 11)).toBeNull();
    expect(edgeLengthMeasurement(body, 11)).toEqual({
      value: 7,
      quality: 'sampled'
    });
  });

  it('prefers the kernel edge length and reports its provenance', () => {
    const exactBody = makeBody();
    exactBody.topology!.edges[0]!.length = 6.999_999_999;
    expect(edgeLengthMeasurement(exactBody, 11)).toEqual({
      value: 6.999_999_999,
      quality: 'exact-kernel'
    });
  });
});

describe('topologySelectionLabel', () => {
  const body = makeBody();

  it('shares the body-qualified vocabulary used by measurement targets', () => {
    expect(
      topologySelectionLabel(body, {
        kind: 'face',
        hash: 3,
        topologyId: 'face:3'
      })
    ).toBe('Box · Through hole Ø8');
    expect(topologySelectionLabel(body, { kind: 'body' })).toBe('Box');
  });
});
