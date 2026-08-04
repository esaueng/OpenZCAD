import { describe, expect, it } from 'vitest';

import {
  recognizeImportedFeature,
  type ExactAdjacencyRelation,
  type ExactCylinderSurface,
  type ExactFaceAdjacency,
  type ExactFaceAdjacencyQuery,
  type ExactPlaneSurface,
  type ExactPoint3,
  type ExactRecognitionFace
} from './imported-feature-recognition';

const ORIGIN: ExactPoint3 = [0, 0, 0];
const Z_AXIS: ExactPoint3 = [0, 0, 1];

class ExactGraph implements ExactFaceAdjacencyQuery {
  private readonly faces = new Map<string, ExactRecognitionFace>();
  private readonly adjacency = new Map<string, ExactFaceAdjacency[]>();

  add(face: ExactRecognitionFace): this {
    this.faces.set(face.id, face);
    this.adjacency.set(face.id, []);
    return this;
  }

  link(
    left: string,
    right: string,
    relation: ExactAdjacencyRelation,
    boundary: ExactFaceAdjacency['boundary'],
    closed: boolean
  ): this {
    this.adjacency
      .get(left)!
      .push({ faceId: right, relation, boundary, closed });
    this.adjacency
      .get(right)!
      .push({ faceId: left, relation, boundary, closed });
    return this;
  }

  getFace(faceId: string): ExactRecognitionFace | undefined {
    return this.faces.get(faceId);
  }

  getAdjacentFaces(faceId: string): readonly ExactFaceAdjacency[] {
    return this.adjacency.get(faceId) ?? [];
  }
}

function plane(
  id: string,
  z: number,
  area: number,
  extra: Pick<ExactPlaneSurface, 'normal' | 'polygon'> = {
    normal: Z_AXIS,
    polygon: undefined
  }
): ExactRecognitionFace {
  return {
    id,
    surface: {
      kind: 'plane',
      origin: [0, 0, z],
      normal: extra.normal,
      area,
      ...(extra.polygon ? { polygon: extra.polygon } : {})
    }
  };
}

function cylinder(
  id: string,
  radius: number,
  axialStart: number,
  axialEnd: number,
  radialSense: ExactCylinderSurface['radialSense'],
  sweepRadians = Math.PI * 2
): ExactRecognitionFace {
  return {
    id,
    surface: {
      kind: 'cylinder',
      axisOrigin: ORIGIN,
      axisDirection: Z_AXIS,
      radius,
      axialStart,
      axialEnd,
      sweepRadians,
      radialSense
    }
  };
}

function expectRecognized(
  graph: ExactGraph,
  seedFaceId: string
): Extract<
  ReturnType<typeof recognizeImportedFeature>,
  { status: 'recognized' }
> {
  const result = recognizeImportedFeature(graph, seedFaceId);
  expect(result.status).toBe('recognized');
  if (result.status !== 'recognized') {
    throw new Error(`${result.reason}: ${result.message}`);
  }
  return result;
}

function blindHoleGraph(sweepRadians = Math.PI * 2): ExactGraph {
  return new ExactGraph()
    .add(cylinder('wall', 2, 0, 5, 'toward-axis', sweepRadians))
    .add(plane('opening', 0, 100))
    .add(plane('bottom', 5, Math.PI * 4))
    .link('wall', 'opening', 'concave', 'circle', true)
    .link('wall', 'bottom', 'concave', 'circle', true);
}

