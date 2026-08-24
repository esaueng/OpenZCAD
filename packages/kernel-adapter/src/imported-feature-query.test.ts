import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { drillHole } from './exact-cylinder-ops';
import {
  collectRecognizedImportedFeatures,
  RemusImportedFeatureQuery,
  recognizeImportedFeatureOnSolid
} from './imported-feature-query';
import { RemusKernel } from './remus-runtime';

describe('live imported-feature recognition query', () => {
  let kernel: RemusKernel;

  beforeEach(() => {
    kernel = new RemusKernel();
  });

  afterEach(() => {
    kernel.free();
  });

  function plateWithHole(
    style: 'simple' | 'counterbore' | 'countersink'
  ): number {
    return drillHole(kernel, kernel.makeBox(30, 20, 8), {
      surfacePoint: { x: 10, y: 10, z: 8 },
      axis: { x: 0, y: 0, z: -1 },
      radius: 2.5,
      depth: 6,
      style,
      ...(style === 'counterbore'
        ? { counterboreRadius: 5, counterboreDepth: 2 }
        : {}),
      ...(style === 'countersink'
        ? { countersinkRadius: 5, countersinkAngle: Math.PI / 2 }
        : {}),
      entryExtension: 0.2,
      exitExtension: 0
    });
  }

  it.each([
    [
      'simple',
      {
        kind: 'blind-cylindrical-hole',
        diameter: 5,
        depth: 6
      }
    ],
    [
      'counterbore',
      {
        kind: 'counterbore',
        boreDiameter: 5,
        counterboreDiameter: 10,
        counterboreDepth: 2,
        totalDepth: 6
      }
    ],
    [
      'countersink',
      {
        kind: 'countersink',
        boreDiameter: 5,
        totalDepth: 6
      }
    ]
  ] as const)('publishes a non-overlapping %s proof', (style, expected) => {
    const solid = plateWithHole(style);
    const faces = Array.from(kernel.getSolidFaces(solid));
    const identities = new Map(
      faces.map((face, index) => [face, { hash: index + 1 }])
    );
    const recognized = collectRecognizedImportedFeatures(
      kernel,
      solid,
      identities
    );

    const attempts = faces
      .filter((face) =>
        ['cylinder', 'cone'].includes(kernel.getSurfaceType(face))
      )
      .map((face) => recognizeImportedFeatureOnSolid(kernel, solid, face));
    if (recognized.length === 0) {
      const query = new RemusImportedFeatureQuery(kernel, solid);
      throw new Error(
        JSON.stringify({
          attempts,
          surfaces: faces.map((face) => query.getFace(String(face)))
        })
      );
    }
    expect(recognized[0]).toMatchObject(expected);
    if (style === 'countersink' && recognized[0]?.kind === 'countersink') {
      expect(recognized[0].sinkDiameter).toBeCloseTo(10, 10);
      expect(recognized[0].angleRadians).toBeCloseTo(Math.PI / 2, 10);
    }
    const axisDirection =
      recognized[0] && 'axisDirection' in recognized[0]
        ? recognized[0].axisDirection
        : null;
    expect(axisDirection?.x).toBeCloseTo(0);
    expect(axisDirection?.y).toBeCloseTo(0);
    expect(axisDirection?.z).toBeCloseTo(-1);
  });

  it('deduplicates overlapping seeds and keeps a boss out of hole kinds', () => {
    const solid = plateWithHole('counterbore');
    const faces = Array.from(kernel.getSolidFaces(solid));
    const identities = new Map(
      faces.map((face, index) => [face, { hash: index + 1 }])
    );
    expect(
      collectRecognizedImportedFeatures(kernel, solid, identities)
    ).toHaveLength(1);

    const boss = kernel.makeCylinder(3, 4);
    const wall = Array.from(kernel.getSolidFaces(boss)).find(
      (face) => kernel.getSurfaceType(face) === 'cylinder'
    );
    expect(wall).toBeDefined();
    const bossRecognition = recognizeImportedFeatureOnSolid(
      kernel,
      boss,
      wall!
    );
    expect(
      bossRecognition.status === 'recognized'
        ? bossRecognition.proof.kind
        : bossRecognition.status
    ).not.toMatch(/hole|counterbore|countersink/);
  });

  it('keeps a conical entry chamfer grouped with its counterbore proof', () => {
    const counterbore = plateWithHole('counterbore');
    const query = new RemusImportedFeatureQuery(kernel, counterbore);
    const faces = Array.from(kernel.getSolidFaces(counterbore));
    const outerWall = faces.find((face) => {
      const candidate = query.getFace(String(face));
      return (
        candidate?.surface.kind === 'cylinder' &&
        candidate.surface.radialSense === 'toward-axis' &&
        Math.abs(candidate.surface.radius - 5) <= 1e-8
      );
    });
    expect(outerWall).toBeDefined();
    const edgeToFaces = JSON.parse(kernel.edgeToFaceMap(counterbore)) as Record<
      string,
      number[]
    >;
    const entryEdge = Array.from(kernel.getFaceEdges(outerWall!)).find((edge) =>
      (edgeToFaces[String(edge)] ?? []).some((face) => {
        const adjacent = query.getFace(String(face));
        return (
          adjacent?.surface.kind === 'plane' &&
          Math.abs(adjacent.surface.origin[2] - 8) <= 1e-8
        );
      })
    );
    expect(entryEdge).toBeDefined();
    const chamfered = kernel.chamfer(
      counterbore,
      new Uint32Array([entryEdge!]),
      0.5
    );
    const chamferedFaces = Array.from(kernel.getSolidFaces(chamfered));
    const identities = new Map(
      chamferedFaces.map((face, index) => [face, { hash: index + 1 }])
    );

    const proof = collectRecognizedImportedFeatures(
      kernel,
      chamfered,
      identities
    ).find((feature) => feature.kind === 'counterbore');
    expect(proof).toMatchObject({
      kind: 'counterbore',
      boreDiameter: 5,
      counterboreDiameter: 10,
      entryChamfered: true
    });
    expect(
      proof?.kind === 'counterbore' ? proof.counterboreDepth : null
    ).toBeCloseTo(2, 8);
  });
});
