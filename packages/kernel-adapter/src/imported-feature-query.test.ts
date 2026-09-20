import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { drillHole } from './exact-cylinder-ops';
import {
  collectRecognizedImportedFeatures,
  importedProofDisplayDimensions,
  listPlanarFloorSeeds,
  RemusImportedFeatureQuery,
  recognizeImportedFeatureOnSolid
} from './imported-feature-query';
import { recognitionRefusalMessage } from './imported-feature-recognition';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from './remus-runtime';

describe('live imported-feature recognition query', () => {
  let kernel: RemusKernel;

  beforeAll(async () => {
    await loadRemusTranslators();
  });

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
        boreDiameter: 5
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
      // The revolved-proof cone measures its axis coordinates one ulp off
      // the makeCone construction, so the depth asserts close, not exact.
      expect(recognized[0].totalDepth).toBeCloseTo(6, 10);
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

  it('publishes stable display dimensions keyed by proof field names', () => {
    const solid = plateWithHole('counterbore');
    const faces = Array.from(kernel.getSolidFaces(solid));
    const query = new RemusImportedFeatureQuery(kernel, solid);
    const seed = faces.find((face) => {
      const candidate = query.getFace(String(face));
      return (
        candidate?.surface.kind === 'cylinder' &&
        candidate.surface.radialSense === 'toward-axis'
      );
    });
    expect(seed).toBeDefined();
    const outcome = recognizeImportedFeatureOnSolid(kernel, solid, seed!);
    expect(outcome.status).toBe('recognized');
    if (outcome.status !== 'recognized') {
      throw new Error('Expected the counterbore seed to be recognized.');
    }
    // The Inspector renders these keys verbatim; renaming one is a UI break.
    expect(importedProofDisplayDimensions(outcome.proof)).toEqual({
      outerDiameter: 10,
      innerDiameter: 5,
      counterboreDepth: 2,
      totalDepth: 6
    });
  });

  it('names every typed refusal reason without guessing', () => {
    expect(recognitionRefusalMessage('unsupported-surface')).toMatch(
      /surface class/i
    );
    expect(recognitionRefusalMessage('ambiguous-twins')).toMatch(
      /two or more faces/i
    );
    expect(recognitionRefusalMessage('seed-face-missing')).toMatch(
      /no longer on/i
    );
    // A box top face proves nothing and must refuse with its typed reason,
    // not with a guessed feature kind.
    const box = kernel.makeBox(10, 10, 10);
    const top = Array.from(kernel.getSolidFaces(box))[0]!;
    const refusal = recognizeImportedFeatureOnSolid(kernel, box, top);
    expect(refusal.status).toBe('unsupported');
    if (refusal.status !== 'unsupported') {
      throw new Error('Expected the box face to be refused.');
    }
    expect(recognitionRefusalMessage(refusal.reason).length).toBeGreaterThan(
      0
    );
  });

  describe('exact straight-edge loops and planar-floor seeds', () => {
    function translated(solid: number, x: number, y: number, z: number): number {
      kernel.transformSolid(
        solid,
        new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1])
      );
      return solid;
    }

    /** A 10 × 6 × 3 pocket milled into the top of a 30 × 20 × 8 plate. */
    function pocketedPlate(): number {
      const tool = translated(kernel.makeBox(10, 6, 3), 5, 5, 5);
      const result = kernel.cutDetailed(kernel.makeBox(30, 20, 8), tool);
      expect(result.status).toBe('ok');
      return result.value!;
    }

    /** A Ø6 × 4 boss fused onto the top of a 30 × 20 × 8 plate. */
    function bossedPlate(): number {
      const boss = translated(kernel.makeCylinder(3, 4), 10, 10, 8);
      const result = kernel.fuseDetailed(kernel.makeBox(30, 20, 8), boss);
      expect(result.status).toBe('ok');
      return result.value!;
    }

    /** Bodies arrive as STEP: prove the loop survives the real round trip. */
    function importedStep(solid: number): number {
      const step = remusTranslators().exportStep(
        kernel.serializeSolids(new Uint32Array([solid]))
      );
      const solids = Array.from(
        kernel.deserializeSolids(
          remusTranslators().importStep(step, step.byteLength, 2_000_000)
        )
      );
      expect(solids).toHaveLength(1);
      return solids[0]!;
    }

    function planarFaces(solid: number) {
      const query = new RemusImportedFeatureQuery(kernel, solid);
      return Array.from(kernel.getSolidFaces(solid)).flatMap((face) => {
        const candidate = query.getFace(String(face));
        return candidate?.surface.kind === 'plane'
          ? [{ face, surface: candidate.surface }]
          : [];
      });
    }

    it('publishes the exact outer loop on straight faces and nothing elsewhere', () => {
      const solid = importedStep(kernel.makeBox(10, 10, 10));
      const faces = planarFaces(solid);
      expect(faces).toHaveLength(6);
      for (const { surface } of faces) {
        expect(surface.polygon).toHaveLength(4);
      }

      // A cylindrical wall carries no polygon: only planes do.
      const bored = plateWithHole('simple');
      const query = new RemusImportedFeatureQuery(kernel, bored);
      const boredWall = Array.from(kernel.getSolidFaces(bored)).find(
        (face) => query.getFace(String(face))?.surface.kind === 'cylinder'
      );
      expect(boredWall).toBeDefined();
      const wallSurface = query.getFace(String(boredWall!))?.surface;
      expect(wallSurface?.kind).toBe('cylinder');
      expect(wallSurface).not.toHaveProperty('polygon');
    });

    it('withholds the loop from the holed opening plane above a pocket', () => {
      const solid = importedStep(pocketedPlate());
      const faces = planarFaces(solid);
      const holed = faces.filter(
        (entry) => entry.surface.polygon === undefined
      );
      // Only the plate top pierced by the pocket mouth has a second loop.
      expect(holed).toHaveLength(1);
      expect(holed[0]!.surface.area).toBeCloseTo(30 * 20 - 10 * 6, 8);
    });

    it('enumerates the pocket floor as a seed but never the holed opening', () => {
      const solid = importedStep(pocketedPlate());
      const query = new RemusImportedFeatureQuery(kernel, solid);
      const seeds = listPlanarFloorSeeds(kernel, solid, query);
      expect(seeds.length).toBeGreaterThan(0);
      const seedFaces = new Set(seeds.map(String));
      const floor = Array.from(kernel.getSolidFaces(solid)).find((face) => {
        const candidate = query.getFace(String(face));
        return (
          candidate?.surface.kind === 'plane' &&
          Math.abs(candidate.surface.area - 60) <= 1e-8 &&
          candidate.surface.polygon?.length === 4
        );
      });
      expect(floor).toBeDefined();
      expect(seedFaces.has(String(floor!))).toBe(true);
      const faces = planarFaces(solid);
      const holed = faces.find(
        (entry) => entry.surface.polygon === undefined
      );
      expect(holed).toBeDefined();
      expect(seedFaces.has(String(holed!.face))).toBe(false);
    });

    it('proves an exact prismatic pocket from the STEP pocket fixture', () => {
      const solid = importedStep(pocketedPlate());
      const faces = Array.from(kernel.getSolidFaces(solid));
      const identities = new Map(
        faces.map((face, index) => [face, { hash: index + 1 }])
      );
      const recognized = collectRecognizedImportedFeatures(
        kernel,
        solid,
        identities
      );
      expect(recognized).toHaveLength(1);
      expect(recognized[0]).toMatchObject({
        kind: 'prismatic-pocket',
        depth: 3
      });
      expect(recognized[0]).not.toHaveProperty('provenance');
      expect(recognized[0]?.participatingFaceHashes).toHaveLength(6);
    });

    it('keeps proving the exact cylindrical boss from the STEP boss fixture', () => {
      const solid = importedStep(bossedPlate());
      const faces = Array.from(kernel.getSolidFaces(solid));
      const identities = new Map(
        faces.map((face, index) => [face, { hash: index + 1 }])
      );
      const recognized = collectRecognizedImportedFeatures(
        kernel,
        solid,
        identities
      );
      expect(recognized).toHaveLength(1);
      expect(recognized[0]).toMatchObject({
        kind: 'cylindrical-boss',
        diameter: 6,
        height: 4
      });
      expect(recognized[0]).not.toHaveProperty('provenance');
    });
  });
});
