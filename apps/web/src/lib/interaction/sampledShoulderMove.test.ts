import { describe, expect, it } from 'vitest';
import type {
  BodyTopology,
  EdgeTopology,
  FaceGeometry,
  FaceTopology
} from '@openzcad/shared';
import { sampledShoulderMove } from './sampledShoulderMove';

// An R6 boss on a block whose top is z = 26 and whose cap is z = 35, with an
// R2 concave shoulder at the boss's foot and an R2 convex rim on its cap.
const face = (hash: number, geometry: Partial<FaceGeometry>): FaceTopology =>
  ({
    topologyId: `f${hash}`,
    hash,
    geometry: { area: 1, center: { x: 0, y: 0, z: 0 }, ...geometry }
  }) as FaceTopology;
const edge = (
  hash: number,
  type: 'CIRCLE' | 'LINE',
  faces: [number, number]
): EdgeTopology =>
  ({
    topologyId: `e${hash}`,
    hash,
    curve: { type },
    adjacentFaceHashes: faces
  }) as unknown as EdgeTopology;
const up = { x: 0, y: 0, z: 1 };
const blockTop = face(1, {
  surfaceType: 'plane',
  normal: up,
  center: { x: 13, y: 15, z: 26 }
});
const cap = face(2, {
  surfaceType: 'plane',
  normal: up,
  center: { x: 0, y: 0, z: 35 }
});
const shoulder = face(3, {
  surfaceType: 'torus',
  featureType: 'blend',
  torusCenter: { x: 0, y: 0, z: 28 },
  majorRadius: 8,
  minorRadius: 2
});
const rim = face(4, {
  surfaceType: 'torus',
  featureType: 'blend',
  torusCenter: { x: 0, y: 0, z: 33 },
  majorRadius: 4,
  minorRadius: 2
});
const edgeRound = face(5, { surfaceType: 'cylinder', featureType: 'blend' });
const body: BodyTopology = {
  faces: [blockTop, cap, shoulder, rim, edgeRound],
  edges: [
    edge(10, 'CIRCLE', [1, 3]),
    edge(11, 'LINE', [1, 5]),
    edge(12, 'CIRCLE', [2, 4])
  ]
};
const NEW = '2026.1.156';
const OLD = '2026.1.155';

describe('sampled shoulder moves', () => {
  it('lowers a boss cap into its shoulder on a blend-group kernel', () => {
    expect(sampledShoulderMove(body, cap, -4, OLD)).toBe(true);
  });

  it('raises a block top into the rim once the kernel can', () => {
    // The shoulder's spring (z = 28) meets the rim's (z = 33) at +5.
    expect(sampledShoulderMove(body, blockTop, 5, NEW)).toBe(true);
    expect(sampledShoulderMove(body, blockTop, 6, NEW)).toBe(true);
    expect(sampledShoulderMove(body, blockTop, 6, OLD)).toBe(false);
  });

  it('keeps the Box resize for a rise that stops short of the rim', () => {
    expect(sampledShoulderMove(body, blockTop, 1, NEW)).toBe(false);
    expect(sampledShoulderMove(body, blockTop, 4.9, NEW)).toBe(false);
  });

  it('needs a rim on the shoulder axis', () => {
    const noRim: BodyTopology = {
      ...body,
      faces: body.faces.filter((f) => f !== rim)
    };
    expect(sampledShoulderMove(noRim, blockTop, 6, NEW)).toBe(false);
    const offAxis = face(4, {
      ...rim.geometry,
      torusCenter: { x: 30, y: 0, z: 33 }
    });
    const otherBoss: BodyTopology = {
      ...body,
      faces: body.faces.map((f) => (f === rim ? offAxis : f))
    };
    expect(sampledShoulderMove(otherBoss, blockTop, 6, NEW)).toBe(false);
  });

  it('keeps the dimension edit for a cap rising away from the block', () => {
    expect(sampledShoulderMove(body, cap, 6, NEW)).toBe(false);
  });

  it('keeps the dimension edit for a block top lowered away from the rim', () => {
    expect(sampledShoulderMove(body, blockTop, -4, NEW)).toBe(false);
  });

  it('needs the top to meet a concave shoulder', () => {
    const noShoulder: BodyTopology = {
      ...body,
      edges: [edge(11, 'LINE', [1, 5]), edge(12, 'CIRCLE', [2, 4])]
    };
    expect(sampledShoulderMove(noShoulder, blockTop, 6, NEW)).toBe(false);
    // A convex round on the block top's own edge, as on a cylindrical block.
    const round = face(7, {
      surfaceType: 'torus',
      featureType: 'blend',
      torusCenter: { x: 0, y: 0, z: 24 },
      majorRadius: 20,
      minorRadius: 2
    });
    const convexOnly: BodyTopology = {
      faces: [...body.faces, round],
      edges: [edge(10, 'CIRCLE', [1, 7]), edge(11, 'LINE', [1, 5])]
    };
    expect(sampledShoulderMove(convexOnly, blockTop, 6, NEW)).toBe(false);
  });

  it('needs straight edge rounds beside the torus rounds', () => {
    const toriOnly: BodyTopology = {
      ...body,
      faces: body.faces.filter((f) => f !== edgeRound)
    };
    expect(sampledShoulderMove(toriOnly, blockTop, 6, NEW)).toBe(false);
    expect(sampledShoulderMove(toriOnly, cap, -4, NEW)).toBe(false);
  });

  it('ignores faces that do not face up', () => {
    const side = face(6, {
      surfaceType: 'plane',
      normal: { x: 1, y: 0, z: 0 },
      center: { x: 13, y: 15, z: 20 }
    });
    expect(
      sampledShoulderMove(
        { ...body, edges: [...body.edges, edge(13, 'CIRCLE', [6, 3])] },
        side,
        6,
        NEW
      )
    ).toBe(false);
  });
});