describe('recognizeImportedFeature', () => {
  it('proves a blind cylindrical hole with stable exact dimensions', () => {
    const result = expectRecognized(blindHoleGraph(), 'wall');

    expect(result.proof).toMatchObject({
      kind: 'blind-cylindrical-hole',
      diameter: 4,
      depth: 5,
      openingFaceId: 'opening',
      bottomFaceId: 'bottom',
      participatingFaceIds: ['bottom', 'opening', 'wall']
    });
  });

  it('proves a counterbore from either cylindrical wall', () => {
    const graph = new ExactGraph()
      .add(cylinder('outer', 4, 0, 2, 'toward-axis'))
      .add(cylinder('inner', 2, 2, 8, 'toward-axis'))
      .add(plane('opening', 0, 200))
      .add(plane('step', 2, Math.PI * 12))
      .add(plane('bottom', 8, Math.PI * 4))
      .link('outer', 'opening', 'concave', 'circle', true)
      .link('outer', 'step', 'concave', 'circle', true)
      .link('inner', 'step', 'concave', 'circle', true)
      .link('inner', 'bottom', 'concave', 'circle', true);

    for (const seed of ['outer', 'inner']) {
      const result = expectRecognized(graph, seed);
      expect(result.proof).toMatchObject({
        kind: 'counterbore',
        outerDiameter: 8,
        innerDiameter: 4,
        counterboreDepth: 2,
        totalDepth: 8,
        participatingFaceIds: ['bottom', 'inner', 'opening', 'outer', 'step']
      });
    }
  });

  it('proves a countersink and keeps the included angle authoritative', () => {
    const graph = new ExactGraph()
      .add({
        id: 'sink',
        surface: {
          kind: 'cone',
          axisOrigin: ORIGIN,
          axisDirection: Z_AXIS,
          axialStart: 0,
          axialEnd: 2,
          radiusAtStart: 4,
          radiusAtEnd: 2,
          semiAngleRadians: Math.PI / 4,
          sweepRadians: Math.PI * 2,
          radialSense: 'toward-axis'
        }
      })
      .add(cylinder('hole', 2, 2, 8, 'toward-axis'))
      .add(plane('opening', 0, 200))
      .add(plane('bottom', 8, Math.PI * 4))
      .link('sink', 'opening', 'concave', 'circle', true)
      .link('sink', 'hole', 'concave', 'circle', true)
      .link('hole', 'bottom', 'concave', 'circle', true);

    for (const seed of ['sink', 'hole']) {
      const result = expectRecognized(graph, seed);
      expect(result.proof).toMatchObject({
        kind: 'countersink',
        openingDiameter: 8,
        holeDiameter: 4,
        angleRadians: Math.PI / 2,
        countersinkDepth: 2,
        totalDepth: 8,
        authoritativeParameter: 'angle'
      });
    }
  });

  it('proves a cylindrical boss', () => {
    const graph = new ExactGraph()
      .add(cylinder('wall', 3, 0, 4, 'away-from-axis'))
      .add(plane('support', 0, 100))
      .add(plane('cap', 4, Math.PI * 9))
      .link('wall', 'support', 'convex', 'circle', true)
      .link('wall', 'cap', 'convex', 'circle', true);

    expect(expectRecognized(graph, 'wall').proof).toMatchObject({
      kind: 'cylindrical-boss',
      diameter: 6,
      height: 4,
      referenceFaceId: 'support',
      capFaceId: 'cap'
    });
  });

  it('proves a prismatic pocket from one exact planar loop', () => {
    const polygon: readonly ExactPoint3[] = [
      [-1, -1, 0],
      [1, -1, 0],
      [1, 1, 0],
      [-1, 1, 0]
    ];
    const graph = new ExactGraph()
      .add(plane('floor', 0, 4, { normal: Z_AXIS, polygon }))
      .add(plane('opening', 3, 100))
      .add({
        id: 'west',
        surface: {
          kind: 'plane',
          origin: [-1, 0, 0],
          normal: [1, 0, 0],
          area: 6
        }
      })
      .add({
        id: 'south',
        surface: {
          kind: 'plane',
          origin: [0, -1, 0],
          normal: [0, 1, 0],
          area: 6
        }
      })
      .add({
        id: 'east',
        surface: {
          kind: 'plane',
          origin: [1, 0, 0],
          normal: [-1, 0, 0],
          area: 6
        }
      })
      .add({
        id: 'north',
        surface: {
          kind: 'plane',
          origin: [0, 1, 0],
          normal: [0, -1, 0],
          area: 6
        }
      });
    const walls = ['west', 'south', 'east', 'north'];
    for (const wall of walls) {
      graph
        .link('floor', wall, 'concave', 'line', false)
        .link('opening', wall, 'concave', 'line', false);
    }
    graph
      .link('west', 'south', 'concave', 'line', false)
      .link('south', 'east', 'concave', 'line', false)
      .link('east', 'north', 'concave', 'line', false)
      .link('north', 'west', 'concave', 'line', false);

    expect(expectRecognized(graph, 'floor').proof).toMatchObject({
      kind: 'prismatic-pocket',
      depth: 3,
      extrusionDirection: [0, 0, 1],
      wallFaceIds: ['east', 'north', 'south', 'west'],
      profileVertices: polygon,
      participatingFaceIds: [
        'east',
        'floor',
        'north',
        'opening',
        'south',
        'west'
      ]
    });
  });

  it('proves a taper with an explicit reference end and authoritative semi-angle', () => {
    const semiAngle = Math.atan(0.5);
    const graph = new ExactGraph()
      .add({
        id: 'taper',
        surface: {
          kind: 'cone',
          axisOrigin: ORIGIN,
          axisDirection: Z_AXIS,
          axialStart: 0,
          axialEnd: 4,
          radiusAtStart: 3,
          radiusAtEnd: 1,
          semiAngleRadians: semiAngle,
          sweepRadians: Math.PI * 2,
          radialSense: 'away-from-axis'
        }
      })
      .add(plane('support', 0, 200))
      .add(plane('cap', 4, Math.PI))
      .link('taper', 'support', 'convex', 'circle', true)
      .link('taper', 'cap', 'convex', 'circle', true);

    expect(expectRecognized(graph, 'taper').proof).toMatchObject({
      kind: 'conical-taper',
      referenceEnd: 'start',
      directionFromReference: [0, 0, 1],
      referenceRadius: 3,
      oppositeRadius: 1,
      length: 4,
      angleRadians: semiAngle,
      authoritativeParameter: 'angle'
    });
  });

  it.each([
    [
      'blend-detected',
      { id: 'seed', surface: { kind: 'blend', typeName: 'fillet' } }
    ],
    [
      'unsupported-surface',
      { id: 'seed', surface: { kind: 'bspline', typeName: 'NURBS' } }
    ]
  ] as const)('refuses %s seeds explicitly', (reason, face) => {
    const result = recognizeImportedFeature(new ExactGraph().add(face), 'seed');
    expect(result).toMatchObject({ status: 'unsupported', reason });
  });

  it('refuses ribs and intersections encountered in the proof graph', () => {
    for (const [relation, reason] of [
      ['rib', 'rib-detected'],
      ['intersection', 'intersection-detected'],
      ['non-manifold', 'intersection-detected']
    ] as const) {
      const graph = blindHoleGraph();
      graph.link('opening', 'bottom', relation, 'curve', false);
      const result = recognizeImportedFeature(graph, 'wall');
      expect(result).toMatchObject({ status: 'unsupported', reason });
    }
  });

  it('refuses partial revolutions, ambiguous twins, and incomplete proof', () => {
    expect(
      recognizeImportedFeature(blindHoleGraph(Math.PI), 'wall')
    ).toMatchObject({
      status: 'unsupported',
      reason: 'partial-revolution'
    });

    const twins = new ExactGraph()
      .add(cylinder('wall', 2, 0, 5, 'away-from-axis'))
      .add(plane('first', 0, Math.PI * 4))
      .add(plane('second', 5, Math.PI * 4))
      .link('wall', 'first', 'convex', 'circle', true)
      .link('wall', 'second', 'convex', 'circle', true);
    expect(recognizeImportedFeature(twins, 'wall')).toMatchObject({
      status: 'unsupported',
      reason: 'ambiguous-twins'
    });

    const incomplete = new ExactGraph()
      .add(cylinder('wall', 2, 0, 5, 'toward-axis'))
      .add(plane('opening', 0, 100))
      .link('wall', 'opening', 'concave', 'circle', true);
    expect(recognizeImportedFeature(incomplete, 'wall')).toMatchObject({
      status: 'unsupported',
      reason: 'incomplete-proof'
    });
  });

  it('stops at configured face, adjacency, and polygon work bounds', () => {
    expect(
      recognizeImportedFeature(blindHoleGraph(), 'wall', { maxFaces: 1 })
    ).toMatchObject({ status: 'unsupported', reason: 'work-limit-exceeded' });
    expect(
      recognizeImportedFeature(blindHoleGraph(), 'wall', { maxAdjacencies: 1 })
    ).toMatchObject({ status: 'unsupported', reason: 'work-limit-exceeded' });

    const polygon: readonly ExactPoint3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0]
    ];
    const floor = new ExactGraph().add(
      plane('floor', 0, 1, { normal: Z_AXIS, polygon })
    );
    expect(
      recognizeImportedFeature(floor, 'floor', { maxPolygonVertices: 3 })
    ).toMatchObject({ status: 'unsupported', reason: 'work-limit-exceeded' });
  });
});
