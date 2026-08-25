import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import {
  addPrimitiveFeature,
  addSketchFeature,
  addSketchObjects,
  setParameter,
  chamferEdges,
  createProjectDocument,
  directEditBody,
  extrudeSketch,
  filletEdges,
  findSketch,
  importMeshBody,
  listFeaturesInOrder,
  mirrorBody,
  addSplitFeature,
  holeBody,
  importStepBody,
  updateFeature,
  offsetSolidBody,
  patternBody,
  shellBody,
  transformBody,
  updateSketch,
  updateSketchObject
} from '@openzcad/document-core';
import {
  RemusKernelAdapter,
  brepEdgeCurve,
  createExactKernelAdapter,
  edgeCircleMisfit,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type BodyRepresentation,
  type DerivedState,
  type DirectEditOperation,
  type EdgeTopology,
  type ParamValue,
  type PrimitiveKind
} from '@openzcad/shared';
import { computeSketchRegions, profileContainsPoint } from '@openzcad/geometry';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';
import { resolveImportedBlendFace } from '../apps/web/src/lib/interaction/filletFaceEdit';

const NORMAL_PROJECTED_RADIUS_PX = 240;

/** The two message shapes `booleanFacetFallbackWarning` can produce. */
const FACET_CENSUS_MESSAGE =
  /faceted approximation instead of exact surfaces|replaced every curved surface with planar faces|produced far more faces than its operands/;

/**
 * The boolean face census either fires or it does not, and today's answer is
 * not the one to pin: the kernel facets these contacts now and may well stop,
 * and asserting the warning is present would turn that improvement into an
 * unrelated test failure here. Two things must hold either way — no warning
 * other than the census's appears, and the census agrees with the faces
 * actually on the resulting body.
 */
function expectCensusConsistentWithFaces(
  derived: DerivedState,
  body: BodyRepresentation
): void {
  const censusWarnings = derived.warnings.filter((warning) =>
    FACET_CENSUS_MESSAGE.test(warning)
  );
  expect(derived.warnings).toEqual(censusWarnings);
  const curvedFaces = (body.topology?.faces ?? []).filter(
    (face) => face.geometry && face.geometry.surfaceType !== 'plane'
  ).length;
  if (censusWarnings.length > 0) {
    // Every census message this path can produce is the lost-curvature one.
    expect(curvedFaces).toBe(0);
  } else {
    expect(curvedFaces).toBeGreaterThan(0);
  }
}
const CLOSE_PROJECTED_RADIUS_PX = 1200;
const MAX_PROJECTED_CHORD_ERROR_PX = 0.5;

function projectedChordError(
  points: number[],
  radius: number,
  projectedRadius: number
): number {
  let maximum = 0;
  for (let index = 0; index + 5 < points.length; index += 3) {
    const midpointRadius = Math.hypot(
      (points[index]! + points[index + 3]!) / 2,
      (points[index + 1]! + points[index + 4]!) / 2
    );
    maximum = Math.max(maximum, (radius - midpointRadius) / radius);
  }
  return maximum * projectedRadius;
}

function circularMeshRing(
  vertices: ArrayLike<number>,
  radius: number,
  z: number
): number[] {
  const tolerance = Math.max(radius * 1e-5, 1e-6);
  const points = new Map<string, [number, number, number]>();
  for (let index = 0; index + 2 < vertices.length; index += 3) {
    const x = vertices[index]!;
    const y = vertices[index + 1]!;
    const pointZ = vertices[index + 2]!;
    if (
      Math.abs(pointZ - z) <= tolerance &&
      Math.abs(Math.hypot(x, y) - radius) <= tolerance
    ) {
      const angle = Math.atan2(y, x);
      points.set(angle.toFixed(8), [x, y, pointZ]);
    }
  }
  const ordered = [...points.values()].sort(
    (left, right) =>
      Math.atan2(left[1], left[0]) - Math.atan2(right[1], right[0])
  );
  return [...ordered, ordered[0]!].flat();
}

// Real-kernel suite: several tests run seconds of WASM geometry and have
// tripped the 5 s default one at a time on slow CI runners (three different
// victims across three runs). Give every test here the same generous budget;
// individual tests may still raise it further.
describe('exact kernel adapter', { timeout: 30_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  it('derives exact B-rep measurements and topology', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Exact box', toUserId('user_exact')),
      {
        name: 'Exact box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );

    const derived = await adapter.syncDocument(document);
    const body = Object.values(derived.bodyRepresentations)[0];

    expect(body?.volume).toBeCloseTo(6000, 6);
    expect(body?.faceCount).toBe(6);
    expect(body?.mesh.indices.length).toBeGreaterThan(0);
    expect(body?.topology?.faces).toHaveLength(6);
    expect(body?.topology?.edges).toHaveLength(12);
    expect(body?.topology?.edges.every((edge) => edge.points.length >= 6)).toBe(
      true
    );
    const edgeLengths = [...(body?.topology?.edges ?? [])]
      .map((edge) => edge.length)
      .sort((left, right) => (left ?? 0) - (right ?? 0));
    expect(edgeLengths).toHaveLength(12);
    [10, 10, 10, 10, 20, 20, 20, 20, 30, 30, 30, 30].forEach(
      (expected, index) => {
        expect(edgeLengths[index]).toBeCloseTo(expected, 8);
      }
    );
    // Face hashes are geometric fingerprints: unique per face, positive, and
    // stable across identical rebuilds (they are NOT ordinals).
    const faceHashes = body?.topology?.faces.map((face) => face.hash) ?? [];
    expect(new Set(faceHashes).size).toBe(6);
    expect(faceHashes.every((hash) => Number.isInteger(hash) && hash > 0)).toBe(
      true
    );
    expect(faceHashes).not.toEqual([1, 2, 3, 4, 5, 6]);
    const resynced = await adapter.syncDocument(document);
    const resyncedBody = Object.values(resynced.bodyRepresentations)[0];
    expect(resyncedBody?.topology?.faces.map((face) => face.hash)).toEqual(
      faceHashes
    );
    // Every face carries measured geometry for drag affordances.
    expect(
      body?.topology?.faces.every(
        (face) =>
          face.geometry &&
          face.geometry.surfaceType === 'plane' &&
          face.geometry.area > 0 &&
          face.geometry.normal !== undefined
      )
    ).toBe(true);
    const edgeHashes = body?.topology?.edges.map((edge) => edge.hash) ?? [];
    expect(new Set(edgeHashes).size).toBe(12);
    expect(edgeHashes.every((hash) => Number.isInteger(hash) && hash > 0)).toBe(
      true
    );
    expect(edgeHashes).not.toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(
      body?.topology?.faces.map((face) => face.reference?.lineageName).sort()
    ).toEqual([
      'primitive.box.face.x-max',
      'primitive.box.face.x-min',
      'primitive.box.face.y-max',
      'primitive.box.face.y-min',
      'primitive.box.face.z-max',
      'primitive.box.face.z-min'
    ]);
    expect(body?.topology?.edges.every((edge) => edge.reference)).toBe(true);
    expect(body?.topology?.lineageDiagnostics).toBeUndefined();
    expect(derived.warnings).toEqual([]);
  });

  it('preserves Remus semantic lineage through an exact rigid transform', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Lineage box', toUserId('user_lineage_transform')),
      {
        name: 'Lineage box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const bodyId = base.bodyOrder[0]!;
    const before = await adapter.syncDocument(base);
    const beforeTopology = before.bodyRepresentations[bodyId]!.topology!;
    const transformedDocument = transformBody(base, {
      name: 'Place lineage box',
      targetBodyId: bodyId,
      translation: { x: 40, y: -15, z: 7 },
      rotationDeg: { x: 0, y: 0, z: 90 }
    }).document;

    const transformed = await adapter.syncDocument(transformedDocument);
    const afterTopology = transformed.bodyRepresentations[bodyId]!.topology!;
    const referenceNames = (topology: typeof beforeTopology) =>
      [...topology.faces, ...topology.edges]
        .map((entry) => entry.reference?.lineageName)
        .sort();

    expect(referenceNames(afterTopology)).toEqual(
      referenceNames(beforeTopology)
    );
    expect(
      [...afterTopology.faces, ...afterTopology.edges].every(
        (entry) => entry.reference
      )
    ).toBe(true);
    expect(
      afterTopology.lineageDiagnostics?.filter(({ status }) =>
        ['deleted', 'split', 'merged'].includes(status)
      ) ?? []
    ).toEqual([]);
    expect(new Set(afterTopology.faces.map((face) => face.hash))).not.toEqual(
      new Set(beforeTopology.faces.map((face) => face.hash))
    );
    expect(transformed.warnings).toEqual([]);
  });

  it('names every face and edge of a box from its semantic lineage', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Parity box', toUserId('user_lineage_parity')),
      {
        name: 'Parity box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const bodyId = document.bodyOrder[0]!;
    const remus = new RemusKernelAdapter();
    try {
      const derived = await remus.syncDocument(document);
      const topology = derived.bodyRepresentations[bodyId]!.topology!;
      const names = [...topology.faces, ...topology.edges]
        .map((entry) => entry.reference?.lineageName)
        .filter((name): name is string => name !== undefined)
        .sort();

      // Six faces and twelve edges, every one of them named.
      expect(names).toHaveLength(18);
    } finally {
      remus.dispose();
    }
  });

  it('rebuilds face-attached sketches from evolved exact lineage', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Attached sketch', toUserId('user_attachment')),
      {
        name: 'Attachment box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const sourceBodyId = base.bodyOrder[0]!;
    const sourceDerived = await adapter.syncDocument(base);
    const sourceFace = sourceDerived.bodyRepresentations[
      sourceBodyId
    ]!.topology!.faces.find(
      (face) => face.reference?.lineageName === 'primitive.box.face.z-max'
    )!;
    expect(sourceFace.reference?.kind).toBe('face');
    expect(sourceFace.geometry?.normal).toBeDefined();

    const geometry = sourceFace.geometry!;
    const { document: withSketch, sketchId } = addSketchFeature(
      { ...base, derived: sourceDerived },
      {
        name: 'Top attachment',
        planeRef: {
          type: 'face',
          bodyId: sourceBodyId,
          faceHash: sourceFace.hash,
          faceReference:
            sourceFace.reference?.kind === 'face'
              ? sourceFace.reference
              : undefined,
          sourceArea: geometry.area,
          sourceCenter: geometry.center,
          sourceNormal: geometry.normal!,
          frame: {
            origin: geometry.center,
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            zAxis: geometry.normal!
          }
        },
        objects: [
          {
            objectKind: 'rectangle',
            width: 4,
            height: 6,
            centerX: 0,
            centerY: 0
          }
        ]
      }
    );
    const { document: attached, bodyId: extrusionBodyId } = extrudeSketch(
      withSketch,
      { name: 'Attached extrusion', sketchId, distance: 5 }
    );
    const primitive = listFeaturesInOrder(attached).find(
      (feature) => feature.data.featureKind === 'primitive'
    )!;
    const manager = new CommandManager(attached);
    const evolved = manager.execute(
      commandFactories.updateFeature(
        {
          featureId: primitive.featureId,
          data: { dimensions: { width: 24, height: 20, depth: 42 } }
        },
        'Resize attachment source'
      )
    );
    const remus = new RemusKernelAdapter();
    try {
      const derived = await remus.syncDocument(evolved);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[extrusionBodyId]).toBeDefined();
      expect(
        derived.bodyRepresentations[extrusionBodyId]!.bbox.min.z
      ).toBeCloseTo(42, 5);

      manager.execute(
        commandFactories.setNodeMetadata(
          {
            nodeId: primitive.id,
            metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
          },
          'Suppress attachment source'
        )
      );
      const stale = await remus.syncDocument(manager.document);
      expect(stale.bodyRepresentations[extrusionBodyId]).toBeUndefined();
      expect(stale.warnings).toContain(
        'Feature "Attachment box": Suppressed; skipped during exact rebuild.'
      );
      expect(stale.warnings).toContain(
        `Feature "Top attachment": Sketch "Top attachment" cannot attach because source body ${sourceBodyId} is unavailable at the sketch's history position.`
      );
    } finally {
      remus.dispose();
    }
  });

  it('converts a legacy face attachment to the same fixed geometry without a warning', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument(
        'Legacy attachment conversion',
        toUserId('user_legacy_attachment_conversion')
      ),
      {
        name: 'Legacy attachment box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const sourceBodyId = base.bodyOrder[0]!;
    const sourceDerived = await adapter.syncDocument(base);
    const sourceFace = sourceDerived.bodyRepresentations[
      sourceBodyId
    ]!.topology!.faces.find(
      (face) => face.reference?.lineageName === 'primitive.box.face.z-max'
    )!;
    const geometry = sourceFace.geometry!;
    const frame = {
      origin: { ...geometry.center },
      xAxis: { x: 0, y: -1, z: 0 },
      yAxis: { x: 1, y: 0, z: 0 },
      zAxis: { ...geometry.normal! }
    };
    const { document: withSketch, sketchId } = addSketchFeature(
      { ...base, derived: sourceDerived },
      {
        name: 'Legacy face sketch',
        planeRef: {
          type: 'face',
          bodyId: sourceBodyId,
          faceHash: sourceFace.hash,
          sourceArea: geometry.area,
          sourceCenter: geometry.center,
          sourceNormal: geometry.normal!,
          frame
        },
        objects: [
          {
            objectKind: 'rectangle',
            width: 4,
            height: 6,
            centerX: 0,
            centerY: 0
          }
        ]
      }
    );
    const { document: legacyDocument, bodyId: extrusionBodyId } = extrudeSketch(
      withSketch,
      {
        name: 'Legacy extrusion',
        sketchId,
        distance: 5
      }
    );

    const legacy = await adapter.syncDocument(legacyDocument);
    expect(legacy.warnings).toContain(
      'Sketch "Legacy face sketch": legacy face attachment has no schema-v5 lineage reference; using its stored migration frame.'
    );

    const fixedDocument = updateSketch(legacyDocument, {
      sketchId,
      planeRef: { type: 'frame', frame }
    });
    const fixed = await adapter.syncDocument(fixedDocument);
    expect(fixed.warnings).toEqual([]);
    expect(fixed.bodyRepresentations[extrusionBodyId]).toEqual(
      legacy.bodyRepresentations[extrusionBodyId]
    );
  });

  it('publishes an imported-mesh body as a hash-only, unreferenced solid', async () => {
    // A 12-triangle block, the shape a real STL export of a part has.
    const corners: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 20, 0],
      [0, 20, 0],
      [0, 0, 30],
      [10, 0, 30],
      [10, 20, 30],
      [0, 20, 30]
    ];
    const vertices: number[] = [];
    const indices: number[] = [];
    for (const quad of [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [3, 7, 6, 2],
      [0, 4, 7, 3],
      [1, 2, 6, 5]
    ]) {
      const base = vertices.length / 3;
      for (const corner of quad) {
        vertices.push(...corners[corner]!);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const { document, bodyId } = importMeshBody(
      createProjectDocument('Mesh parity', toUserId('user_mesh_parity')),
      {
        name: 'Imported block',
        artifactId: 'artifact_parity_block',
        sourceName: 'block.stl',
        triangleCount: indices.length / 3,
        vertices,
        indices
      }
    );

    const remus = new RemusKernelAdapter();
    try {
      const derived = await remus.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      expect(derived.exportableBodyIds).toEqual([bodyId]);
      const body = derived.bodyRepresentations[bodyId]!;
      expect(body.source).toBe('imported-mesh');
      expect(body.name).toBe('Imported block');
      expect(body.consumed).toBe(false);
      expect(body.exportableStep).toBe(true);
      expect(body.volume).toBeCloseTo(6000, 6);
      // A mesh import carries no feature contract to name its topology from,
      // so the adapter publishes one body-level hash-only diagnostic and no
      // verified face or edge references at all.
      expect(
        body.topology!.lineageDiagnostics?.map((diagnostic) => [
          diagnostic.kind,
          diagnostic.status
        ])
      ).toEqual([['body', 'hash-only']]);
      expect(
        [...body.topology!.faces, ...body.topology!.edges].filter(
          (entry) => entry.reference !== undefined
        )
      ).toHaveLength(0);
    } finally {
      remus.dispose();
    }
  });

  it('keeps cylinder surfaces and exact edge outlines smooth across scale and zoom', async () => {
    for (const radius of [0.5, 10, 1000]) {
      const document = addPrimitiveFeature(
        createProjectDocument(
          `Cylinder ${radius * 2}`,
          toUserId(`user_cylinder_${radius}`)
        ),
        {
          name: `Cylinder ${radius * 2}`,
          primitiveKind: 'cylinder',
          dimensions: { radius, height: radius * 2 }
        }
      );

      const derived = await adapter.syncDocument(document);
      const bodyId = document.bodyOrder[0]!;
      const body = derived.bodyRepresentations[bodyId]!;
      const cylindricalFace = body.topology?.faces.find(
        (face) => face.geometry?.surfaceType === 'cylinder'
      );
      const circularEdges =
        body.topology?.edges.filter((edge) => edge.points.length > 6) ?? [];
      const displaySeams =
        body.topology?.edges.filter((edge) => edge.displayRole === 'seam') ??
        [];

      // The authored/exported solid remains analytic; only its disposable
      // viewport representation is tessellated.
      expect(cylindricalFace?.geometry?.radius).toBeCloseTo(radius, 7);
      expect(circularEdges).toHaveLength(2);
      expect(displaySeams).toHaveLength(1);
      expect(
        circularEdges.every((edge) => edge.displayRole === 'feature')
      ).toBe(true);

      // Shared display tolerances give the shaded rim and exact edge overlay
      // compatible resolution at every model scale. Full circles repeat their
      // first point so Line2 also draws the closing segment.
      const surfaceRing = circularMeshRing(
        body.mesh.vertices,
        radius,
        radius * 2
      );
      expect(surfaceRing.length / 3 - 1).toBeGreaterThanOrEqual(100);
      expect(surfaceRing.length / 3 - 1).toBeLessThan(160);
      expect(body.mesh.indices.length / 3).toBeLessThan(600);

      for (const edge of circularEdges) {
        expect(
          Math.hypot(
            edge.points.at(-3)! - edge.points[0]!,
            edge.points.at(-2)! - edge.points[1]!,
            edge.points.at(-1)! - edge.points[2]!
          )
        ).toBeLessThan(Math.max(radius * 1e-12, 1e-12));
        expect(edge.points.length / 3 - 1).toBeGreaterThanOrEqual(100);
        expect(edge.points.length / 3 - 1).toBeLessThan(160);
        for (const projectedRadius of [
          NORMAL_PROJECTED_RADIUS_PX,
          CLOSE_PROJECTED_RADIUS_PX
        ]) {
          expect(
            projectedChordError(edge.points, radius, projectedRadius)
          ).toBeLessThanOrEqual(MAX_PROJECTED_CHORD_ERROR_PX);
        }
      }

      for (const projectedRadius of [
        NORMAL_PROJECTED_RADIUS_PX,
        CLOSE_PROJECTED_RADIUS_PX
      ]) {
        expect(
          projectedChordError(surfaceRing, radius, projectedRadius)
        ).toBeLessThanOrEqual(MAX_PROJECTED_CHORD_ERROR_PX);
      }

      const step = await adapter.exportStep(document, [bodyId]);
      expect(step).toContain('CYLINDRICAL_SURFACE');
    }
  });

  it('marks smooth periodic seams without removing exact topology', async () => {
    let document = createProjectDocument(
      'Periodic seams',
      toUserId('user_periodic_seams')
    );
    const expected: Array<{
      name: string;
      primitiveKind: PrimitiveKind;
      dimensions: Record<string, ParamValue>;
      seamCount: number | 'all';
      featureCount: number;
    }> = [
      {
        name: 'Cone',
        primitiveKind: 'cone',
        dimensions: { bottomRadius: 10, topRadius: 5, height: 20 },
        seamCount: 1,
        featureCount: 2
      },
      {
        name: 'Sphere',
        primitiveKind: 'sphere',
        dimensions: { radius: 10 },
        seamCount: 'all',
        featureCount: 0
      },
      {
        name: 'Torus',
        primitiveKind: 'torus',
        dimensions: { majorRadius: 20, minorRadius: 5 },
        seamCount: 'all',
        featureCount: 0
      }
    ];
    const bodyIds: (typeof document.bodyOrder)[number][] = [];
    for (const primitive of expected) {
      document = addPrimitiveFeature(document, primitive);
      bodyIds.push(document.bodyOrder.at(-1)!);
    }

    const derived = await adapter.syncDocument(document);
    for (let index = 0; index < expected.length; index += 1) {
      const body = derived.bodyRepresentations[bodyIds[index]!];
      const edges = body?.topology?.edges ?? [];
      const seamCount = edges.filter(
        (edge) => edge.displayRole === 'seam'
      ).length;
      const featureCount = edges.filter(
        (edge) => edge.displayRole === 'feature'
      ).length;
      expect(seamCount).toBe(
        expected[index]!.seamCount === 'all'
          ? edges.length
          : expected[index]!.seamCount
      );
      expect(featureCount).toBe(expected[index]!.featureCount);
    }
    expect(derived.warnings).toEqual([]);

    const cylinder = addPrimitiveFeature(
      createProjectDocument('STEP cylinder', toUserId('user_step_seam')),
      {
        name: 'STEP cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 10, height: 20 }
      }
    );
    const step = await adapter.exportStep(cylinder, [cylinder.bodyOrder[0]!]);
    const imported = createProjectDocument(
      'Imported STEP cylinder',
      toUserId('user_step_seam')
    );
    const manager = new CommandManager(imported);
    manager.execute(
      commandFactories.importStep({
        name: 'Imported STEP cylinder',
        artifactId: 'artifact_periodic_seam',
        sourceName: 'cylinder.step',
        stepText: step
      })
    );
    const importedDerived = await adapter.syncDocument(manager.document);
    const importedEdges =
      Object.values(importedDerived.bodyRepresentations)[0]?.topology?.edges ??
      [];
    expect(
      importedEdges.filter((edge) => edge.displayRole === 'seam')
    ).toHaveLength(1);
    expect(
      importedEdges.filter((edge) => edge.displayRole === 'feature')
    ).toHaveLength(2);
    expect(importedDerived.warnings).toEqual([]);
  });

  it('publishes the faces each edge bounds, agreeing with displayRole', async () => {
    let document = createProjectDocument(
      'Edge adjacency',
      toUserId('user_adjacency')
    );
    const ids = new Map<string, (typeof document.bodyOrder)[number]>();
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 10 }
    });
    ids.set('Box', document.bodyOrder.at(-1)!);
    document = addPrimitiveFeature(document, {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 10, height: 20 }
    });
    ids.set('Cylinder', document.bodyOrder.at(-1)!);
    document = addPrimitiveFeature(document, {
      name: 'Sphere',
      primitiveKind: 'sphere',
      dimensions: { radius: 10 }
    });
    ids.set('Sphere', document.bodyOrder.at(-1)!);
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const edgesOf = (name: string) =>
      derived.bodyRepresentations[ids.get(name)!]!.topology!.edges;
    const faceHashesOf = (name: string) =>
      new Set(
        derived.bodyRepresentations[ids.get(name)!]!.topology!.faces.map(
          (face) => face.hash
        )
      );
    // Fails rather than silently building an empty Set, which would make every
    // `.size` assertion below read 0 and pass nothing.
    const adjacencyOf = (edge: { adjacentFaceHashes?: number[] }): number[] => {
      expect(edge.adjacentFaceHashes).toBeDefined();
      return edge.adjacentFaceHashes as number[];
    };

    for (const name of ids.keys()) {
      const published = faceHashesOf(name);
      for (const edge of edgesOf(name)) {
        // Present on every edge, sorted, and naming only faces this body
        // actually published — an unsorted array would pass the corpus digests
        // (which sort first) while making rebuild output non-reproducible.
        const hashes = adjacencyOf(edge);
        expect(hashes.length).toBeGreaterThan(0);
        expect([...hashes].sort((a, b) => a - b)).toEqual(hashes);
        for (const hash of hashes) {
          expect(published.has(hash)).toBe(true);
        }
      }
    }

    // A box is the clean case: every edge divides two distinct faces, and
    // nothing is a seam.
    const boxEdges = edgesOf('Box');
    expect(boxEdges).toHaveLength(12);
    for (const edge of boxEdges) {
      expect(edge.displayRole).toBe('feature');
      expect(new Set(adjacencyOf(edge)).size).toBe(2);
    }

    // The cylinder's seam closes one face's UV parameterization, so that face
    // is listed twice. This is the fact `displayRole` already derives, and the
    // two must not be able to disagree.
    const cylinderSeams = edgesOf('Cylinder').filter(
      (edge) => edge.displayRole === 'seam'
    );
    expect(cylinderSeams).toHaveLength(1);
    expect(new Set(adjacencyOf(cylinderSeams[0]!)).size).toBe(1);
    expect(adjacencyOf(cylinderSeams[0]!)).toHaveLength(2);
    for (const edge of edgesOf('Cylinder').filter(
      (edge) => edge.displayRole === 'feature'
    )) {
      expect(new Set(adjacencyOf(edge)).size).toBe(2);
    }

    // The sphere pins the limit rather than hiding it. Remus builds it from
    // two same-surface hemispheres that share one exact witness, so BOTH
    // patches hash identically and every edge reports a single distinct hash —
    // even the equator, which genuinely divides two faces. A consumer cannot
    // use these hashes to tell the hemispheres apart. That collision is why
    // face picks on spheres are unavailable, and if it ever stops being true
    // this assertion should turn red and be revisited deliberately.
    expect(faceHashesOf('Sphere').size).toBe(1);
    for (const edge of edgesOf('Sphere')) {
      expect(new Set(adjacencyOf(edge)).size).toBe(1);
    }
  });

  it('publishes the two vertices each edge runs between', async () => {
    let document = createProjectDocument(
      'Edge vertices',
      toUserId('user_vertex_ids')
    );
    const ids = new Map<string, (typeof document.bodyOrder)[number]>();
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 10 }
    });
    ids.set('Box', document.bodyOrder.at(-1)!);
    document = addPrimitiveFeature(document, {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 10, height: 20 }
    });
    ids.set('Cylinder', document.bodyOrder.at(-1)!);
    // Two solids in one body, spaced exactly their own extent, so they touch
    // face to face. Coincident geometry, distinct topology.
    document = addPrimitiveFeature(document, {
      name: 'Pair',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const pairId = document.bodyOrder.at(-1)!;
    const patterned = patternBody(document, {
      name: 'Touching pair',
      targetBodyId: pairId,
      patternKind: 'linear',
      count: 2,
      axis: 'x',
      spacing: 10
    });
    document = patterned.document;
    ids.set('Pair', patterned.bodyId);

    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const edgesOf = (name: string) =>
      derived.bodyRepresentations[ids.get(name)!]!.topology!.edges;
    // Fails rather than defaulting, which would make every count below read
    // from an empty pair and assert nothing.
    const verticesOf = (edge: { vertexIds?: [number, number] }) => {
      expect(edge.vertexIds).toBeDefined();
      return edge.vertexIds as [number, number];
    };

    // A box: twelve edges over eight vertices, each edge joining two distinct
    // ones, each vertex used by exactly three edges.
    const boxEdges = edgesOf('Box');
    expect(boxEdges).toHaveLength(12);
    const boxUse = new Map<number, number>();
    for (const edge of boxEdges) {
      const [start, end] = verticesOf(edge);
      expect(start).not.toBe(end);
      boxUse.set(start, (boxUse.get(start) ?? 0) + 1);
      boxUse.set(end, (boxUse.get(end) ?? 0) + 1);
    }
    expect(boxUse.size).toBe(8);
    expect([...boxUse.values()]).toEqual(Array(8).fill(3));

    // The fact that makes this worth publishing next to adjacentFaceHashes:
    // some pair of box edges shares a face and shares NO vertex, so adjacency
    // alone would have joined two opposite sides of the top face into one run.
    const shareFaceNotVertex = boxEdges.some((edge) =>
      boxEdges.some(
        (other) =>
          other !== edge &&
          !verticesOf(other).some((id) => verticesOf(edge).includes(id)) &&
          (edge.adjacentFaceHashes ?? []).some((hash) =>
            (other.adjacentFaceHashes ?? []).includes(hash)
          )
      )
    );
    expect(shareFaceNotVertex).toBe(true);

    // A closed edge names one vertex twice rather than publishing a single
    // entry. The cylinder's two rims are the case; its seam is a normal open
    // edge running between them.
    const cylinderEdges = edgesOf('Cylinder');
    const closedRims = cylinderEdges.filter(
      (edge) => new Set(verticesOf(edge)).size === 1
    );
    expect(closedRims).toHaveLength(2);
    for (const rim of closedRims) {
      expect(verticesOf(rim)).toHaveLength(2);
    }
    expect(
      cylinderEdges.filter((edge) => new Set(verticesOf(edge)).size === 2)
    ).toHaveLength(1);
    // The seam joins the two rims, so between them the three edges use exactly
    // the two vertices the body has.
    expect(new Set(cylinderEdges.flatMap(verticesOf)).size).toBe(2);

    // Two solids touching exactly still share no vertex id. The ids are
    // numbered body-wide but the handle map is per solid, so a run cannot walk
    // from one solid to the other along coincident geometry.
    const pairEdges = edgesOf('Pair');
    expect(pairEdges).toHaveLength(24);
    expect(new Set(pairEdges.flatMap(verticesOf)).size).toBe(16);
    const pairUse = new Map<number, number>();
    for (const edge of pairEdges) {
      for (const id of verticesOf(edge)) {
        pairUse.set(id, (pairUse.get(id) ?? 0) + 1);
      }
    }
    expect([...pairUse.values()]).toEqual(Array(16).fill(3));
  });

  it('publishes the exact circle each arc lies on, and a bare type otherwise', async () => {
    let document = createProjectDocument(
      'Edge curves',
      toUserId('user_edge_curve')
    );
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 10 }
    });
    const boxId = document.bodyOrder.at(-1)!;
    document = addPrimitiveFeature(document, {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 10, height: 20 }
    });
    const cylinderId = document.bodyOrder.at(-1)!;
    const base = await adapter.syncDocument(document);
    expect(base.warnings).toEqual([]);
    const boxEdges = base.bodyRepresentations[boxId]!.topology!.edges;
    const filleted = filletEdges(document, {
      name: 'Filleted box',
      targetBodyId: boxId,
      edgeHashes: boxEdges.map((edge) => edge.hash),
      size: 3
    });
    const derived = await adapter.syncDocument(filleted.document);
    expect(derived.warnings).toEqual([]);
    const curveOf = (edge: EdgeTopology) => {
      expect(edge.curve).toBeDefined();
      return edge.curve!;
    };

    // A box is straight everywhere: every edge names its type and carries no
    // analytic payload, because there is no circle to publish.
    expect(boxEdges).toHaveLength(12);
    for (const edge of boxEdges) {
      expect(curveOf(edge).type).toBe('LINE');
      expect(curveOf(edge).circle).toBeUndefined();
      // The record is a type plus, for circles, a circle — nothing else. This
      // pins what the shape deliberately omits: the kernel's parameter range
      // describes the UNDERLYING curve rather than the edge's trim of it, so a
      // quarter fillet arc reports a full turn. A range here would be a wrong
      // answer published in a field that looks authoritative.
      expect(Object.keys(curveOf(edge))).toEqual(['type']);
    }

    // The cylinder's two rims are exact circles at the ends of its axis, and
    // its seam is a straight line up the wall.
    const cylinderEdges = base.bodyRepresentations[cylinderId]!.topology!.edges;
    const rims = cylinderEdges.filter((edge) => curveOf(edge).circle);
    expect(rims).toHaveLength(2);
    for (const rim of rims) {
      const circle = curveOf(rim).circle!;
      expect(circle.radius).toBeCloseTo(10, 9);
      expect(circle.center.x).toBeCloseTo(0, 9);
      expect(circle.center.y).toBeCloseTo(0, 9);
      expect(Math.abs(circle.axis.z)).toBeCloseTo(1, 9);
    }
    expect(
      rims.map((rim) => curveOf(rim).circle!.center.z).sort((a, b) => a - b)
    ).toEqual([0, 20]);
    for (const seam of cylinderEdges.filter(
      (edge) => edge.displayRole === 'seam'
    )) {
      expect(curveOf(seam).type).toBe('LINE');
      expect(curveOf(seam).circle).toBeUndefined();
    }

    // Rounding all twelve edges of the box at radius 3 leaves a quarter arc at
    // each of the 8 corners about each of the 3 axes: 24 arcs of radius 3,
    // each centred where that corner's three offset fillet axes meet. Those
    // centres are the corner points pulled 3 inboard, so they are enumerable
    // in closed form rather than recorded from a run.
    const filletedEdges =
      derived.bodyRepresentations[filleted.bodyId]!.topology!.edges;
    const arcs = filletedEdges.filter(
      (edge) => curveOf(edge).type === 'CIRCLE'
    );
    expect(filletedEdges).toHaveLength(48);
    expect(arcs).toHaveLength(24);
    const round = (value: number) => Number(value.toFixed(6));
    const placements = new Set<string>();
    for (const arc of arcs) {
      const circle = curveOf(arc).circle;
      expect(circle).toBeDefined();
      expect(circle!.radius).toBeCloseTo(3, 9);
      expect([3, 17]).toContain(round(circle!.center.x));
      expect([3, 17]).toContain(round(circle!.center.y));
      expect([3, 7]).toContain(round(circle!.center.z));
      // The axis is the arc plane's normal, canonically signed — one of the
      // three positive basis directions here and never their negatives,
      // because the Frenet sign the kernel hands back follows its
      // parameterization phase and is not stable across rebuilds.
      const axis = [circle!.axis.x, circle!.axis.y, circle!.axis.z].map(round);
      expect([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
      ]).toContainEqual(axis);
      placements.add(
        `${round(circle!.center.x)},${round(circle!.center.y)},${round(circle!.center.z)}|${axis.join(',')}`
      );
      // Re-derived from the edge's own sampled points rather than from the
      // kernel call that produced the circle: every sample sits at the
      // published radius from the published centre, in the published plane.
      for (let offset = 0; offset + 2 < arc.points.length; offset += 3) {
        const toPoint = {
          x: arc.points[offset]! - circle!.center.x,
          y: arc.points[offset + 1]! - circle!.center.y,
          z: arc.points[offset + 2]! - circle!.center.z
        };
        const axial =
          toPoint.x * circle!.axis.x +
          toPoint.y * circle!.axis.y +
          toPoint.z * circle!.axis.z;
        expect(axial).toBeCloseTo(0, 9);
        expect(Math.hypot(toPoint.x, toPoint.y, toPoint.z)).toBeCloseTo(3, 9);
      }
    }
    // 8 corners x 3 axes, all distinct. A collapsed or duplicated centre would
    // otherwise pass every per-arc assertion above.
    expect(placements.size).toBe(24);
    for (const straight of filletedEdges.filter(
      (edge) => curveOf(edge).type === 'LINE'
    )) {
      expect(curveOf(straight).circle).toBeUndefined();
    }
  });

  it('publishes no analytic circle for a curve the kernel measures wrongly', () => {
    // Nothing the document model can build is an ellipse, and the parity
    // corpus holds no elliptical or spline edge either, so the gate that keeps
    // garbage out of the payload has no fixture that reaches it. Build one on
    // a bare kernel instead, rather than leave the branch untested.
    const kernel = new RemusKernel();
    try {
      // Semi-major 3, semi-minor 1.5 in the z = 0 plane.
      const ellipse = kernel.makeEllipseEdge(0, 0, 0, 0, 0, 1, 3, 1.5);
      const ellipsePoints = Array.from(kernel.tessellateEdge(ellipse, 1e-3));
      const published = brepEdgeCurve(kernel, ellipse, ellipsePoints);
      // The type is still worth publishing. The analytic payload is not.
      expect(published?.type).toBe('ELLIPSE');
      expect(published?.circle).toBeUndefined();

      // Why it must not be: the kernel's edge curvature reading is silently
      // wrong for ellipses by about twelve orders of magnitude. At the
      // major-axis end the true curvature radius is b^2/a = 0.75. Pinned so a
      // kernel bump that fixes it turns this red and gets the gate revisited,
      // rather than leaving a branch guarding nothing.
      const measured = Array.from(kernel.measureCurvatureAtEdge(ellipse, 0));
      const impliedRadius = 1 / measured[0]!;
      expect(impliedRadius).toBeGreaterThan(1e11);

      // The second line of defence, independent of the type gate: score the
      // circle that reading implies against the ellipse's own polyline. Note
      // the misfit is measured against the EDGE's extent, not the candidate
      // radius — scaled by its own 7.5e11 radius this miss would read as about
      // 1e-12 and sail through a relative test.
      const anchor = Array.from(kernel.evaluateEdgeCurve(ellipse, 0));
      const implied = {
        center: {
          x: anchor[0]! + measured[4]! * impliedRadius,
          y: anchor[1]! + measured[5]! * impliedRadius,
          z: anchor[2]! + measured[6]! * impliedRadius
        },
        axis: { x: 0, y: 0, z: 1 },
        radius: impliedRadius
      };
      expect(edgeCircleMisfit(implied, ellipsePoints)).toBeGreaterThan(0.1);

      // Controls, so that rejection is not just a function that always
      // rejects: an honest circle scores at rounding level, the same circle
      // with a micron of error in its radius or centre does not, and a
      // candidate with nothing to check against fails closed rather than
      // passing vacuously.
      const circle = kernel.makeCircleEdge(1, 2, 3, 0, 1, 0, 7);
      const circlePoints = Array.from(kernel.tessellateEdge(circle, 1e-3));
      const truth = {
        center: { x: 1, y: 2, z: 3 },
        axis: { x: 0, y: 1, z: 0 },
        radius: 7
      };
      expect(edgeCircleMisfit(truth, circlePoints)).toBeLessThan(1e-9);
      expect(
        edgeCircleMisfit({ ...truth, radius: 7.001 }, circlePoints)
      ).toBeGreaterThan(1e-6);
      expect(
        edgeCircleMisfit(
          { ...truth, center: { x: 1, y: 2, z: 3.001 } },
          circlePoints
        )
      ).toBeGreaterThan(1e-6);
      expect(edgeCircleMisfit(truth, [])).toBe(Number.POSITIVE_INFINITY);

      // And the published circle for that edge agrees with a truth it was
      // never told.
      const publishedCircle = brepEdgeCurve(kernel, circle, circlePoints);
      expect(publishedCircle?.type).toBe('CIRCLE');
      expect(publishedCircle?.circle?.radius).toBeCloseTo(7, 9);
      expect(publishedCircle?.circle?.center.x).toBeCloseTo(1, 9);
      expect(publishedCircle?.circle?.center.y).toBeCloseTo(2, 9);
      expect(publishedCircle?.circle?.center.z).toBeCloseTo(3, 9);
      expect(Math.abs(publishedCircle!.circle!.axis.y)).toBeCloseTo(1, 9);
    } finally {
      kernel.free();
    }
  });

  it('survives a torus, whose only edges are zero length, and a dead handle', async () => {
    // Remus's torus closes in both directions, so its two edges are
    // degenerate: LINE type, a domain of [0, 0], start vertex equal to end
    // vertex. The trim-aware NURBS curve reader throws on exactly these, which
    // is why the record is not built from it — one unguarded call would take
    // measurement down for every torus in a document rather than for one edge.
    const document = addPrimitiveFeature(
      createProjectDocument('Torus', toUserId('user_edge_curve_torus')),
      {
        name: 'Torus',
        primitiveKind: 'torus',
        dimensions: { majorRadius: 20, minorRadius: 5 }
      }
    );
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const edges =
      derived.bodyRepresentations[document.bodyOrder.at(-1)!]!.topology!.edges;
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.curve?.type).toBe('LINE');
      expect(edge.curve?.circle).toBeUndefined();
    }

    // An edge the kernel will not describe leaves the record absent — not
    // wrong, and not fatal. Same discipline the analytic surface reader
    // already applies to a face it cannot read.
    const kernel = new RemusKernel();
    try {
      expect(() => kernel.getEdgeCurveType(999_999)).toThrow();
      expect(brepEdgeCurve(kernel, 999_999, [])).toBeUndefined();
    } finally {
      kernel.free();
    }
  });

  it('removes boolean seams from a unioned physical part', async () => {
    const withBase = addPrimitiveFeature(
      createProjectDocument('Uniform bracket', toUserId('user_exact')),
      {
        name: 'Base plate',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 30, depth: 6 }
      }
    );
    const withWall = addPrimitiveFeature(withBase, {
      name: 'Wall plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 6, depth: 24 }
    });
    const wallId = withWall.bodyOrder.at(-1)!;
    const positioned = transformBody(withWall, {
      name: 'Seat wall on base',
      targetBodyId: wallId,
      translation: { x: 0, y: 24, z: 5.5 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Uniform bracket',
        operation: 'union',
        targetBodyIds: [positioned.bodyOrder[0]!, wallId]
      })
    );

    const derived = await adapter.syncDocument(document);
    const resultId = document.bodyOrder.at(-1)!;
    const body = derived.bodyRepresentations[resultId];

    expect(derived.warnings).toEqual([]);
    expect(
      Object.values(derived.bodyRepresentations).filter(
        (candidate) => !candidate.consumed
      )
    ).toHaveLength(1);
    expect(body?.volume).toBeCloseTo(40 * 30 * 6 + 40 * 6 * 23.5, 4);
    // An L prism has six rectangular side faces plus its L-shaped front/back.
    // Coplanar boolean fragments inflate this to fourteen faces and render
    // false seams in the shaded-with-edges viewport.
    expect(body?.faceCount).toBe(8);
    expect(body?.topology?.lineageDiagnostics).toContainEqual(
      expect.objectContaining({ kind: 'body', status: 'hash-only' })
    );
    expect(
      [
        ...(body?.topology?.faces ?? []),
        ...(body?.topology?.edges ?? [])
      ].every((entry) => entry.reference === undefined)
    ).toBe(true);

    const step = await adapter.exportStep(document, [resultId]);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('labels a shallow circular union when Remus returns a mesh fallback', async () => {
    const withCylinder = addPrimitiveFeature(
      createProjectDocument('Shallow circular union', toUserId('user_exact')),
      {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 20, height: 40 }
      }
    );
    const cylinderId = withCylinder.bodyOrder.at(-1)!;
    const { document: withSketch, sketchId } = addSketchFeature(withCylinder, {
      name: 'Offset circle',
      planeRef: { type: 'canonical', plane: 'XY', offset: 39.999 },
      objects: [{ objectKind: 'circle', radius: 25, centerX: 10, centerY: 0 }]
    });
    const { document: withExtrude, bodyId: extrudeId } = extrudeSketch(
      withSketch,
      {
        name: 'Circular extrude',
        sketchId,
        distance: 20
      }
    );
    const manager = new CommandManager(withExtrude);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Shallow circular union',
        operation: 'union',
        targetBodyIds: [cylinderId, extrudeId]
      })
    );

    const derived = await adapter.syncDocument(document);
    const resultId = document.bodyOrder.at(-1)!;
    const result = derived.bodyRepresentations[resultId];
    expect(result).toBeDefined();
    expect(result?.faceCount).toBe(193);
    expect(
      derived.warnings.some(
        (warning) =>
          warning.startsWith('Feature "Shallow circular union":') &&
          FACET_CENSUS_MESSAGE.test(warning)
      )
    ).toBe(true);
    expect(
      result?.topology?.faces.every(
        (face) => face.geometry?.surfaceType === 'plane'
      )
    ).toBe(true);
    expect(
      isClosedConsistentlyOrientedMesh(
        inspectTriangleMeshClosure(result!.mesh.vertices, result!.mesh.indices)
      )
    ).toBe(true);
    expect(result?.exportableStep).toBe(true);
    expect(derived.warnings).toContainEqual(
      expect.stringContaining(
        'The result is watertight, but its curved surfaces are now planar facets and will export that way.'
      )
    );
    // Remus now returns the approximation instead of failing the fuse. Keep
    // that user-visible change explicit: the operands are consumed, but the
    // result is labeled before it can be mistaken for exact analytic output.
    expect(derived.bodyRepresentations[cylinderId]?.consumed).toBe(true);
    expect(derived.bodyRepresentations[extrudeId]?.consumed).toBe(true);
    // Runs in under a second locally but has tripped the 5 s default on slow
    // CI runners; give it the same headroom as the other kernel-heavy tests.
  }, 30_000);

  it('keeps a face-contact cylinder and circular-extrude union closed', async () => {
    const withCylinder = addPrimitiveFeature(
      createProjectDocument(
        'Face-contact circular union',
        toUserId('user_exact')
      ),
      {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 20, height: 40 }
      }
    );
    const cylinderId = withCylinder.bodyOrder.at(-1)!;
    const { document: withSketch, sketchId } = addSketchFeature(withCylinder, {
      name: 'Top-face circle',
      planeRef: { type: 'canonical', plane: 'XY', offset: 40 },
      objects: [{ objectKind: 'circle', radius: 25, centerX: 10, centerY: 0 }]
    });
    const { document: withExtrude, bodyId: extrudeId } = extrudeSketch(
      withSketch,
      {
        name: 'Circular extrude',
        sketchId,
        distance: 20
      }
    );
    const manager = new CommandManager(withExtrude);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Face-contact circular union',
        operation: 'union',
        targetBodyIds: [cylinderId, extrudeId]
      })
    );

    const derived = await adapter.syncDocument(document);
    const resultId = document.bodyOrder.at(-1)!;
    const body = derived.bodyRepresentations[resultId]!;
    const closure = inspectTriangleMeshClosure(
      body.mesh.vertices,
      body.mesh.indices
    );

    // Exact face contact degrades the same way the 1 µm sliver above does.
    expectCensusConsistentWithFaces(derived, body);
    expect(isClosedConsistentlyOrientedMesh(closure)).toBe(true);
    expect(body.volume).toBeGreaterThan(0);
  });

  it('rejects the M4 tangent cylindrical-boss union when the kernel drops the boss', async () => {
    const withPlate = addPrimitiveFeature(
      createProjectDocument('Tangent boss', toUserId('user_exact')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 60, height: 40, depth: 8 }
      }
    );
    const plateId = withPlate.bodyOrder.at(-1)!;
    const withBoss = addPrimitiveFeature(withPlate, {
      name: 'Boss',
      primitiveKind: 'cylinder',
      dimensions: { radius: 10, height: 16 }
    });
    const bossId = withBoss.bodyOrder.at(-1)!;
    const positioned = transformBody(withBoss, {
      name: 'Make boss tangent to x wall',
      targetBodyId: bossId,
      translation: { x: 10, y: 20, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Tangent boss union',
        operation: 'union',
        targetBodyIds: [plateId, bossId]
      })
    );

    // Fault injection pins the historical M4 kernel answer deterministically:
    // fuseAll reports success but returns its plate operand unchanged.
    const fuse = vi
      .spyOn(RemusKernel.prototype, 'fuseAll')
      .mockImplementation((solids) => solids[0]!);
    let derived: DerivedState;
    try {
      derived = await adapter.syncDocument(document);
    } finally {
      fuse.mockRestore();
    }
    const resultId = document.bodyOrder.at(-1)!;
    const body = derived.bodyRepresentations[resultId]!;

    // M4: fuseAll returns a valid six-plane solid, but it is exactly the plate
    // and silently loses the boss above z=8. The product must surface this as
    // a precommit warning instead of allowing the plausible result into undo.
    expect(body.volume).toBeCloseTo(60 * 40 * 8, 6);
    expect(body.bbox.max.z).toBeCloseTo(8, 7);
    expect(derived.warnings[0]).toBe(
      'Feature "Tangent boss union": Union dropped geometry from operand "Boss Body": the result\'s maximum z is 8 mm, but the operand reaches 16 mm (8 mm missing). A cylindrical boss can trigger this kernel failure at exact tangency; move the operand slightly off tangency while keeping positive overlap, then try again.'
    );
  });

  it('preserves inward-overlapping and wall-crossing boss unions as exact STEP', async () => {
    for (const [placement, centerX] of [
      ['inward-overlapping', 7],
      ['wall-crossing', 3]
    ] as const) {
      const manager = new CommandManager(
        createProjectDocument(
          `${placement} boss`,
          toUserId(`user_exact_${placement}`)
        )
      );
      manager.execute(
        commandFactories.importStep({
          name: 'Imported plate',
          artifactId: `artifact_${placement}_boss`,
          sourceName: 'modeling-base-plate.step',
          stepText: readFileSync(
            resolve('test/parity/corpus/modeling-base-plate.step'),
            'utf8'
          )
        })
      );
      const plateId = manager.document.bodyOrder.at(-1)!;
      manager.execute(
        commandFactories.addPrimitive({
          name: 'Boss',
          primitiveKind: 'cylinder',
          dimensions: { radius: 6, height: 20 }
        })
      );
      const bossId = manager.document.bodyOrder.at(-1)!;
      manager.execute(
        commandFactories.transformBody({
          name: `Place ${placement} boss`,
          targetBodyId: bossId,
          translation: { x: centerX, y: 12, z: 0 }
        })
      );
      const document = manager.execute(
        commandFactories.booleanBodies({
          name: `${placement} boss union`,
          operation: 'union',
          targetBodyIds: [plateId, bossId]
        })
      );
      const resultId = document.bodyOrder.at(-1)!;
      const derived = await adapter.syncDocument(document);
      const body = derived.bodyRepresentations[resultId]!;

      expect(derived.warnings).toEqual([]);
      expect(body.bbox.min.x).toBeCloseTo(Math.min(0, centerX - 6), 7);
      expect(body.bbox.max.z).toBeCloseTo(20, 7);
      expect(
        body.topology?.faces.some(
          (face) => face.geometry?.surfaceType === 'cylinder'
        )
      ).toBe(true);

      const step = await adapter.exportStep(document, [resultId]);
      expect(step).toContain('CYLINDRICAL_SURFACE');
      await expect(adapter.inspectStep(step)).resolves.toMatchObject({
        solid: true,
        valid: true
      });
    }
  });

  it('attributes a strict Union validation failure to the feature', async () => {
    const validate = vi
      .spyOn(RemusKernel.prototype, 'validateSolid')
      .mockReturnValue(1);
    try {
      const withFirst = addPrimitiveFeature(
        createProjectDocument('Rejected union', toUserId('user_exact')),
        {
          name: 'First',
          primitiveKind: 'box',
          dimensions: { width: 10, height: 10, depth: 10 }
        }
      );
      const firstId = withFirst.bodyOrder.at(-1)!;
      const withSecond = addPrimitiveFeature(withFirst, {
        name: 'Second',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      });
      const secondId = withSecond.bodyOrder.at(-1)!;
      const positioned = transformBody(withSecond, {
        name: 'Overlap boxes',
        targetBodyId: secondId,
        translation: { x: 5, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      }).document;
      const manager = new CommandManager(positioned);
      const document = manager.execute(
        commandFactories.booleanBodies({
          name: 'Rejected union',
          operation: 'union',
          targetBodyIds: [firstId, secondId]
        })
      );

      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toContain(
        'Feature "Rejected union": Union produced an open, non-manifold, or inconsistently oriented result. Adjust the overlap or placement and try again.'
      );
    } finally {
      validate.mockRestore();
    }
  });

  it('diagnoses a disconnected Remus union without rewriting legacy history', async () => {
    const withLower = addPrimitiveFeature(
      createProjectDocument('Separated union', toUserId('user_exact')),
      {
        name: 'Lower',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const lowerId = withLower.bodyOrder.at(-1)!;
    const withUpper = addPrimitiveFeature(withLower, {
      name: 'Upper',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const upperId = withUpper.bodyOrder.at(-1)!;
    const positioned = transformBody(withUpper, {
      name: 'Leave a gap',
      targetBodyId: upperId,
      translation: { x: 0, y: 0, z: 12 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Separated union',
        operation: 'union',
        targetBodyIds: [lowerId, upperId]
      })
    );

    const derived = await adapter.syncDocument(document);
    const resultId = document.bodyOrder.at(-1)!;
    expect(derived.warnings).toContain(
      'Feature "Separated union": Union does not fill empty space. The selected solids form 2 disconnected groups. The closest gap is 2 mm. Move or extend a body until every solid touches or overlaps.'
    );
    expect(derived.bodyRepresentations[resultId]?.volume).toBeCloseTo(2000, 4);
    expect(derived.bodyRepresentations[lowerId]?.consumed).toBe(true);
    expect(derived.bodyRepresentations[upperId]?.consumed).toBe(true);
  });

  it('diagnoses the same disconnected union when one body is imported', async () => {
    const source = addPrimitiveFeature(
      createProjectDocument('Source box', toUserId('user_exact')),
      {
        name: 'Source box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const step = await adapter.exportStep(source, [source.bodyOrder[0]!]);
    const importManager = new CommandManager(
      createProjectDocument('Imported separated union', toUserId('user_exact'))
    );
    const imported = importManager.execute(
      commandFactories.importStep({
        name: 'Imported lower',
        artifactId: 'artifact_union_gap',
        sourceName: 'lower.step',
        stepText: step
      })
    );
    const lowerId = imported.bodyOrder.at(-1)!;
    const withUpper = addPrimitiveFeature(imported, {
      name: 'Upper',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const upperId = withUpper.bodyOrder.at(-1)!;
    const positioned = transformBody(withUpper, {
      name: 'Leave a gap',
      targetBodyId: upperId,
      translation: { x: 0, y: 0, z: 12 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Imported separated union',
        operation: 'union',
        targetBodyIds: [lowerId, upperId]
      })
    );

    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toContain(
      'Feature "Imported separated union": Union does not fill empty space. The selected solids form 2 disconnected groups. The closest gap is 2 mm. Move or extend a body until every solid touches or overlaps.'
    );
  });

  it('keeps a coaxial cylinder cut as smooth analytic B-rep surfaces', async () => {
    const withOuter = addPrimitiveFeature(
      createProjectDocument('Bottle cap', toUserId('user_exact')),
      {
        name: 'Cap outer',
        primitiveKind: 'cylinder',
        dimensions: { radius: 32.9, height: 25 }
      }
    );
    const outer = withOuter.bodyOrder.at(-1)!;
    const withCavity = addPrimitiveFeature(withOuter, {
      name: 'Cap cavity',
      primitiveKind: 'cylinder',
      dimensions: { radius: 30.4, height: 21.5 }
    });
    const cavity = withCavity.bodyOrder.at(-1)!;
    const positioned = transformBody(withCavity, {
      name: 'Position cap cavity',
      targetBodyId: cavity,
      translation: { x: 0, y: 0, z: 3.5 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Water bottle bottom cap',
        operation: 'subtract',
        targetBodyIds: [outer, cavity]
      })
    );

    const derived = await adapter.syncDocument(document);
    const resultId = document.bodyOrder.at(-1)!;
    const body = derived.bodyRepresentations[resultId];
    const expectedVolume =
      Math.PI * 32.9 ** 2 * 25 - Math.PI * 30.4 ** 2 * 21.5;

    expect(derived.warnings).toEqual([]);
    expect(body?.faceCount).toBe(5);
    expect(body?.topology?.edges).toHaveLength(6);
    expect(body?.volume).toBeCloseTo(expectedVolume, 4);

    const step = await adapter.exportStep(document, [resultId]);
    expect(step.match(/CYLINDRICAL_SURFACE/g)).toHaveLength(2);
    expect(step.match(/ADVANCED_FACE/g)).toHaveLength(5);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('extrudes a detected ring region with its hole as exact geometry', async () => {
    const resolve = (value: ParamValue): number =>
      typeof value === 'number' ? value : Number(value);
    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument('Ring sketch', toUserId('user_exact')),
      {
        name: 'Ring profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          { objectKind: 'circle', radius: 63, centerX: 0, centerY: 0 },
          { objectKind: 'circle', radius: 40, centerX: 0, centerY: 0 }
        ]
      }
    );
    const sketch = findSketch(withSketch, sketchId)!;
    const objects = sketch.objectIds.flatMap((id) => {
      const node = withSketch.nodes[id];
      return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
    });
    const regions = computeSketchRegions(objects, resolve);
    const ring = regions.find((region) => region.holes.length === 1)!;
    expect(ring).toBeTruthy();

    const { document, bodyId } = extrudeSketch(withSketch, {
      name: 'Ring extrude',
      sketchId,
      distance: 10,
      profile: {
        regionFingerprint: ring.regionFingerprint,
        samplePoint: ring.samplePoint,
        sourceArea: ring.area
      }
    });
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bodyId];
    // Tessellated volume of a curved ring carries deflection error; assert
    // within 0.5% of the analytic value.
    const expectedVolume = Math.PI * (63 ** 2 - 40 ** 2) * 10;
    expect(
      Math.abs((body?.volume ?? 0) - expectedVolume) / expectedVolume
    ).toBeLessThan(0.005);
    // Two cylindrical walls + two annular caps.
    expect(body?.faceCount).toBe(4);

    const step = await adapter.exportStep(document, [bodyId]);
    expect(step.match(/CYLINDRICAL_SURFACE/g)).toHaveLength(2);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('fuses adjacent selected cells without an internal wall', async () => {
    const resolve = (value: ParamValue): number =>
      typeof value === 'number' ? value : Number(value);
    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument('Overlapping cells', toUserId('user_exact')),
      {
        name: 'Overlapping circles',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          { objectKind: 'circle', radius: 10, centerX: -5, centerY: 0 },
          { objectKind: 'circle', radius: 10, centerX: 5, centerY: 0 }
        ]
      }
    );
    const sketch = findSketch(withSketch, sketchId)!;
    const objects = sketch.objectIds.flatMap((id) => {
      const node = withSketch.nodes[id];
      return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
    });
    const profiles = computeSketchRegions(objects, resolve);
    const left = profiles.find((profile) =>
      profileContainsPoint(profile, { x: -8, y: 0 })
    )!;
    const lens = profiles.find((profile) =>
      profileContainsPoint(profile, { x: 0, y: 0 })
    )!;
    const reference = (profile: (typeof profiles)[number]) => ({
      profileId: profile.profileId,
      regionFingerprint: profile.regionFingerprint,
      samplePoint: profile.samplePoint,
      sourceArea: profile.area,
      sourceEntityIds: profile.sourceEntityIds
    });

    const { document, bodyId } = extrudeSketch(withSketch, {
      name: 'Merged cells',
      sketchId,
      distance: 7,
      profiles: [reference(left), reference(lens)]
    });
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bodyId];
    expect(body?.volume).toBeCloseTo(Math.PI * 10 ** 2 * 7, 0);
    // The curved wall remains split at the source-circle intersections, but
    // there are exactly two planar caps and no planar wall at the canceled
    // arrangement edge.
    const surfaceTypes =
      body?.topology?.faces.map((face) => face.geometry?.surfaceType) ?? [];
    expect(surfaceTypes.filter((surface) => surface === 'plane')).toHaveLength(
      2
    );
    expect(
      surfaceTypes.filter((surface) => surface === 'cylinder')
    ).toHaveLength(5);
  });

  it('rebinds a profile reference after a substantial source-curve edit', async () => {
    const resolve = (value: ParamValue): number =>
      typeof value === 'number' ? value : Number(value);
    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument('Parametric profile', toUserId('user_exact')),
      {
        name: 'Editable disk',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [{ objectKind: 'circle', radius: 10, centerX: 0, centerY: 0 }]
      }
    );
    const sketch = findSketch(withSketch, sketchId)!;
    const objectId = sketch.objectIds[0]!;
    const profile = computeSketchRegions(
      sketch.objectIds.flatMap((id) => {
        const node = withSketch.nodes[id];
        return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
      }),
      resolve
    )[0]!;
    const { document: extruded, bodyId } = extrudeSketch(withSketch, {
      name: 'Parametric disk extrude',
      sketchId,
      distance: 5,
      profiles: [
        {
          profileId: profile.profileId,
          regionFingerprint: profile.regionFingerprint,
          samplePoint: profile.samplePoint,
          sourceArea: profile.area,
          sourceEntityIds: profile.sourceEntityIds
        }
      ]
    });
    const edited = updateSketchObject(extruded, {
      sketchId,
      objectId,
      data: {
        objectKind: 'circle',
        radius: 20,
        centerX: 0,
        centerY: 0
      }
    });

    // This used to refuse, and refusing was the defect. Doubling a circle's
    // radius is the ordinary parametric edit: it invalidates `profileId`,
    // `regionFingerprint` and `sourceArea` in one go, because all three are
    // derived from the curve. There is still exactly one region bounded by
    // exactly the referenced circle, so identity is unambiguous and the
    // reference rebinds — where before the solid vanished behind a warning,
    // taking every fillet, boolean and pattern built on it with it.
    const derived = await adapter.syncDocument(edited);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      Math.PI * 20 ** 2 * 5,
      0
    );
  });

  it('rebuilds at the new size when the named parameter driving a sketch dimension changes', async () => {
    // The reported shape of the defect, end to end: name a sketch dimension,
    // change the parameter, and the solid used to disappear behind a warning.
    const seeded = setParameter(
      createProjectDocument('Parametric bracket', toUserId('user_exact')),
      { name: 'disk_r', expression: '10' }
    );
    const { document: withSketch, sketchId } = addSketchFeature(seeded, {
      name: 'Driven disk',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        { objectKind: 'circle', radius: 'disk_r', centerX: 0, centerY: 0 }
      ]
    });
    const sketch = findSketch(withSketch, sketchId)!;
    const profile = computeSketchRegions(
      sketch.objectIds.flatMap((id) => {
        const node = withSketch.nodes[id];
        return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
      }),
      (value) => (typeof value === 'number' ? value : 10)
    )[0]!;
    const { document: extruded, bodyId } = extrudeSketch(withSketch, {
      name: 'Driven extrude',
      sketchId,
      distance: 5,
      profiles: [
        {
          profileId: profile.profileId,
          regionFingerprint: profile.regionFingerprint,
          samplePoint: profile.samplePoint,
          sourceArea: profile.area,
          sourceEntityIds: profile.sourceEntityIds
        }
      ]
    });

    const before = await adapter.syncDocument(extruded);
    expect(before.warnings).toEqual([]);
    expect(before.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      Math.PI * 10 ** 2 * 5,
      0
    );

    const enlarged = setParameter(extruded, {
      name: 'disk_r',
      expression: '20'
    });
    const after = await adapter.syncDocument(enlarged);
    expect(after.warnings).toEqual([]);
    expect(after.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      Math.PI * 20 ** 2 * 5,
      0
    );

    // Scope note, so this is not read as more than it is: the profile
    // reference rebinds, so the extrude and anything keyed to the BODY
    // survives. A downstream feature holding an edge *hash* — a fillet on the
    // rim — still fails with "A selected edge no longer exists", because edge
    // lineage does not yet extend through blends (TODO.md, release gates).
    // That is a separate gap, not this one.
  });

  it('still refuses when the referenced entities stop bounding one region', async () => {
    // The fail-closed half of the same rule. Identity is only trusted when it
    // is unambiguous: splitting the circle leaves two regions carrying the
    // same entity set, and the stored area and sample point no longer pick
    // either of them out, so the reference must not guess.
    const resolve = (value: ParamValue): number =>
      typeof value === 'number' ? value : Number(value);
    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument('Ambiguous profile', toUserId('user_exact')),
      {
        name: 'Splittable disk',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [{ objectKind: 'circle', radius: 10, centerX: 0, centerY: 0 }]
      }
    );
    const sketch = findSketch(withSketch, sketchId)!;
    const profile = computeSketchRegions(
      sketch.objectIds.flatMap((id) => {
        const node = withSketch.nodes[id];
        return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
      }),
      resolve
    )[0]!;
    const { document: extruded, bodyId } = extrudeSketch(withSketch, {
      name: 'Ambiguous disk extrude',
      sketchId,
      distance: 5,
      profiles: [
        {
          profileId: profile.profileId,
          regionFingerprint: profile.regionFingerprint,
          samplePoint: profile.samplePoint,
          sourceArea: profile.area,
          sourceEntityIds: profile.sourceEntityIds
        }
      ]
    });
    // A chord across the circle splits it into two cells. Both are bounded by
    // the circle plus the new line, so neither carries the stored entity set
    // on its own — and the stored geometry matches neither half.
    const { document: split } = addSketchObjects(extruded, {
      sketchId,
      objects: [{ objectKind: 'line', x1: -30, y1: 0.5, x2: 30, y2: 0.5 }]
    });

    const derived = await adapter.syncDocument(split);
    expect(derived.warnings).toContain(
      'Feature "Ambiguous disk extrude": Broken profile reference — the bounded sketch region used by this extrude no longer resolves uniquely.'
    );
    expect(derived.bodyRepresentations[bodyId]).toBeUndefined();
  });

  it('extrudes a chord-split region and resolves by fallback when the fingerprint drifts', async () => {
    const resolve = (value: ParamValue): number =>
      typeof value === 'number' ? value : Number(value);
    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument('Split disk', toUserId('user_exact')),
      {
        name: 'Split profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          { objectKind: 'circle', radius: 20, centerX: 0, centerY: 0 },
          { objectKind: 'line', x1: -30, y1: 5, x2: 30, y2: 5 }
        ]
      }
    );
    const sketch = findSketch(withSketch, sketchId)!;
    const objects = sketch.objectIds.flatMap((id) => {
      const node = withSketch.nodes[id];
      return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
    });
    const regions = computeSketchRegions(objects, resolve);
    expect(regions).toHaveLength(2);
    const major = regions[0]!; // sorted largest-first

    const { document, bodyId } = extrudeSketch(withSketch, {
      name: 'Major piece',
      sketchId,
      distance: 8,
      profile: {
        // Deliberately wrong fingerprint: the fallback (sample point inside
        // + area within 1%) must resolve it.
        regionFingerprint: major.regionFingerprint + 1,
        samplePoint: major.samplePoint,
        sourceArea: major.area
      }
    });
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bodyId];
    const expectedVolume = major.area * 8;
    expect(
      Math.abs((body?.volume ?? 0) - expectedVolume) / expectedVolume
    ).toBeLessThan(0.005);

    const step = await adapter.exportStep(document, [bodyId]);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('fails closed when a referenced region no longer exists', async () => {
    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument('Ghost region', toUserId('user_exact')),
      {
        name: 'Disk profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [{ objectKind: 'circle', radius: 10, centerX: 0, centerY: 0 }]
      }
    );
    const { document, bodyId } = extrudeSketch(withSketch, {
      name: 'Ghost extrude',
      sketchId,
      distance: 5,
      profile: {
        regionFingerprint: 123456789,
        samplePoint: { x: 500, y: 500 },
        sourceArea: 42
      }
    });
    const derived = await adapter.syncDocument(document);
    expect(
      derived.warnings.some((warning) =>
        warning.includes('Broken profile reference')
      )
    ).toBe(true);
    expect(derived.bodyRepresentations[bodyId]).toBeUndefined();
  });

  it('offsets a planar face outward and inward as a direct edit', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Offset target', toUserId('user_exact')),
      {
        name: 'Beam',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const bodyId = base.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(base);
    const body = Object.values(derived.bodyRepresentations)[0];
    const topFace = body?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.z ?? 0) > 0.99
    );
    expect(topFace).toBeTruthy();

    const outward = directEditBody(base, {
      name: 'Raise top face',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: topFace!.hash,
        sourceSurfaceType: 'plane',
        sourceArea: topFace!.geometry!.area,
        sourceCenter: topFace!.geometry!.center,
        sourceNormal: topFace!.geometry!.normal!,
        offset: 5
      }
    }).document;
    const raised = await adapter.syncDocument(outward);
    expect(raised.warnings).toEqual([]);
    const raisedBody = raised.bodyRepresentations[bodyId];
    expect(raisedBody?.volume).toBeCloseTo(10 * 20 * 35, 4);
    // A clean offset keeps the box a box.
    expect(raisedBody?.faceCount).toBe(6);

    const inward = directEditBody(base, {
      name: 'Sink top face',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: topFace!.hash,
        sourceSurfaceType: 'plane',
        sourceArea: topFace!.geometry!.area,
        sourceCenter: topFace!.geometry!.center,
        sourceNormal: topFace!.geometry!.normal!,
        offset: -5
      }
    }).document;
    const sunk = await adapter.syncDocument(inward);
    expect(sunk.warnings).toEqual([]);
    expect(sunk.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      10 * 20 * 25,
      4
    );

    const step = await adapter.exportStep(outward, [bodyId]);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('leaves a bored body exact when face offset falls back to facets', async () => {
    const withOuter = addPrimitiveFeature(
      createProjectDocument('Blind bore offset', toUserId('user_exact')),
      {
        name: 'Outer cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 20, height: 50 }
      }
    );
    const outerId = withOuter.bodyOrder.at(-1)!;
    const withDrill = addPrimitiveFeature(withOuter, {
      name: 'Blind bore tool',
      primitiveKind: 'cylinder',
      dimensions: { radius: 10, height: 30 }
    });
    const drillId = withDrill.bodyOrder.at(-1)!;
    const positioned = transformBody(withDrill, {
      name: 'Seat bore above its floor',
      targetBodyId: drillId,
      translation: { x: 0, y: 0, z: 20 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const bored = manager.execute(
      commandFactories.booleanBodies({
        name: 'Blind bored cylinder',
        operation: 'subtract',
        targetBodyIds: [outerId, drillId]
      })
    );
    const bodyId = bored.bodyOrder.at(-1)!;
    const before = await adapter.syncDocument(bored);
    expect(before.warnings).toEqual([]);
    const exactBody = before.bodyRepresentations[bodyId]!;
    const curvedFaces = exactBody.topology!.faces.filter(
      (face) => face.geometry?.surfaceType !== 'plane'
    );
    expect(exactBody.faceCount).toBe(5);
    expect(curvedFaces).toHaveLength(2);
    const boreFloor = exactBody.topology!.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs((face.geometry.center.z ?? 0) - 20) < 1e-5
    );
    expect(boreFloor).toBeTruthy();

    const edited = directEditBody(bored, {
      name: 'Deepen blind bore',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: boreFloor!.hash,
        sourceSurfaceType: 'plane',
        sourceArea: boreFloor!.geometry!.area,
        sourceCenter: boreFloor!.geometry!.center,
        sourceNormal: boreFloor!.geometry!.normal!,
        offset: -5
      }
    }).document;

    // Fault injection pins the reported kernel failure: a valid result that
    // silently replaces both cylinders with planar faces.
    const pushPull = vi
      .spyOn(RemusKernel.prototype, 'pushPullFace')
      .mockImplementation(function (
        this: RemusKernel,
        _solid: number,
        _face: number,
        _distance: number
      ) {
        return this.makeBox(40, 40, 50);
      });
    let after: DerivedState;
    try {
      after = await adapter.syncDocument(edited);
    } finally {
      pushPull.mockRestore();
    }

    expect(after.warnings).toContain(
      'Feature "Deepen blind bore": Offset face refused: the kernel returned a faceted approximation instead of exact surfaces: 5 source faces (2 curved) became 6 result faces (0 curved). The original body was left unchanged.'
    );
    const preservedBody = after.bodyRepresentations[bodyId]!;
    expect(preservedBody.volume).toBeCloseTo(exactBody.volume, 6);
    expect(preservedBody.faceCount).toBe(5);
    expect(
      preservedBody.topology!.faces.filter(
        (face) => face.geometry?.surfaceType !== 'plane'
      )
    ).toHaveLength(2);
  });

  it('fails closed when the offset face fingerprint no longer resolves', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Stale face', toUserId('user_exact')),
      {
        name: 'Beam',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const bodyId = base.bodyOrder.at(-1)!;
    const stale = directEditBody(base, {
      name: 'Offset a ghost face',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: 987654321,
        sourceSurfaceType: 'plane',
        sourceArea: 300,
        sourceCenter: { x: 0, y: 0, z: 0 },
        sourceNormal: { x: 0, y: 0, z: 1 },
        offset: 5
      }
    }).document;
    const derived = await adapter.syncDocument(stale);
    expect(
      derived.warnings.some((warning) => warning.includes('no longer exists'))
    ).toBe(true);
    // The target body still builds at its original size.
    expect(derived.bodyRepresentations[bodyId]?.volume).toBeCloseTo(6000, 4);
  });

  it('rejects non-finite direct-edit snapshots before topology matching', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Malformed edit', toUserId('user_exact')),
      {
        name: 'Beam',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const bodyId = base.bodyOrder.at(-1)!;
    const malformed = directEditBody(base, {
      name: 'Malformed offset',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: 1,
        sourceSurfaceType: 'plane',
        sourceArea: Number.NaN,
        sourceCenter: { x: 0, y: 0, z: 0 },
        sourceNormal: { x: 0, y: 0, z: 1 },
        offset: 5
      }
    }).document;

    const derived = await adapter.syncDocument(malformed);
    expect(derived.warnings).toContain(
      'Feature "Malformed offset": Direct-edit source area must be finite.'
    );
    expect(derived.bodyRepresentations[bodyId]?.volume).toBeCloseTo(6000, 4);
  });

  it('rejects unknown and incomplete direct-edit operations at runtime', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Malformed edits', toUserId('user_exact')),
      {
        name: 'Beam',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const bodyId = base.bodyOrder.at(-1)!;
    const cases = [
      {
        name: 'Unknown edit',
        operation: { kind: 'erase-face', faceHash: 1 },
        message: 'Direct-edit operation kind is not supported.'
      },
      {
        name: 'Incomplete resize',
        operation: {
          kind: 'resize-through-hole',
          faceHash: 1,
          sourceDiameter: 4,
          sourceAxisEnd: { x: 0, y: 0, z: 10 },
          diameter: 6
        },
        message: 'Direct-edit source axis start must be a vector.'
      }
    ];

    for (const testCase of cases) {
      const malformed = directEditBody(base, {
        name: testCase.name,
        targetBodyId: bodyId,
        operation: testCase.operation as unknown as DirectEditOperation
      }).document;
      const derived = await adapter.syncDocument(malformed);

      expect(derived.warnings).toContain(
        `Feature "${testCase.name}": ${testCase.message}`
      );
      expect(derived.bodyRepresentations[bodyId]?.volume).toBeCloseTo(6000, 4);
    }
  });

  it('rejects an unsupported persisted primitive kind', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Malformed primitive', toUserId('user_exact')),
      {
        name: 'Unknown',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const featureId = document.featureOrder[0]!;
    const feature = Object.values(document.nodes).find(
      (node) => node.kind === 'feature' && node.featureId === featureId
    );
    if (
      !feature ||
      feature.kind !== 'feature' ||
      feature.data.featureKind !== 'primitive'
    ) {
      throw new Error('primitive fixture missing');
    }
    (feature.data as { primitiveKind: string }).primitiveKind = 'capsule';

    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toContain(
      'Feature "Unknown": Primitive kind is not supported.'
    );
  });

  it('resizes a cylindrical bore as a direct edit', async () => {
    const withBlock = addPrimitiveFeature(
      createProjectDocument('Bore resize', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 40, depth: 10 }
      }
    );
    const blockId = withBlock.bodyOrder.at(-1)!;
    const withDrill = addPrimitiveFeature(withBlock, {
      name: 'Drill',
      primitiveKind: 'cylinder',
      dimensions: { radius: 3, height: 10 }
    });
    const drillId = withDrill.bodyOrder.at(-1)!;
    const positioned = transformBody(withDrill, {
      name: 'Center drill',
      targetBodyId: drillId,
      translation: { x: 20, y: 20, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Drilled block',
        operation: 'subtract',
        targetBodyIds: [blockId, drillId]
      })
    );
    const resultId = document.bodyOrder.at(-1)!;

    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[resultId];
    const bore = body?.topology?.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(bore?.geometry?.radius).toBeCloseTo(3, 4);
    expect(bore?.geometry?.axisStart).toBeTruthy();

    const resized = directEditBody(document, {
      name: 'Widen bore',
      targetBodyId: resultId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: bore!.hash,
        sourceRadius: bore!.geometry!.radius!,
        sourceAxisStart: bore!.geometry!.axisStart!,
        sourceAxisEnd: bore!.geometry!.axisEnd!,
        concavity: 'hole',
        radius: 5
      }
    }).document;
    const widened = await adapter.syncDocument(resized);
    expect(widened.warnings).toEqual([]);
    // Volume is measured from the tessellation, so allow its deflection error.
    expect(widened.bodyRepresentations[resultId]?.volume).toBeCloseTo(
      40 * 40 * 10 - Math.PI * 25 * 10,
      0
    );
    // Rebuilds resolve the widened bore deterministically.
    const again = await adapter.syncDocument(resized);
    expect(again.warnings).toEqual([]);
    expect(again.bodyRepresentations[resultId]?.volume).toBeCloseTo(
      widened.bodyRepresentations[resultId]!.volume,
      6
    );
    // The widened bore stays one analytic cylindrical face.
    const widenedFaces = widened.bodyRepresentations[resultId]?.topology?.faces;
    const widenedBore = widenedFaces?.filter(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(widenedBore).toHaveLength(1);
    expect(widenedBore?.[0]?.geometry?.radius).toBeCloseTo(5, 4);

    // Moving the wall back inward sweeps the annular sleeve between the two
    // radii through material that is already there. The kernel builds that
    // tube itself, so shrinking goes through the same call as growing.
    const shrunkDoc = directEditBody(resized, {
      name: 'Shrink bore',
      targetBodyId: resultId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: widenedBore![0]!.hash,
        sourceRadius: widenedBore![0]!.geometry!.radius!,
        sourceAxisStart: widenedBore![0]!.geometry!.axisStart!,
        sourceAxisEnd: widenedBore![0]!.geometry!.axisEnd!,
        concavity: 'hole',
        radius: 4
      }
    }).document;
    const shrunk = await adapter.syncDocument(shrunkDoc);
    expect(shrunk.warnings).toEqual([]);
    expect(shrunk.bodyRepresentations[resultId]?.volume).toBeCloseTo(
      40 * 40 * 10 - Math.PI * 16 * 10,
      0
    );
    // The narrowed wall is one analytic cylinder at the new radius, not the
    // old wall left in place and not a ring of planar strips.
    const shrunkBore = shrunk.bodyRepresentations[
      resultId
    ]?.topology?.faces.filter(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(shrunkBore).toHaveLength(1);
    expect(shrunkBore?.[0]?.geometry?.radius).toBeCloseTo(4, 4);

    // Composing the resize from booleans used to leave a solid that OCCT
    // rejected on import, so this body could only be checked in-app. The
    // native op's own closed-shell gate makes it exportable.
    const step = await adapter.exportStep(shrunkDoc, [resultId]);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('shrinks a coaxial through-hole without faceting the analytic shell', async () => {
    const withCylinder = addPrimitiveFeature(
      createProjectDocument('Coaxial bore resize', toUserId('user_exact')),
      {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 14, height: 28 }
      }
    );
    const cylinderId = withCylinder.bodyOrder.at(-1)!;
    const { document: withSketch, sketchId } = addSketchFeature(withCylinder, {
      name: 'Bore sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [{ objectKind: 'circle', radius: 6.083, centerX: 0, centerY: 0 }]
    });
    const { document: withExtrude, bodyId: boreToolId } = extrudeSketch(
      withSketch,
      {
        name: 'Bore tool',
        sketchId,
        distance: 28
      }
    );
    const document = new CommandManager(withExtrude).execute(
      commandFactories.booleanBodies({
        name: 'Through hole',
        operation: 'subtract',
        targetBodyIds: [cylinderId, boreToolId]
      })
    );
    const resultId = document.bodyOrder.at(-1)!;

    const source = await adapter.syncDocument(document);
    expect(source.warnings).toEqual([]);
    const sourceBody = source.bodyRepresentations[resultId];
    expect(sourceBody?.faceCount).toBe(4);
    const sourceCylinders = sourceBody?.topology?.faces.filter(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(sourceCylinders).toHaveLength(2);
    const bore = sourceCylinders?.find(
      (face) => Math.abs(face.geometry!.radius! - 6.083) < 1e-6
    );
    expect(bore).toBeTruthy();

    const edited = directEditBody(document, {
      name: 'Resize Cylinder Radius',
      targetBodyId: resultId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: bore!.hash,
        sourceRadius: bore!.geometry!.radius!,
        sourceAxisStart: bore!.geometry!.axisStart!,
        sourceAxisEnd: bore!.geometry!.axisEnd!,
        concavity: 'hole',
        radius: 5
      }
    }).document;
    const resized = await adapter.syncDocument(edited);
    expect(resized.warnings).toEqual([]);
    const resizedBody = resized.bodyRepresentations[resultId];
    expect(resizedBody?.faceCount).toBe(4);
    const resizedCylinders = resizedBody?.topology?.faces.filter(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(resizedCylinders).toHaveLength(2);
    const resizedRadii = resizedCylinders!
      .map((face) => face.geometry!.radius!)
      .sort((left, right) => left - right);
    expect(resizedRadii[0]).toBeCloseTo(5, 9);
    expect(resizedRadii[1]).toBeCloseTo(14, 9);
    expect(resizedBody?.volume).toBeCloseTo(
      Math.PI * (14 ** 2 - 5 ** 2) * 28,
      6
    );

    const rebuilt = await adapter.syncDocument(edited);
    expect(rebuilt.warnings).toEqual([]);
    expect(rebuilt.bodyRepresentations[resultId]?.volume).toBeCloseTo(
      resizedBody!.volume,
      9
    );

    const step = await adapter.exportStep(edited, [resultId]);
    expect(step.match(/CYLINDRICAL_SURFACE/g)).toHaveLength(2);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('grows and shrinks a free-standing boss', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Boss resize', toUserId('user_exact')),
      {
        name: 'Post',
        primitiveKind: 'cylinder',
        dimensions: { radius: 12, height: 15 }
      }
    );
    const bossId = document.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const wall = derived.bodyRepresentations[bossId]?.topology?.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(wall?.geometry?.radius).toBeCloseTo(12, 4);
    const resize = (radius: number) =>
      directEditBody(document, {
        name: 'Resize boss',
        targetBodyId: bossId,
        operation: {
          kind: 'resize-cylindrical-face',
          faceHash: wall!.hash,
          sourceRadius: wall!.geometry!.radius!,
          sourceAxisStart: wall!.geometry!.axisStart!,
          sourceAxisEnd: wall!.geometry!.axisEnd!,
          concavity: 'boss',
          radius
        }
      }).document;

    const grown = await adapter.syncDocument(resize(15));
    expect(grown.warnings).toEqual([]);
    const body = grown.bodyRepresentations[bossId];
    expect(body?.volume).toBeCloseTo(Math.PI * 225 * 15, 0);
    // The grown wall is one analytic cylinder, not a ring of boolean strips.
    const walls = body?.topology?.faces.filter(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(walls).toHaveLength(1);
    expect(walls?.[0]?.geometry?.radius).toBeCloseTo(15, 4);

    const shrunk = await adapter.syncDocument(resize(9));
    expect(shrunk.warnings).toEqual([]);
    const shrunkBody = shrunk.bodyRepresentations[bossId];
    expect(shrunkBody?.volume).toBeCloseTo(Math.PI * 81 * 15, 0);
    const shrunkWalls = shrunkBody?.topology?.faces.filter(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(shrunkWalls).toHaveLength(1);
    expect(shrunkWalls?.[0]?.geometry?.radius).toBeCloseTo(9, 4);

    // Resizing to the radius the wall is already at leaves no sleeve to
    // sweep, so it is rejected rather than kept as a feature that does
    // nothing.
    const unchanged = await adapter.syncDocument(resize(12));
    expect(
      unchanged.warnings.some((warning) =>
        warning.includes('Radius must differ from the current radius')
      )
    ).toBe(true);
    expect(unchanged.bodyRepresentations[bossId]?.volume).toBeCloseTo(
      derived.bodyRepresentations[bossId]!.volume,
      6
    );
  });

  it('keeps small, large, and transformed radius edits as exact cylinders', async () => {
    const cases: Array<{
      name: string;
      sourceRadius: number;
      targetRadius: number;
      height: number;
      transform?: {
        translation: { x: number; y: number; z: number };
        rotationDeg: { x: number; y: number; z: number };
      };
    }> = [
      {
        name: 'very small',
        sourceRadius: 0.00002,
        targetRadius: 0.00003,
        height: 0.00008
      },
      {
        name: 'very large',
        sourceRadius: 2_000_000,
        targetRadius: 3_500_000,
        height: 4_000_000
      },
      {
        name: 'transformed',
        sourceRadius: 6,
        targetRadius: 9.5,
        height: 24,
        transform: {
          translation: { x: 41, y: -17, z: 23 },
          rotationDeg: { x: 35, y: 20, z: 15 }
        }
      }
    ];

    for (const testCase of cases) {
      const base = addPrimitiveFeature(
        createProjectDocument(
          `${testCase.name} cylinder`,
          toUserId(`user_${testCase.name.replace(' ', '_')}`)
        ),
        {
          name: 'Post',
          primitiveKind: 'cylinder',
          dimensions: {
            radius: testCase.sourceRadius,
            height: testCase.height
          }
        }
      );
      const bodyId = base.bodyOrder.at(-1)!;
      const document = testCase.transform
        ? transformBody(base, {
            name: 'Place post',
            targetBodyId: bodyId,
            ...testCase.transform
          }).document
        : base;

      const source = await adapter.syncDocument(document);
      expect(source.warnings).toEqual([]);
      const sourceWall = source.bodyRepresentations[
        bodyId
      ]?.topology?.faces.find(
        (face) => face.geometry?.surfaceType === 'cylinder'
      );
      expect(sourceWall?.geometry?.radius).toBeCloseTo(
        testCase.sourceRadius,
        10
      );

      const edited = directEditBody(document, {
        name: 'Resize post',
        targetBodyId: bodyId,
        operation: {
          kind: 'resize-cylindrical-face',
          faceHash: sourceWall!.hash,
          sourceRadius: sourceWall!.geometry!.radius!,
          sourceAxisStart: sourceWall!.geometry!.axisStart!,
          sourceAxisEnd: sourceWall!.geometry!.axisEnd!,
          concavity: 'boss',
          radius: testCase.targetRadius
        }
      }).document;
      const resized = await adapter.syncDocument(edited);
      expect(resized.warnings).toEqual([]);

      const body = resized.bodyRepresentations[bodyId]!;
      const walls =
        body.topology?.faces.filter(
          (face) => face.geometry?.surfaceType === 'cylinder'
        ) ?? [];
      expect(body.faceCount).toBe(3);
      expect(walls).toHaveLength(1);
      expect(walls[0]!.geometry!.radius! / testCase.targetRadius).toBeCloseTo(
        1,
        10
      );
      expect(
        body.volume /
          (Math.PI *
            testCase.targetRadius *
            testCase.targetRadius *
            testCase.height)
      ).toBeCloseTo(1, 3);

      const sourceStart = sourceWall!.geometry!.axisStart!;
      const sourceEnd = sourceWall!.geometry!.axisEnd!;
      const resizedStart = walls[0]!.geometry!.axisStart!;
      const resizedEnd = walls[0]!.geometry!.axisEnd!;
      const pointDistance = (
        left: { x: number; y: number; z: number },
        right: { x: number; y: number; z: number }
      ) => Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
      const aligned = Math.max(
        pointDistance(sourceStart, resizedStart),
        pointDistance(sourceEnd, resizedEnd)
      );
      const reversed = Math.max(
        pointDistance(sourceStart, resizedEnd),
        pointDistance(sourceEnd, resizedStart)
      );
      const axisTolerance =
        Math.max(
          testCase.sourceRadius,
          testCase.targetRadius,
          testCase.height
        ) * 1e-7;
      expect(Math.min(aligned, reversed)).toBeLessThanOrEqual(axisTolerance);

      const step = await adapter.exportStep(edited, [bodyId]);
      await expect(adapter.inspectStep(step)).resolves.toMatchObject({
        solid: true,
        valid: true
      });
    }
  });

  it('offsets a cylinder cap after repeated radius edits', async () => {
    let document = addPrimitiveFeature(
      createProjectDocument('Edited cylinder cap', toUserId('user_exact')),
      {
        name: 'Post',
        primitiveKind: 'cylinder',
        dimensions: { radius: 12, height: 30.25 }
      }
    );
    const bodyId = document.bodyOrder.at(-1)!;

    for (const radius of [9, 13, 8, 10, 5.5, 6.5]) {
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const wall = derived.bodyRepresentations[bodyId]?.topology?.faces.find(
        (face) => face.geometry?.surfaceType === 'cylinder'
      );
      expect(wall).toBeTruthy();
      document = directEditBody(document, {
        name: 'Resize boss',
        targetBodyId: bodyId,
        operation: {
          kind: 'resize-cylindrical-face',
          faceHash: wall!.hash,
          sourceRadius: wall!.geometry!.radius!,
          sourceAxisStart: wall!.geometry!.axisStart!,
          sourceAxisEnd: wall!.geometry!.axisEnd!,
          concavity: 'boss',
          radius
        }
      }).document;
    }

    const resized = await adapter.syncDocument(document);
    expect(resized.warnings).toEqual([]);
    const body = resized.bodyRepresentations[bodyId];
    expect(body?.volume).toBeCloseTo(Math.PI * 6.5 * 6.5 * 30.25, 0);
    const top = body?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.z ?? 0) > 0.99
    );
    expect(top).toBeTruthy();

    const offset = directEditBody(document, {
      name: 'Lower top',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: top!.hash,
        sourceSurfaceType: 'plane',
        sourceArea: top!.geometry!.area,
        sourceCenter: top!.geometry!.center,
        sourceNormal: top!.geometry!.normal!,
        offset: -4.5
      }
    }).document;
    const lowered = await adapter.syncDocument(offset);
    expect(lowered.warnings).toEqual([]);
    expect(lowered.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      Math.PI * 6.5 * 6.5 * (30.25 - 4.5),
      0
    );
    expect(lowered.bodyRepresentations[bodyId]?.faceCount).toBe(3);
    const step = await adapter.exportStep(offset, [bodyId]);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('offsets both caps of a transformed analytic cylinder', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument(
        'Transformed cylinder caps',
        toUserId('user_exact')
      ),
      {
        name: 'Post',
        primitiveKind: 'cylinder',
        dimensions: { radius: 6, height: 20 }
      }
    );
    const bodyId = base.bodyOrder.at(-1)!;
    let document = transformBody(base, {
      name: 'Place post',
      targetBodyId: bodyId,
      translation: { x: 4, y: -3, z: 8 },
      rotationDeg: { x: 35, y: 20, z: 15 }
    }).document;

    const capAlongAxis = async (direction: 1 | -1) => {
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId];
      const wall = body?.topology?.faces.find(
        (face) => face.geometry?.surfaceType === 'cylinder'
      );
      const start = wall!.geometry!.axisStart!;
      const end = wall!.geometry!.axisEnd!;
      const axisLength = Math.hypot(
        end.x - start.x,
        end.y - start.y,
        end.z - start.z
      );
      const axis = {
        x: (end.x - start.x) / axisLength,
        y: (end.y - start.y) / axisLength,
        z: (end.z - start.z) / axisLength
      };
      return body!.topology!.faces.find((face) => {
        const normal = face.geometry?.normal;
        return (
          face.geometry?.surfaceType === 'plane' &&
          normal !== undefined &&
          Math.abs(
            normal.x * axis.x +
              normal.y * axis.y +
              normal.z * axis.z -
              direction
          ) < 1e-6
        );
      })!;
    };

    const top = await capAlongAxis(1);
    document = directEditBody(document, {
      name: 'Raise top',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: top.hash,
        sourceSurfaceType: 'plane',
        sourceArea: top.geometry!.area,
        sourceCenter: top.geometry!.center,
        sourceNormal: top.geometry!.normal!,
        offset: 3
      }
    }).document;

    const bottom = await capAlongAxis(-1);
    document = directEditBody(document, {
      name: 'Lower bottom',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: bottom.hash,
        sourceSurfaceType: 'plane',
        sourceArea: bottom.geometry!.area,
        sourceCenter: bottom.geometry!.center,
        sourceNormal: bottom.geometry!.normal!,
        offset: 2
      }
    }).document;

    const expanded = await adapter.syncDocument(document);
    expect(expanded.warnings).toEqual([]);
    expect(expanded.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      Math.PI * 6 * 6 * 25,
      0
    );
    expect(expanded.bodyRepresentations[bodyId]?.faceCount).toBe(3);
  });

  it('grows a boss fused into a plate', async () => {
    // A boss fused into a plate puts the union tool against a coaxial
    // cylindrical face. The kernel used to hand back the original solid —
    // valid, but unchanged — and only the adapter's read-back guard caught
    // it. BrepKit 2.129.0 grew the wall natively, so the edit now lands.
    // The guard itself still matters and is exercised by the shrink cases
    // above, which continue to fail closed.
    const plate = addPrimitiveFeature(
      createProjectDocument('Fused boss', toUserId('user_exact')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 60, height: 60, depth: 8 }
      }
    );
    const plateId = plate.bodyOrder.at(-1)!;
    const withPost = addPrimitiveFeature(plate, {
      name: 'Post',
      primitiveKind: 'cylinder',
      dimensions: { radius: 12, height: 15 }
    });
    const postId = withPost.bodyOrder.at(-1)!;
    const placed = transformBody(withPost, {
      name: 'Center post',
      targetBodyId: postId,
      translation: { x: 30, y: 30, z: 8 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(placed);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Plate with boss',
        operation: 'union',
        targetBodyIds: [plateId, postId]
      })
    );
    const bossId = document.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(document);
    const wall = derived.bodyRepresentations[bossId]?.topology?.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(wall?.geometry?.radius).toBeCloseTo(12, 4);

    const grownDoc = directEditBody(document, {
      name: 'Resize boss',
      targetBodyId: bossId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: wall!.hash,
        sourceRadius: wall!.geometry!.radius!,
        sourceAxisStart: wall!.geometry!.axisStart!,
        sourceAxisEnd: wall!.geometry!.axisEnd!,
        concavity: 'boss',
        radius: 15
      }
    }).document;
    const grown = await adapter.syncDocument(grownDoc);
    expect(grown.warnings).toEqual([]);

    // The post stands on the plate rather than inside it, so the body is the
    // plate plus a full cylinder: 60*60*8 + pi*r^2*15. Growing r from 12 to
    // 15 takes it from ~35586 to ~39403. Volume is measured from the
    // tessellation, whose inscribed mesh under-reports a cylinder, so compare
    // against the exact figure with a relative tolerance rather than a fixed
    // number of digits — the absolute error scales with the cylinder.
    const plateVolume = 60 * 60 * 8;
    const nearExactly = (actual: number | undefined, exact: number): void => {
      expect(actual).toBeDefined();
      expect(Math.abs(actual! - exact) / exact).toBeLessThan(1e-3);
    };
    nearExactly(
      derived.bodyRepresentations[bossId]?.volume,
      plateVolume + Math.PI * 12 * 12 * 15
    );
    nearExactly(
      grown.bodyRepresentations[bossId]?.volume,
      plateVolume + Math.PI * 15 * 15 * 15
    );

    // The wall itself must read back at the new radius, not merely enclose
    // more volume.
    const grownWall = grown.bodyRepresentations[bossId]?.topology?.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(grownWall?.geometry?.radius).toBeCloseTo(15, 4);
  });

  it('imports STEP with complete exact topology', async () => {
    const source = addPrimitiveFeature(
      createProjectDocument('Source', toUserId('user_exact')),
      {
        name: 'Source box',
        primitiveKind: 'box',
        dimensions: { width: 7, height: 8, depth: 9 }
      }
    );
    const step = await adapter.exportStep(source, [source.bodyOrder[0]!]);
    const base = createProjectDocument('Import', toUserId('user_exact'));
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.importStep({
        name: 'Imported box',
        artifactId: 'artifact_test',
        sourceName: 'box.step',
        stepText: step
      })
    );

    const derived = await adapter.syncDocument(manager.document);
    const body = Object.values(derived.bodyRepresentations)[0];
    expect(body?.source).toBe('imported-step');
    expect(body?.volume).toBeCloseTo(504, 4);
    expect(body?.topology?.faces).toHaveLength(6);
    expect(
      body?.topology?.faces.reduce(
        (total, face) => total + face.triangleCount,
        0
      )
    ).toBe((body?.mesh.indices.length ?? 0) / 3);
    expect(body?.topology?.edges).toHaveLength(12);
    expect(derived.warnings).toEqual([]);

    const moved = transformBody(manager.document, {
      name: 'Move imported STEP',
      targetBodyId: manager.document.bodyOrder[0]!,
      translation: { x: 5, y: 6, z: 7 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const movedBody = Object.values(
      (await adapter.syncDocument(moved)).bodyRepresentations
    )[0];
    expect(movedBody?.bbox.min.x).toBeCloseTo(5, 6);
    expect(movedBody?.bbox.min.y).toBeCloseTo(6, 6);
    expect(movedBody?.bbox.min.z).toBeCloseTo(7, 6);
    expect(movedBody?.volume).toBeCloseTo(504, 4);

    const importedEdgeHash = body?.topology?.edges[0]?.hash;
    expect(importedEdgeHash).toBeTypeOf('number');
    const filleted = filletEdges(manager.document, {
      name: 'Fillet imported STEP',
      targetBodyId: manager.document.bodyOrder[0]!,
      edgeHashes: [importedEdgeHash!],
      size: 0.5
    }).document;
    const filletDerived = await adapter.syncDocument(filleted);
    const filletedBody =
      filletDerived.bodyRepresentations[filleted.bodyOrder.at(-1)!];
    expect(filletDerived.warnings).toEqual([]);
    // Z3: blending an imported edge is one of the operations the flip newly
    // sends to Remus, so pin the ANSWER, not just its direction. Rounding a
    // straight box edge of length L at radius r removes (1 - pi/4) r^2 L.
    const filletedEdge = body!.topology!.edges[0]!.points;
    const edgeLength = Math.hypot(
      filletedEdge[3]! - filletedEdge[0]!,
      filletedEdge[4]! - filletedEdge[1]!,
      filletedEdge[5]! - filletedEdge[2]!
    );
    expect(edgeLength).toBeCloseTo(7, 9);
    const analyticFilletVolume =
      504 - (1 - Math.PI / 4) * 0.5 * 0.5 * edgeLength;
    expect(analyticFilletVolume).toBeCloseTo(503.6244467862, 9);
    // The band is now the EXACT quarter cylinder, not a B-spline fitted just
    // inside it, so this asserts the closed form rather than a recorded
    // literal. The retired literal was 503.61290074080404 — 2.29e-5 relative
    // BELOW the analytic answer, because the spline undercut the true
    // surface. What is left is 2.33e-6 and is measurement, not geometry:
    // `volume()` integrates a tessellation, and refining the deflection walks
    // this body 503.62327 -> 503.62411 -> 503.62436 toward 503.62445 rather
    // than converging anywhere else. So the residue shrinks with the mesh and
    // the surface itself is exact — which is the claim the surfaceType below
    // makes directly.
    expect(
      Math.abs(filletedBody!.volume - analyticFilletVolume) /
        analyticFilletVolume
    ).toBeLessThan(5e-6);
    // One edge rounded: six box faces plus the blend band, twelve box edges
    // plus the three the band introduces.
    expect(filletedBody?.topology?.faces).toHaveLength(7);
    expect(filletedBody?.topology?.edges).toHaveLength(15);
    // The band is the one non-planar face, and it is an analytic cylinder of
    // exactly the requested radius sitting on the rounded edge.
    const band = filletedBody!.topology!.faces.filter(
      (face) => face.geometry?.surfaceType !== 'plane'
    );
    expect(band).toHaveLength(1);
    expect(band[0]!.geometry?.surfaceType).toBe('cylinder');
    expect(band[0]!.geometry?.radius).toBeCloseTo(0.5, 9);
    expect(band[0]!.geometry?.axialLength).toBeCloseTo(edgeLength, 9);
    expect(manager.document.commandLog[0]?.kind).toBe('import.step');
  });

  it('measures and resizes an imported exact through hole in both directions', async () => {
    const withOuter = addPrimitiveFeature(
      createProjectDocument('Through-hole source', toUserId('user_exact')),
      {
        name: 'Outer cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 15, height: 10 }
      }
    );
    const outerId = withOuter.bodyOrder.at(-1)!;
    const withTool = addPrimitiveFeature(withOuter, {
      name: 'Hole tool',
      primitiveKind: 'cylinder',
      dimensions: { radius: 4, height: 20 }
    });
    const toolId = withTool.bodyOrder.at(-1)!;
    const positioned = transformBody(withTool, {
      name: 'Pass tool through part',
      targetBodyId: toolId,
      translation: { x: 0, y: 0, z: -5 }
    }).document;
    const sourceManager = new CommandManager(positioned);
    const source = sourceManager.execute(
      commandFactories.booleanBodies({
        name: 'Tube',
        operation: 'subtract',
        targetBodyIds: [outerId, toolId]
      })
    );
    const sourceBodyId = source.bodyOrder.at(-1)!;
    const step = await adapter.exportStep(source, [sourceBodyId]);

    const base = createProjectDocument('Direct edit', toUserId('user_exact'));
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.importStep({
        name: 'Imported tube',
        artifactId: 'artifact_through_hole',
        sourceName: 'tube.step',
        stepText: step
      })
    );
    const importedBodyId = manager.document.bodyOrder[0]!;
    const imported = await adapter.syncDocument(manager.document);
    const recognizedHoles = imported.bodyRepresentations[
      importedBodyId
    ]?.topology?.faces.filter(
      (face) => face.geometry?.featureType === 'through-hole'
    );
    const hole = imported.bodyRepresentations[
      importedBodyId
    ]?.topology?.faces.find(
      (face) => face.geometry?.featureType === 'through-hole'
    );

    expect(recognizedHoles).toHaveLength(1);
    expect(hole?.geometry).toMatchObject({
      surfaceType: 'cylinder',
      radius: 4,
      diameter: 8,
      axialLength: 10,
      editableDimension: 'diameter'
    });
    expect(hole?.geometry?.area).toBeCloseTo(Math.PI * 8 * 10, 4);

    manager.execute(
      commandFactories.setParameter({
        name: 'imported_hole_diameter',
        expression: '8'
      })
    );
    manager.execute(
      commandFactories.directEditBody({
        name: 'Parameterize through hole',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'resize-through-hole',
          faceHash: hole!.hash,
          sourceDiameter: 8,
          sourceAxisStart: hole!.geometry!.axisStart!,
          sourceAxisEnd: hole!.geometry!.axisEnd!,
          diameter: 'imported_hole_diameter',
          parameterBinding: true
        }
      })
    );
    const bound = await adapter.syncDocument(manager.document);
    expect(bound.warnings).toEqual([]);
    expect(
      bound.bodyRepresentations[importedBodyId]?.topology?.faces.find(
        (face) => face.geometry?.featureType === 'through-hole'
      )?.geometry?.diameter
    ).toBeCloseTo(8, 6);

    manager.execute(
      commandFactories.setParameter({
        name: 'imported_hole_diameter',
        expression: '12'
      })
    );
    const enlarged = await adapter.syncDocument(manager.document);
    const enlargedBody = enlarged.bodyRepresentations[importedBodyId]!;
    const enlargedHole = enlargedBody.topology?.faces.find(
      (face) => face.geometry?.featureType === 'through-hole'
    );
    expect(enlarged.warnings).toEqual([]);
    expect(enlargedHole?.geometry?.diameter).toBeCloseTo(12, 6);
    expect(enlargedBody.volume).toBeCloseTo(
      Math.PI * (15 ** 2 - 6 ** 2) * 10,
      4
    );

    manager.execute(
      commandFactories.directEditBody({
        name: 'Shrink through hole',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'resize-through-hole',
          faceHash: enlargedHole!.hash,
          sourceDiameter: 12,
          sourceAxisStart: enlargedHole!.geometry!.axisStart!,
          sourceAxisEnd: enlargedHole!.geometry!.axisEnd!,
          diameter: 4
        }
      })
    );
    const shrunk = await adapter.syncDocument(manager.document);
    const shrunkBody = shrunk.bodyRepresentations[importedBodyId]!;
    const shrunkHole = shrunkBody.topology?.faces.find(
      (face) => face.geometry?.featureType === 'through-hole'
    );
    expect(shrunk.warnings).toEqual([]);
    expect(shrunkHole?.geometry?.diameter).toBeCloseTo(4, 6);
    expect(shrunkBody.volume).toBeCloseTo(Math.PI * (15 ** 2 - 2 ** 2) * 10, 4);

    const editedStep = await adapter.exportStep(manager.document, [
      importedBodyId
    ]);
    await expect(adapter.inspectStep(editedStep)).resolves.toMatchObject({
      solid: true,
      valid: true
    });

    manager.execute(
      commandFactories.directEditBody({
        name: 'Remove imported feature',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'remove-face-feature',
          faceHash: shrunkHole!.hash,
          sourceSurfaceType: 'cylinder',
          sourceArea: shrunkHole!.geometry!.area,
          sourceCenter: shrunkHole!.geometry!.center,
          sourceDiameter: 4,
          sourceAxisStart: shrunkHole!.geometry!.axisStart,
          sourceAxisEnd: shrunkHole!.geometry!.axisEnd
        }
      })
    );
    const removed = await adapter.syncDocument(manager.document);
    const removedBody = removed.bodyRepresentations[importedBodyId]!;
    expect(removed.warnings).toEqual([]);
    expect(removedBody.volume).toBeCloseTo(Math.PI * 15 ** 2 * 10, 4);
    expect(removedBody.faceCount).toBe(3);
    expect(
      removedBody.topology?.faces.some(
        (face) => face.geometry?.featureType === 'through-hole'
      )
    ).toBe(false);

    manager.undo();
    const restored = await adapter.syncDocument(manager.document);
    expect(
      restored.bodyRepresentations[importedBodyId]?.topology?.faces.find(
        (face) => face.geometry?.featureType === 'through-hole'
      )?.geometry?.diameter
    ).toBeCloseTo(4, 6);
    expect(
      manager.document.commandLog.slice(-2).map((entry) => entry.kind)
    ).toEqual(['parameter.set', 'feature.direct-edit']);

    manager.execute(
      commandFactories.directEditBody({
        name: 'Mismatched topology edit',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'resize-through-hole',
          faceHash: shrunkHole!.hash,
          sourceDiameter: 4,
          sourceAxisStart: {
            ...shrunkHole!.geometry!.axisStart!,
            x: shrunkHole!.geometry!.axisStart!.x + 1
          },
          sourceAxisEnd: shrunkHole!.geometry!.axisEnd!,
          diameter: 6
        }
      })
    );
    const mismatched = await adapter.syncDocument(manager.document);
    expect(mismatched.warnings).toContain(
      'Feature "Mismatched topology edit": Selected face no longer matches its recorded hole axis.'
    );
    expect(mismatched.bodyRepresentations[importedBodyId]?.volume).toBeCloseTo(
      Math.PI * (15 ** 2 - 2 ** 2) * 10,
      4
    );
  });

  it('resizes and removes a through hole against its closed form at every stage', async () => {
    const withOuter = addPrimitiveFeature(
      createProjectDocument('Cross-kernel hole', toUserId('user_direct_edit')),
      {
        name: 'Outer cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 15, height: 10 }
      }
    );
    const outerId = withOuter.bodyOrder.at(-1)!;
    const withTool = addPrimitiveFeature(withOuter, {
      name: 'Hole tool',
      primitiveKind: 'cylinder',
      dimensions: { radius: 4, height: 20 }
    });
    const toolId = withTool.bodyOrder.at(-1)!;
    const positioned = transformBody(withTool, {
      name: 'Pass tool through part',
      targetBodyId: toolId,
      translation: { x: 0, y: 0, z: -5 }
    }).document;
    const tube = new CommandManager(positioned).execute(
      commandFactories.booleanBodies({
        name: 'Tube',
        operation: 'subtract',
        targetBodyIds: [outerId, toolId]
      })
    );
    const bodyId = tube.bodyOrder.at(-1)!;

    /**
     * Drive the edit sequence, always addressing the hole through the
     * adapter's own face fingerprints and its own recorded source
     * measurements, so each reading is a statement about the geometry
     * produced rather than about a hash being stable.
     */
    async function editSequence(kernelAdapter: ExactKernelAdapter) {
      const manager = new CommandManager(tube);
      const readings: {
        volume: number;
        faceCount: number;
        holeDiameter?: number;
        holeCount: number;
      }[] = [];
      const read = async () => {
        const derived = await kernelAdapter.syncDocument(manager.document);
        expect(derived.warnings).toEqual([]);
        const body = derived.bodyRepresentations[bodyId]!;
        const holes = (body.topology?.faces ?? []).filter(
          (face) => face.geometry?.featureType === 'through-hole'
        );
        readings.push({
          volume: body.volume,
          faceCount: body.faceCount,
          holeDiameter: holes[0]?.geometry?.diameter,
          holeCount: holes.length
        });
        return holes[0];
      };

      const source = await read();
      expect(source?.geometry).toMatchObject({
        surfaceType: 'cylinder',
        editableDimension: 'diameter'
      });

      for (const diameter of [12, 4]) {
        const hole = (await read())!;
        manager.execute(
          commandFactories.directEditBody({
            name: `Resize to ${diameter}`,
            targetBodyId: bodyId,
            operation: {
              kind: 'resize-through-hole',
              faceHash: hole.hash,
              sourceDiameter: hole.geometry!.diameter!,
              sourceAxisStart: hole.geometry!.axisStart!,
              sourceAxisEnd: hole.geometry!.axisEnd!,
              diameter
            }
          })
        );
      }

      const remaining = (await read())!;
      manager.execute(
        commandFactories.directEditBody({
          name: 'Remove the hole',
          targetBodyId: bodyId,
          operation: {
            kind: 'remove-face-feature',
            faceHash: remaining.hash,
            sourceSurfaceType: 'cylinder',
            sourceArea: remaining.geometry!.area,
            sourceCenter: remaining.geometry!.center,
            sourceDiameter: remaining.geometry!.diameter,
            sourceAxisStart: remaining.geometry!.axisStart,
            sourceAxisEnd: remaining.geometry!.axisEnd
          }
        })
      );
      await read();
      return readings;
    }

    const remus = new RemusKernelAdapter();
    try {
      const readings = await editSequence(remus);

      // Every stage: the source tube, the same tube re-read before each edit,
      // the 12 mm hole, the 4 mm hole and finally the filled body. Each
      // volume is the closed form of the intended solid, which says the edit
      // landed on the right geometry rather than merely that it succeeded.
      const expected = [
        { hole: 8, radius: 4 },
        { hole: 8, radius: 4 },
        { hole: 12, radius: 6 },
        { hole: 4, radius: 2 },
        { hole: undefined, radius: 0 }
      ];
      expect(readings).toHaveLength(expected.length);
      readings.forEach((reading, index) => {
        const stage = expected[index]!;
        expect(reading.volume).toBeCloseTo(
          Math.PI * (15 ** 2 - stage.radius ** 2) * 10,
          4
        );
        expect(reading.holeDiameter).toBe(
          stage.hole === undefined ? undefined : stage.hole
        );
      });
      expect(readings.at(-1)).toMatchObject({ faceCount: 3, holeCount: 0 });
    } finally {
      remus.dispose();
    }
  }, 60_000);

  it('refuses Remus through-hole edits it cannot prove correct', async () => {
    const withOuter = addPrimitiveFeature(
      createProjectDocument('Refusal source', toUserId('user_direct_edit')),
      {
        name: 'Outer cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 15, height: 10 }
      }
    );
    const outerId = withOuter.bodyOrder.at(-1)!;
    const withTool = addPrimitiveFeature(withOuter, {
      name: 'Hole tool',
      primitiveKind: 'cylinder',
      dimensions: { radius: 4, height: 20 }
    });
    const toolId = withTool.bodyOrder.at(-1)!;
    const positioned = transformBody(withTool, {
      name: 'Pass tool through part',
      targetBodyId: toolId,
      translation: { x: 0, y: 0, z: -5 }
    }).document;
    const tube = new CommandManager(positioned).execute(
      commandFactories.booleanBodies({
        name: 'Tube',
        operation: 'subtract',
        targetBodyIds: [outerId, toolId]
      })
    );
    const bodyId = tube.bodyOrder.at(-1)!;

    const remus = new RemusKernelAdapter();
    try {
      const derived = await remus.syncDocument(tube);
      const faces = derived.bodyRepresentations[bodyId]!.topology!.faces;
      const bore = faces.find(
        (face) => face.geometry?.featureType === 'through-hole'
      )!;
      // The tube's outer wall shares the bore's void axis and open ends, so
      // it is exactly the face the classifier has to keep out.
      const outerWall = faces.find(
        (face) =>
          face.geometry?.surfaceType === 'cylinder' &&
          face.geometry.featureType === undefined
      )!;
      expect(outerWall.geometry?.radius).toBeCloseTo(15, 6);
      const cap = faces.find((face) => face.geometry?.surfaceType === 'plane')!;

      const refusals: { name: string; operation: DirectEditOperation }[] = [
        {
          name: 'Outer wall is not a hole',
          operation: {
            kind: 'resize-through-hole',
            faceHash: outerWall.hash,
            sourceDiameter: outerWall.geometry!.diameter!,
            sourceAxisStart: outerWall.geometry!.axisStart!,
            sourceAxisEnd: outerWall.geometry!.axisEnd!,
            diameter: 20
          }
        },
        {
          name: 'Stale diameter',
          operation: {
            kind: 'resize-through-hole',
            faceHash: bore.hash,
            sourceDiameter: 9,
            sourceAxisStart: bore.geometry!.axisStart!,
            sourceAxisEnd: bore.geometry!.axisEnd!,
            diameter: 6
          }
        },
        {
          name: 'Stale axis',
          operation: {
            kind: 'resize-through-hole',
            faceHash: bore.hash,
            sourceDiameter: bore.geometry!.diameter!,
            sourceAxisStart: {
              ...bore.geometry!.axisStart!,
              x: bore.geometry!.axisStart!.x + 1
            },
            sourceAxisEnd: bore.geometry!.axisEnd!,
            diameter: 6
          }
        },
        {
          name: 'Diameter breaks the body',
          operation: {
            kind: 'resize-through-hole',
            faceHash: bore.hash,
            sourceDiameter: bore.geometry!.diameter!,
            sourceAxisStart: bore.geometry!.axisStart!,
            sourceAxisEnd: bore.geometry!.axisEnd!,
            diameter: 40
          }
        },
        {
          name: 'Unchanged diameter',
          operation: {
            kind: 'resize-through-hole',
            faceHash: bore.hash,
            sourceDiameter: bore.geometry!.diameter!,
            sourceAxisStart: bore.geometry!.axisStart!,
            sourceAxisEnd: bore.geometry!.axisEnd!,
            diameter: 8
          }
        },
        {
          name: 'Defeature needs planar faces',
          operation: {
            kind: 'remove-face-feature',
            faceHash: cap.hash,
            sourceSurfaceType: 'plane',
            sourceArea: cap.geometry!.area,
            sourceCenter: cap.geometry!.center
          }
        }
      ];

      const messages: string[] = [];
      for (const refusal of refusals) {
        const manager = new CommandManager(tube);
        manager.execute(
          commandFactories.directEditBody({
            name: refusal.name,
            targetBodyId: bodyId,
            operation: refusal.operation
          })
        );
        const failed = await remus.syncDocument(manager.document);
        expect(failed.warnings).toHaveLength(1);
        messages.push(failed.warnings[0]!);
        // A refused edit leaves the body exactly as the history built it.
        expect(failed.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
          Math.PI * (15 ** 2 - 4 ** 2) * 10,
          4
        );
      }

      expect(messages).toEqual([
        'Feature "Outer wall is not a hole": The selected cylindrical face has material only on its inside, so it is an external wall rather than a bore.',
        'Feature "Stale diameter": Selected face no longer matches its recorded source diameter.',
        'Feature "Stale axis": Selected face no longer matches its recorded hole axis.',
        expect.stringContaining(
          'Feature "Diameter breaks the body": Through-hole diameter 40 does not fit this body'
        ),
        'Feature "Unchanged diameter": Through-hole diameter must differ from its current diameter.',
        'Feature "Defeature needs planar faces": Removing a plane face needs Remus\'s defeature operation, which only supports bodies whose every remaining face is planar; this body still has cylinder faces.'
      ]);
    } finally {
      remus.dispose();
    }
  }, 60_000);

  it('defeatures a chamfer away and names the removals it cannot do', async () => {
    // Defeature removes a face by extending the faces around it until they
    // close again, so it is defined exactly when three of those faces meet in
    // a corner. Both halves of that are asserted here: the case that HAS a
    // corner must reconstruct the pre-chamfer solid exactly, and the case that
    // does not must be refused by name with the body left untouched.
    //
    // This used to assert only the refusal, and a much vaguer one: the kernel
    // reassembled a closed-looking body with the wrong walls and the adapter
    // caught it after the fact with 'did not produce a valid solid'. The
    // rewritten defeature refuses the unsupported configuration up front and
    // says which configuration it is. The strict `validate_solid` gate after
    // the call is deliberately still there — it is defence in depth, not the
    // thing that fails here any more.
    const plate = addPrimitiveFeature(
      createProjectDocument('Defeature gate', toUserId('user_direct_edit')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 30, depth: 10 }
      }
    );
    const plateId = plate.bodyOrder[0]!;
    const remus = new RemusKernelAdapter();
    try {
      const derived = await remus.syncDocument(plate);
      const plateBody = derived.bodyRepresentations[plateId]!;

      // --- the supported case: undo a chamfer -----------------------------
      const chamfered = chamferEdges(plate, {
        name: 'Break an edge',
        targetBodyId: plateId,
        edgeHashes: [plateBody.topology!.edges[0]!.hash],
        size: 3
      }).document;
      const chamferBodyId = chamfered.bodyOrder.at(-1)!;
      const chamferDerived = await remus.syncDocument(chamfered);
      const chamferBody = chamferDerived.bodyRepresentations[chamferBodyId]!;
      expect(chamferDerived.warnings).toEqual([]);
      // A 45-degree chamfer of leg 3 along a 30 mm edge removes half of a
      // 3x3 square prism.
      expect(chamferBody.volume).toBeCloseTo(9000 - 0.5 * 3 * 3 * 30, 6);
      expect(chamferBody.faceCount).toBe(7);
      const chamferFace = chamferBody.topology!.faces.find(
        (face) =>
          Math.abs((face.geometry?.area ?? 0) - 3 * Math.SQRT2 * 30) < 1e-3
      )!;
      expect(chamferFace).toBeTruthy();

      const undone = new CommandManager(chamfered);
      undone.execute(
        commandFactories.directEditBody({
          name: 'Remove the chamfer',
          targetBodyId: chamferBodyId,
          operation: {
            kind: 'remove-face-feature',
            faceHash: chamferFace.hash,
            sourceSurfaceType: 'plane',
            sourceArea: chamferFace.geometry!.area,
            sourceCenter: chamferFace.geometry!.center
          }
        })
      );
      const restored = await remus.syncDocument(undone.document);
      const restoredBody = restored.bodyRepresentations[chamferBodyId]!;
      expect(restored.warnings).toEqual([]);
      // The closed form is the plate the chamfer was cut from: the three
      // faces around the removed patch extend back to their original corner,
      // so this is exact rather than approximate.
      expect(restoredBody.volume).toBeCloseTo(9000, 9);
      expect(restoredBody.faceCount).toBe(6);
      expect(
        isClosedConsistentlyOrientedMesh(
          inspectTriangleMeshClosure(
            restoredBody.mesh.vertices,
            restoredBody.mesh.indices
          )
        )
      ).toBe(true);
      expect(restoredBody.bbox.min.x).toBeCloseTo(0, 9);
      expect(restoredBody.bbox.min.y).toBeCloseTo(0, 9);
      expect(restoredBody.bbox.min.z).toBeCloseTo(0, 9);
      expect(restoredBody.bbox.max.x).toBeCloseTo(30, 9);
      expect(restoredBody.bbox.max.y).toBeCloseTo(30, 9);
      expect(restoredBody.bbox.max.z).toBeCloseTo(10, 9);

      // --- the unsupported case: remove a face of a plain box -------------
      const target = plateBody.topology!.faces.find(
        (face) => Math.abs((face.geometry?.area ?? 0) - 900) < 1e-6
      )!;
      const manager = new CommandManager(plate);
      manager.execute(
        commandFactories.directEditBody({
          name: 'Remove a plate face',
          targetBodyId: plateId,
          operation: {
            kind: 'remove-face-feature',
            faceHash: target.hash,
            sourceSurfaceType: 'plane',
            sourceArea: target.geometry!.area,
            sourceCenter: target.geometry!.center
          }
        })
      );
      const failed = await remus.syncDocument(manager.document);
      expect(failed.warnings).toEqual([
        'Feature "Remove a plate face": Removing the selected face failed: ' +
          'defeature: unsupported configuration: no three faces around the ' +
          'removed patch meet in a corner; the adjacent faces are parallel ' +
          'and would have to be merged rather than extended.'
      ]);
      expect(failed.bodyRepresentations[plateId]!.volume).toBeCloseTo(9000, 4);
    } finally {
      remus.dispose();
    }
  }, 60_000);

  it('offsets a planar face of an imported STEP body in both directions', async () => {
    const source = addPrimitiveFeature(
      createProjectDocument('Offset source', toUserId('user_exact')),
      {
        name: 'Beam',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const step = await adapter.exportStep(source, [source.bodyOrder[0]!]);

    const base = createProjectDocument(
      'Imported offset',
      toUserId('user_exact')
    );
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.importStep({
        name: 'Imported beam',
        artifactId: 'artifact_offset_face',
        sourceName: 'beam.step',
        stepText: step
      })
    );
    const importedBodyId = manager.document.bodyOrder[0]!;
    const imported = await adapter.syncDocument(manager.document);
    const importedBody = imported.bodyRepresentations[importedBodyId];
    expect(importedBody?.volume).toBeCloseTo(6000, 4);
    // The box is corner-origin, so the top face's center sits at z = depth.
    const topFace = importedBody?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs(face.geometry.center.z - 30) < 1e-6
    );
    expect(topFace).toBeTruthy();
    expect(topFace?.geometry?.area).toBeCloseTo(200, 4);

    manager.execute(
      commandFactories.directEditBody({
        name: 'Raise imported top face',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'offset-face',
          faceHash: topFace!.hash,
          sourceSurfaceType: 'plane',
          sourceArea: topFace!.geometry!.area,
          sourceCenter: topFace!.geometry!.center,
          sourceNormal: { x: 0, y: 0, z: 1 },
          offset: 5
        }
      })
    );
    const raised = await adapter.syncDocument(manager.document);
    const raisedBody = raised.bodyRepresentations[importedBodyId];
    expect(raised.warnings).toEqual([]);
    expect(raisedBody?.volume).toBeCloseTo(10 * 20 * 35, 4);
    // A clean offset keeps the box a box.
    expect(raisedBody?.faceCount).toBe(6);
    const raisedTop = raisedBody?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs(face.geometry.center.z - 35) < 1e-6
    );
    expect(raisedTop).toBeTruthy();

    manager.execute(
      commandFactories.directEditBody({
        name: 'Sink imported top face',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'offset-face',
          faceHash: raisedTop!.hash,
          sourceSurfaceType: 'plane',
          sourceArea: raisedTop!.geometry!.area,
          sourceCenter: raisedTop!.geometry!.center,
          sourceNormal: { x: 0, y: 0, z: 1 },
          offset: -10
        }
      })
    );
    const sunk = await adapter.syncDocument(manager.document);
    expect(sunk.warnings).toEqual([]);
    expect(sunk.bodyRepresentations[importedBodyId]?.volume).toBeCloseTo(
      10 * 20 * 25,
      4
    );

    const editedStep = await adapter.exportStep(manager.document, [
      importedBodyId
    ]);
    await expect(adapter.inspectStep(editedStep)).resolves.toMatchObject({
      solid: true,
      valid: true
    });

    // Cutting deeper than the body is tall would leave nothing; the volume
    // gate fails closed and the body keeps building at its prior size.
    const sunkTop = sunk.bodyRepresentations[
      importedBodyId
    ]?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs(face.geometry.center.z - 25) < 1e-6
    );
    expect(sunkTop).toBeTruthy();
    manager.execute(
      commandFactories.directEditBody({
        name: 'Sink past the floor',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'offset-face',
          faceHash: sunkTop!.hash,
          sourceSurfaceType: 'plane',
          sourceArea: sunkTop!.geometry!.area,
          sourceCenter: sunkTop!.geometry!.center,
          sourceNormal: { x: 0, y: 0, z: 1 },
          offset: -40
        }
      })
    );
    const overcut = await adapter.syncDocument(manager.document);
    // Z3 pin. OpenCascade answered this with a generic "Offsetting the
    // selected face does not produce a valid solid."; Remus names the
    // boolean that came back empty. Both fail closed, which is the property
    // that matters — an overcut must never yield a body.
    expect(overcut.warnings).toEqual([
      'Feature "Sink past the floor": empty result: Cut with target fully ' +
        'contained in tool'
    ]);
    expect(overcut.bodyRepresentations[importedBodyId]?.volume).toBeCloseTo(
      10 * 20 * 25,
      4
    );
    expect(overcut.bodyRepresentations[importedBodyId]?.faceCount).toBe(6);
  });

  it('resizes an imported analytic blend as replayable exact history', async () => {
    const sourceDocument = addPrimitiveFeature(
      createProjectDocument('Blend source', toUserId('user_exact')),
      {
        name: 'Blend block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    const sourceDerived = await adapter.syncDocument(sourceDocument);
    const sourceBodyId = sourceDocument.bodyOrder[0]!;
    const edgeHash = sourceDerived.bodyRepresentations[
      sourceBodyId
    ]?.topology?.edges.find((edge) => edge.displayRole !== 'seam')?.hash;
    expect(edgeHash).toBeTypeOf('number');
    const filleted = filletEdges(sourceDocument, {
      name: 'Source fillet',
      targetBodyId: sourceBodyId,
      edgeHashes: [edgeHash!],
      size: 3
    }).document;
    const filletedBodyId = filleted.bodyOrder.at(-1)!;
    const stepText = await adapter.exportStep(filleted, [filletedBodyId]);
    const manager = new CommandManager(
      createProjectDocument('Imported blend', toUserId('user_exact'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Analytic fillet plate',
        artifactId: 'artifact_imported_blend',
        sourceName: 'remus-fillet.step',
        stepText
      })
    );
    const bodyId = manager.document.bodyOrder[0]!;
    const imported = await adapter.syncDocument(manager.document);
    const source = imported.bodyRepresentations[bodyId]?.topology?.faces.find(
      (face) => Math.abs((face.geometry?.blendRadius ?? 0) - 3) < 1e-6
    );
    expect(source).toBeTruthy();
    const geometry = source!.geometry!;
    const center =
      geometry.surfaceType === 'torus'
        ? geometry.torusCenter
        : geometry.axisStart && geometry.axisEnd
          ? {
              x: (geometry.axisStart.x + geometry.axisEnd.x) / 2,
              y: (geometry.axisStart.y + geometry.axisEnd.y) / 2,
              z: (geometry.axisStart.z + geometry.axisEnd.z) / 2
            }
          : undefined;
    const axis =
      geometry.surfaceType === 'torus'
        ? geometry.axis
        : geometry.axisStart && geometry.axisEnd
          ? {
              x: geometry.axisEnd.x - geometry.axisStart.x,
              y: geometry.axisEnd.y - geometry.axisStart.y,
              z: geometry.axisEnd.z - geometry.axisStart.z
            }
          : undefined;
    expect(
      geometry.surfaceType === 'torus' || geometry.surfaceType === 'cylinder'
    ).toBe(true);
    expect(center).toBeTruthy();
    expect(axis).toBeTruthy();

    manager.execute(
      commandFactories.directEditBody({
        name: 'Resize imported blend',
        targetBodyId: bodyId,
        operation: {
          kind: 'resize-blend',
          faceHash: source!.hash,
          ...(source!.reference ? { faceReference: source!.reference } : {}),
          surfaceClass: geometry.surfaceType as 'torus' | 'cylinder',
          recordedRadius: geometry.blendRadius!,
          recordedCenter: center!,
          recordedAxis: axis!,
          newRadius: 2
        }
      })
    );

    const first = await adapter.syncDocument(manager.document);
    const second = await adapter.syncDocument(manager.document);
    expect(first.warnings).toEqual([]);
    expect(second.warnings).toEqual([]);
    const firstBody = first.bodyRepresentations[bodyId];
    const secondBody = second.bodyRepresentations[bodyId];
    const editFeature = listFeaturesInOrder(manager.document).at(-1)!;
    const resizedFace = resolveImportedBlendFace(
      firstBody?.topology?.faces ?? [],
      source!,
      String(editFeature.featureId)
    );
    expect(resizedFace?.geometry?.blendRadius).toBeCloseTo(2, 8);
    expect(resizedFace?.reference?.producingFeatureId).toBe(
      editFeature.featureId
    );
    expect(
      firstBody?.topology?.faces.some(
        (face) => Math.abs((face.geometry?.blendRadius ?? 0) - 2) < 1e-6
      )
    ).toBe(true);
    expect(secondBody?.faceCount).toBe(firstBody?.faceCount);
    expect(secondBody?.volume).toBeCloseTo(firstBody!.volume, 8);
  }, 60_000);

  it('offsets a planar face on the exact sample bracket', async () => {
    const step = readFileSync(
      resolve('samples/parametric-bracket.step'),
      'utf8'
    );
    const base = createProjectDocument(
      'Bracket offset',
      toUserId('user_exact')
    );
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.importStep({
        name: 'Bracket',
        artifactId: 'artifact_bracket_offset',
        sourceName: 'parametric-bracket.step',
        stepText: step
      })
    );
    const bodyId = manager.document.bodyOrder[0]!;
    const imported = await adapter.syncDocument(manager.document);
    const body = imported.bodyRepresentations[bodyId];
    const volumeBefore = body?.volume ?? 0;
    const target = body?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.x ?? 0) < -0.9 &&
        Math.abs(face.geometry.center.x) < 1e-6 &&
        Math.abs((face.geometry.area ?? 0) - 240) < 1e-6
    );
    expect(target).toBeTruthy();

    manager.execute(
      commandFactories.directEditBody({
        name: 'Offset bracket face',
        targetBodyId: bodyId,
        operation: {
          kind: 'offset-face',
          faceHash: target!.hash,
          sourceSurfaceType: 'plane',
          sourceArea: target!.geometry!.area,
          sourceCenter: target!.geometry!.center,
          sourceNormal: target!.geometry!.normal!,
          offset: 3
        }
      })
    );
    const edited = await adapter.syncDocument(manager.document);
    expect(edited.warnings).toEqual([]);
    expect(edited.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      volumeBefore + 3 * target!.geometry!.area,
      3
    );
  }, 60_000);

  it('builds selected-edge fillet and chamfer features', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Edge modifiers', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    const baseDerived = await adapter.syncDocument(base);
    const edgeHash = Object.values(baseDerived.bodyRepresentations)[0]?.topology
      ?.edges[0]?.hash;
    expect(edgeHash).toBeTypeOf('number');
    expect(edgeHash).not.toBe(1);
    const repeated = await adapter.syncDocument(base);
    expect(
      Object.values(repeated.bodyRepresentations)[0]?.topology?.edges.map(
        (edge) => edge.hash
      )
    ).toEqual(
      Object.values(baseDerived.bodyRepresentations)[0]?.topology?.edges.map(
        (edge) => edge.hash
      )
    );

    const filleted = filletEdges(base, {
      name: 'Fillet',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [edgeHash!],
      size: 2
    }).document;
    const filletDerived = await adapter.syncDocument(filleted);
    const filletBody =
      filletDerived.bodyRepresentations[filleted.bodyOrder.at(-1)!];
    expect(filletDerived.warnings).toEqual([]);
    expect(filletBody?.volume).toBeLessThan(8000);
    expect(filletBody?.faceCount).toBeGreaterThan(6);

    const chamfered = chamferEdges(base, {
      name: 'Chamfer',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [edgeHash!],
      size: 2
    }).document;
    const chamferDerived = await adapter.syncDocument(chamfered);
    const chamferBody =
      chamferDerived.bodyRepresentations[chamfered.bodyOrder.at(-1)!];
    expect(chamferDerived.warnings).toEqual([]);
    expect(chamferBody?.volume).toBeLessThan(8000);
    expect(chamferBody?.faceCount).toBeGreaterThan(6);
  });

  it('builds distance-angle chamfers with the exact bevel volume', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Angled chamfer', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    const baseDerived = await adapter.syncDocument(base);
    const edgeHash = Object.values(baseDerived.bodyRepresentations)[0]?.topology
      ?.edges[0]?.hash;
    expect(edgeHash).toBeTypeOf('number');

    // Distance 2 on the first face, 60° toward the second: the removed
    // wedge has legs 2 and 2·tan(60°), so its volume is closed-form.
    const angled = chamferEdges(base, {
      name: 'Angled chamfer',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [edgeHash!],
      size: 2,
      angleDeg: 60
    }).document;
    const angledDerived = await adapter.syncDocument(angled);
    const angledBody =
      angledDerived.bodyRepresentations[angled.bodyOrder.at(-1)!];
    expect(angledDerived.warnings).toEqual([]);
    expect(angledBody?.volume).toBeCloseTo(
      8000 - ((2 * 2 * Math.tan(Math.PI / 3)) / 2) * 20,
      6
    );

    // An explicit 45° is the symmetric chamfer's geometry.
    const explicit45 = chamferEdges(base, {
      name: 'Explicit 45',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [edgeHash!],
      size: 2,
      angleDeg: 45
    }).document;
    const explicitDerived = await adapter.syncDocument(explicit45);
    const explicitBody =
      explicitDerived.bodyRepresentations[explicit45.bodyOrder.at(-1)!];
    expect(explicitDerived.warnings).toEqual([]);
    expect(explicitBody?.volume).toBeCloseTo(8000 - ((2 * 2) / 2) * 20, 6);

    // Out-of-range angles are a feature error, not a kernel crash.
    const rejected = chamferEdges(base, {
      name: 'Too steep',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [edgeHash!],
      size: 2,
      angleDeg: 90
    }).document;
    const rejectedDerived = await adapter.syncDocument(rejected);
    expect(rejectedDerived.warnings.join('\n')).toMatch(
      /strictly between 0 and 90/
    );
  });

  // Convex cap-rim fillets on a plain cylinder. This began life as the test
  // for an adapter workaround that rebuilt the rims from a 64-segment revolved
  // profile, because the kernel refused the blend at f/r >= 0.5. The kernel
  // builds the rim torus itself at every 0 < f < r now, the workaround is
  // gone, and these are kernel regressions: they pin the behaviour the
  // deletion depends on.
  //
  // Volume is checked against Pappus, which is independent of the kernel.
  // Surface types are checked because the failure mode that matters here is a
  // silent downgrade from an analytic torus band to a faceted approximation —
  // that keeps the volume and loses the geometry.
  const rimFilletVolume = (
    radius: number,
    height: number,
    fillet: number,
    rims: number
  ): number => {
    const squareMoment = fillet ** 2 * (radius - fillet / 2);
    const quarterCircleMoment =
      ((Math.PI * fillet ** 2) / 4) *
      (radius - fillet + (4 * fillet) / (3 * Math.PI));
    return (
      Math.PI * radius ** 2 * height -
      rims * (2 * Math.PI * (squareMoment - quarterCircleMoment))
    );
  };

  const surfaceTypeCounts = (
    body:
      | { topology?: { faces: { geometry?: { surfaceType?: string } }[] } }
      | undefined
  ): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const face of body?.topology?.faces ?? []) {
      const type = face.geometry?.surfaceType ?? 'unknown';
      counts[type] = (counts[type] ?? 0) + 1;
    }
    return counts;
  };

  it('fillets both rims of a small circular sketch extrusion together', async () => {
    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument(
        'Small extruded cylinder fillet',
        toUserId('user_exact')
      ),
      {
        name: 'Circle',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [{ objectKind: 'circle', radius: 2, centerX: 0, centerY: 0 }]
      }
    );
    const { document: extruded, bodyId } = extrudeSketch(withSketch, {
      name: 'Extrude',
      sketchId,
      distance: 6
    });
    const baseDerived = await adapter.syncDocument(extruded);
    const baseBody = baseDerived.bodyRepresentations[bodyId]!;
    const rimHashes =
      baseBody.topology?.edges
        .filter((edge) => edge.displayRole !== 'seam')
        .map((edge) => edge.hash) ?? [];

    expect(rimHashes).toHaveLength(2);
    // f/r is exactly 0.5 here — the radius at which the kernel used to throw
    // `partial-result` and hand the case to the workaround.
    const filletRadius = 1;
    const filleted = filletEdges(extruded, {
      name: 'Both rim fillets',
      targetBodyId: bodyId,
      edgeHashes: rimHashes,
      size: filletRadius
    }).document;
    const derived = await adapter.syncDocument(filleted);
    const body = derived.bodyRepresentations[filleted.bodyOrder.at(-1)!];
    expect(derived.warnings).toEqual([]);
    expect(body?.volume).toBeCloseTo(rimFilletVolume(2, 6, filletRadius, 2), 2);
    expect(body?.bbox).toEqual(baseBody.bbox);
    // One wall, two caps, two rim bands — all analytic.
    expect(body?.faceCount).toBe(5);
    expect(surfaceTypeCounts(body)).toEqual({
      cylinder: 1,
      plane: 2,
      torus: 2
    });
  });

  it.each(['fillet', 'chamfer'] as const)(
    'keeps a two-rim cylinder %s through the 4.6 to 6.4 mm radius edit',
    async (modifier) => {
      const base = addPrimitiveFeature(
        createProjectDocument(
          `Cylinder ${modifier} lineage`,
          toUserId('user_exact')
        ),
        {
          name: 'Cylinder',
          primitiveKind: 'cylinder',
          dimensions: { radius: 4.6, height: 12 }
        }
      );
      const sourceBodyId = base.bodyOrder[0]!;
      const sourceFeature = listFeaturesInOrder(base)[0]!;
      const sourceDerived = await adapter.syncDocument(base);
      const rims = sourceDerived.bodyRepresentations[
        sourceBodyId
      ]!.topology!.edges.filter((edge) => edge.displayRole !== 'seam');
      expect(rims).toHaveLength(2);
      expect(rims.every((edge) => edge.reference?.kind === 'edge')).toBe(true);

      const created =
        modifier === 'fillet'
          ? filletEdges(base, {
              name: 'Two rim fillet',
              targetBodyId: sourceBodyId,
              edgeHashes: rims.map((edge) => edge.hash),
              edgeReferences: rims.map((edge) => edge.reference!),
              size: 1
            })
          : chamferEdges(base, {
              name: 'Two rim chamfer',
              targetBodyId: sourceBodyId,
              edgeHashes: rims.map((edge) => edge.hash),
              edgeReferences: rims.map((edge) => edge.reference!),
              size: 1
            });
      const manager = new CommandManager(created.document);
      const resize = commandFactories.updateFeature(
        {
          featureId: sourceFeature.featureId,
          data: { dimensions: { radius: 6.4 } }
        },
        'Resize cylinder radius'
      );

      const resizedPrimitive = await adapter.syncDocument(resize.apply(base));
      const resizedRimHashes = resizedPrimitive.bodyRepresentations[
        sourceBodyId
      ]!.topology!.edges.filter((edge) => edge.displayRole !== 'seam').map(
        (edge) => edge.hash
      );
      expect(resizedRimHashes).not.toEqual(rims.map((edge) => edge.hash));

      const resized = manager.execute(resize);
      const resizedDerived = await adapter.syncDocument(resized);
      const result = resizedDerived.bodyRepresentations[created.bodyId];
      expect(resizedDerived.warnings).toEqual([]);
      expect(result).toBeDefined();
      expect(result!.volume).toBeGreaterThan(0);
      expect(result!.volume).toBeLessThan(Math.PI * 6.4 ** 2 * 12);

      const step = await adapter.exportStep(resized, [created.bodyId]);
      const inspection = await adapter.inspectStep(step);
      expect(inspection).toMatchObject({ solid: true, valid: true });
      expect(
        Math.abs(inspection.volume - result!.volume) / result!.volume
      ).toBeLessThan(0.01);

      const undoneDerived = await adapter.syncDocument(manager.undo());
      expect(undoneDerived.warnings).toEqual([]);
      expect(undoneDerived.bodyRepresentations[created.bodyId]).toBeDefined();
      const redoneDerived = await adapter.syncDocument(manager.redo());
      expect(redoneDerived.warnings).toEqual([]);
      expect(redoneDerived.bodyRepresentations[created.bodyId]).toBeDefined();
    }
  );

  it.each(['start', 'end'] as const)(
    'keeps the cylinder %s rim identity through a height edit',
    async (rimRole) => {
      const base = addPrimitiveFeature(
        createProjectDocument(
          `Cylinder ${rimRole} rim lineage`,
          toUserId('user_exact')
        ),
        {
          name: 'Cylinder',
          primitiveKind: 'cylinder',
          dimensions: { radius: 4.6, height: 8 }
        }
      );
      const sourceBodyId = base.bodyOrder[0]!;
      const sourceFeature = listFeaturesInOrder(base)[0]!;
      const sourceDerived = await adapter.syncDocument(base);
      const rim = sourceDerived.bodyRepresentations[
        sourceBodyId
      ]!.topology!.edges.find((edge) =>
        edge.reference?.lineageName.endsWith(`.rim.${rimRole}`)
      );
      expect(rim?.reference?.kind).toBe('edge');

      const filleted = filletEdges(base, {
        name: `${rimRole} rim fillet`,
        targetBodyId: sourceBodyId,
        edgeHashes: [rim!.hash],
        edgeReferences: [rim!.reference!],
        size: 1
      });
      const resized = commandFactories
        .updateFeature({
          featureId: sourceFeature.featureId,
          data: { dimensions: { height: 14 } }
        })
        .apply(filleted.document);
      const derived = await adapter.syncDocument(resized);
      const body = derived.bodyRepresentations[filleted.bodyId];
      const band = body?.topology?.faces.find(
        (face) => face.geometry?.surfaceType === 'torus'
      );

      expect(derived.warnings).toEqual([]);
      expect(band?.geometry).toBeDefined();
      if (rimRole === 'start') {
        expect(band!.geometry!.center.z).toBeLessThan(7);
      } else {
        expect(band!.geometry!.center.z).toBeGreaterThan(7);
      }
    }
  );

  it('resolves a resized box edge by v5 lineage and keeps legacy hash-only failure behavior', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Box edge lineage', toUserId('user_exact')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const sourceBodyId = base.bodyOrder[0]!;
    const sourceFeature = listFeaturesInOrder(base)[0]!;
    const sourceDerived = await adapter.syncDocument(base);
    const edge = sourceDerived.bodyRepresentations[
      sourceBodyId
    ]!.topology!.edges.find((candidate) =>
      candidate.reference?.lineageName.includes('primitive.box.edge.x.')
    );
    expect(edge?.reference?.kind).toBe('edge');

    const resize = commandFactories.updateFeature({
      featureId: sourceFeature.featureId,
      data: { dimensions: { width: 16 } }
    });
    const withLineage = filletEdges(base, {
      name: 'Lineage box fillet',
      targetBodyId: sourceBodyId,
      edgeHashes: [edge!.hash],
      edgeReferences: [edge!.reference!],
      size: 1
    });
    const lineageDerived = await adapter.syncDocument(
      resize.apply(withLineage.document)
    );
    expect(lineageDerived.warnings).toEqual([]);
    expect(
      lineageDerived.bodyRepresentations[withLineage.bodyId]
    ).toBeDefined();

    const legacy = filletEdges(base, {
      name: 'Legacy box fillet',
      targetBodyId: sourceBodyId,
      edgeHashes: [edge!.hash],
      size: 1
    });
    const legacyDerived = await adapter.syncDocument(
      resize.apply(legacy.document)
    );
    expect(legacyDerived.warnings).toEqual([
      'Feature "Legacy box fillet": A selected edge no longer exists. Re-select the edges and re-create this feature.'
    ]);
    expect(legacyDerived.bodyRepresentations[legacy.bodyId]).toBeUndefined();
  });

  it('fails closed when edge-modifier lineage contains duplicate claims', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Duplicate edge lineage', toUserId('user_exact')),
      {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 4.6, height: 12 }
      }
    );
    const sourceBodyId = base.bodyOrder[0]!;
    const sourceDerived = await adapter.syncDocument(base);
    const rim = sourceDerived.bodyRepresentations[
      sourceBodyId
    ]!.topology!.edges.find((edge) => edge.displayRole !== 'seam')!;
    const invalid = filletEdges(base, {
      name: 'Duplicate lineage fillet',
      targetBodyId: sourceBodyId,
      edgeHashes: [rim.hash],
      edgeReferences: [rim.reference!, rim.reference!],
      size: 1
    });
    const derived = await adapter.syncDocument(invalid.document);

    expect(derived.warnings).toEqual([
      'Feature "Duplicate lineage fillet": Edge modifier lineage contains duplicate references for one selected edge.'
    ]);
    expect(derived.bodyRepresentations[invalid.bodyId]).toBeUndefined();
  });

  it('fails closed when edge-modifier lineage omits a selected edge', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Missing edge lineage', toUserId('user_exact')),
      {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 4.6, height: 12 }
      }
    );
    const sourceBodyId = base.bodyOrder[0]!;
    const sourceDerived = await adapter.syncDocument(base);
    const rim = sourceDerived.bodyRepresentations[
      sourceBodyId
    ]!.topology!.edges.find((edge) => edge.displayRole !== 'seam')!;
    const invalid = filletEdges(base, {
      name: 'Missing lineage fillet',
      targetBodyId: sourceBodyId,
      edgeHashes: [rim.hash],
      edgeReferences: [],
      size: 1
    });
    const derived = await adapter.syncDocument(invalid.document);

    expect(derived.warnings).toEqual([
      'Feature "Missing lineage fillet": Edge modifier lineage is missing a reference for one selected edge.'
    ]);
    expect(derived.bodyRepresentations[invalid.bodyId]).toBeUndefined();
  });

  it('fillets a cylinder cap rim across the whole radius range', async () => {
    // The upper half of this range (f/r >= 0.5) is the part the deleted
    // workaround existed to serve. Every ratio has to build the same analytic
    // body and hit its closed form, or the deletion was premature.
    const radius = 2;
    const height = 6;
    for (const ratio of [0.1, 0.25, 0.4999, 0.5, 0.5001, 0.75, 0.9, 0.99]) {
      const filletRadius = radius * ratio;
      const base = addPrimitiveFeature(
        createProjectDocument(`Rim ${ratio}`, toUserId('user_exact')),
        {
          name: 'Post',
          primitiveKind: 'cylinder',
          dimensions: { radius, height }
        }
      );
      const bodyId = base.bodyOrder.at(-1)!;
      const baseDerived = await adapter.syncDocument(base);
      const rims =
        baseDerived.bodyRepresentations[bodyId]?.topology?.edges.filter(
          (edge) => edge.displayRole !== 'seam'
        ) ?? [];
      expect(rims).toHaveLength(2);

      const filleted = filletEdges(base, {
        name: 'Rim fillet',
        targetBodyId: bodyId,
        edgeHashes: [rims[0]!.hash],
        size: filletRadius
      }).document;
      const derived = await adapter.syncDocument(filleted);
      const body = derived.bodyRepresentations[filleted.bodyOrder.at(-1)!];

      expect(derived.warnings, `f/r = ${ratio}`).toEqual([]);
      expect(body?.faceCount, `f/r = ${ratio}`).toBe(4);
      expect(surfaceTypeCounts(body), `f/r = ${ratio}`).toEqual({
        cylinder: 1,
        plane: 2,
        torus: 1
      });
      expect(body?.volume, `f/r = ${ratio}`).toBeCloseTo(
        rimFilletVolume(radius, height, filletRadius, 1),
        6
      );
    }
  });

  it('refuses a cap-rim fillet at f = r with an actionable message', async () => {
    // f = r is the one radius in the workaround's old guard range the kernel
    // still will not build. It has to refuse in a way the adapter can dress
    // up, rather than returning a body.
    const radius = 3;
    const base = addPrimitiveFeature(
      createProjectDocument('Rim at f = r', toUserId('user_exact')),
      {
        name: 'Post',
        primitiveKind: 'cylinder',
        dimensions: { radius, height: 9 }
      }
    );
    const bodyId = base.bodyOrder.at(-1)!;
    const baseDerived = await adapter.syncDocument(base);
    const rim = baseDerived.bodyRepresentations[bodyId]?.topology?.edges.find(
      (edge) => edge.displayRole !== 'seam'
    );
    expect(rim).toBeTruthy();

    const filleted = filletEdges(base, {
      name: 'Rim fillet',
      targetBodyId: bodyId,
      edgeHashes: [rim!.hash],
      size: radius
    }).document;
    const derived = await adapter.syncDocument(filleted);

    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain(
      `Fillet could not be created on 1 selected edge with radius ${radius}.`
    );
    expect(derived.warnings[0]).not.toContain('WebAssembly.Exception');
  });

  it('keeps all-edges box fillet corners exact and seam-smooth', async () => {
    // Regression for the fillet corner-patch defect (docs/qa/2026-07-31):
    // the kernel's vertex blends used to sag up to 5% of R below the corner
    // ball, fold triangles inward, and meet the fillet cylinders at a 105.8
    // degree crease — rendered as a pinched blob on every corner. Corner
    // caps are exact analytic spheres since historical BrepKit #33/#34; this pins that
    // at the display-mesh level the app actually renders.
    const radius = 2;
    const [width, height, depth] = [30, 18, 24];
    const base = addPrimitiveFeature(
      createProjectDocument('Fillet corner regression', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width, height, depth }
      }
    );
    const baseDerived = await adapter.syncDocument(base);
    const baseBody = Object.values(baseDerived.bodyRepresentations)[0]!;
    const edgeHashes = baseBody.topology!.edges.map((edge) => edge.hash);
    expect(edgeHashes).toHaveLength(12);

    const filleted = filletEdges(base, {
      name: 'Fillet all edges',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes,
      size: radius
    }).document;
    const derived = await adapter.syncDocument(filleted);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[filleted.bodyOrder.at(-1)!]!;

    // Closed-form rounded-box volume (Minkowski sum of the inner box with a
    // ball). The pre-fix corner sag measured 0.137% low, so a 0.05%
    // relative bound separates cleanly.
    const inner = [width - 2 * radius, height - 2 * radius, depth - 2 * radius];
    const exactVolume =
      inner[0]! * inner[1]! * inner[2]! +
      2 *
        radius *
        (inner[0]! * inner[1]! +
          inner[1]! * inner[2]! +
          inner[0]! * inner[2]!) +
      Math.PI * radius ** 2 * (inner[0]! + inner[1]! + inner[2]!) +
      (4 / 3) * Math.PI * radius ** 3;
    expect(Math.abs(body.volume - exactVolume) / exactVolume).toBeLessThan(
      5e-4
    );

    // 6 trimmed planes + 12 fillet cylinders + 8 spherical corner caps.
    const faces = body.topology!.faces;
    expect(faces).toHaveLength(26);
    const sphereFaces = faces.filter(
      (face) => face.geometry?.surfaceType === 'sphere'
    );
    expect(sphereFaces).toHaveLength(8);

    const positions = body.mesh.vertices;
    const indices = body.mesh.indices;
    const point = (index: number): [number, number, number] => [
      positions[index * 3]!,
      positions[index * 3 + 1]!,
      positions[index * 3 + 2]!
    ];
    const sub = (a: number[], b: number[]) => [
      a[0]! - b[0]!,
      a[1]! - b[1]!,
      a[2]! - b[2]!
    ];
    const cross = (a: number[], b: number[]) => [
      a[1]! * b[2]! - a[2]! * b[1]!,
      a[2]! * b[0]! - a[0]! * b[2]!,
      a[0]! * b[1]! - a[1]! * b[0]!
    ];
    const dot3 = (a: number[], b: number[]) =>
      a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    const norm = (a: number[]) => Math.hypot(a[0]!, a[1]!, a[2]!);

    // Every corner-cap vertex sits exactly on its corner ball (the ball
    // centre is the nearest bbox corner pulled inward by R on each axis)
    // and every cap triangle faces outward — the old patch folded 7
    // triangles per corner into the body.
    const { min, max } = body.bbox;
    for (const face of sphereFaces) {
      const start = face.triangleStart * 3;
      const end = start + face.triangleCount * 3;
      const sample = point(indices[start]!);
      const center = [
        sample[0] - min.x < max.x - sample[0] ? min.x + radius : max.x - radius,
        sample[1] - min.y < max.y - sample[1] ? min.y + radius : max.y - radius,
        sample[2] - min.z < max.z - sample[2] ? min.z + radius : max.z - radius
      ];
      for (let cursor = start; cursor < end; cursor += 3) {
        const a = point(indices[cursor]!);
        const b = point(indices[cursor + 1]!);
        const c = point(indices[cursor + 2]!);
        for (const p of [a, b, c]) {
          // Display vertices are float32 across the WASM boundary, so allow
          // that quantization — still five orders below the 0.1 mm sag the
          // old approximate corner patch produced.
          expect(Math.abs(norm(sub(p, center)) - radius)).toBeLessThan(1e-5);
        }
        const normal = cross(sub(b, a), sub(c, a));
        const mid = [
          (a[0] + b[0] + c[0]) / 3,
          (a[1] + b[1] + c[1]) / 3,
          (a[2] + b[2] + c[2]) / 3
        ];
        expect(dot3(normal, sub(mid, center))).toBeGreaterThan(0);
      }
    }

    // Every adjacency in this model is tangent (plane–cylinder,
    // cylinder–sphere), so no seam between triangles of different B-rep
    // faces may crease beyond a few degrees. The old corner patch met its
    // cylinders at up to 105.8 degrees.
    const faceOfTriangle = new Int32Array(indices.length / 3).fill(-1);
    faces.forEach((face, faceIndex) => {
      for (
        let triangle = face.triangleStart;
        triangle < face.triangleStart + face.triangleCount;
        triangle += 1
      ) {
        faceOfTriangle[triangle] = faceIndex;
      }
    });
    const triangleNormals: number[][] = [];
    const edgeUse = new Map<string, number[]>();
    for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
      const a = indices[triangle * 3]!;
      const b = indices[triangle * 3 + 1]!;
      const c = indices[triangle * 3 + 2]!;
      const normal = cross(sub(point(b), point(a)), sub(point(c), point(a)));
      const length = norm(normal) || 1;
      triangleNormals.push([
        normal[0]! / length,
        normal[1]! / length,
        normal[2]! / length
      ]);
      for (const [first, second] of [
        [a, b],
        [b, c],
        [c, a]
      ] as const) {
        const key =
          first < second ? `${first}:${second}` : `${second}:${first}`;
        const users = edgeUse.get(key) ?? [];
        users.push(triangle);
        edgeUse.set(key, users);
      }
    }
    let worstSeamDot = 1;
    for (const users of edgeUse.values()) {
      // Watertight display mesh: every edge is shared by exactly two
      // triangles. A count of one is a crack; three is an overlap fold.
      expect(users).toHaveLength(2);
      const [first, second] = users as [number, number];
      if (faceOfTriangle[first] === faceOfTriangle[second]) {
        continue;
      }
      worstSeamDot = Math.min(
        worstSeamDot,
        dot3(triangleNormals[first]!, triangleNormals[second]!)
      );
    }
    const worstSeamDegrees =
      (Math.acos(Math.max(-1, worstSeamDot)) * 180) / Math.PI;
    expect(worstSeamDegrees).toBeLessThan(8);
  });

  it('allows a fillet radius larger than half the selected edge length', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Short edge fillet', toUserId('user_exact')),
      {
        name: 'Shallow block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 5 }
      }
    );
    const baseDerived = await adapter.syncDocument(base);
    const baseBody = Object.values(baseDerived.bodyRepresentations)[0]!;
    const shortEdge = baseBody.topology?.edges.find((edge) => {
      const pointCount = edge.points.length;
      return (
        pointCount >= 6 &&
        Math.abs(
          Math.hypot(
            edge.points[pointCount - 3]! - edge.points[0]!,
            edge.points[pointCount - 2]! - edge.points[1]!,
            edge.points[pointCount - 1]! - edge.points[2]!
          ) - 5
        ) < 1e-6
      );
    });
    expect(shortEdge).toBeTruthy();

    const filleted = filletEdges(base, {
      name: 'Short-edge fillet',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [shortEdge!.hash],
      size: 2.9
    }).document;
    const derived = await adapter.syncDocument(filleted);
    const body = derived.bodyRepresentations[filleted.bodyOrder.at(-1)!];

    expect(derived.warnings).toEqual([]);
    expect(body?.volume).toBeGreaterThan(0);
    expect(body?.volume).toBeLessThan(baseBody.volume);
    expect(body?.bbox).toEqual(baseBody.bbox);
  });

  it('fillets all twelve original box edges in one exact feature', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('All-edge fillet', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 18, depth: 24 }
      }
    );
    const baseDerived = await adapter.syncDocument(base);
    const edgeHashes = Object.values(
      baseDerived.bodyRepresentations
    )[0]?.topology?.edges.map((edge) => edge.hash);
    expect(edgeHashes).toHaveLength(12);

    const filleted = filletEdges(base, {
      name: 'All edges',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: edgeHashes!,
      size: 2
    }).document;
    const derived = await adapter.syncDocument(filleted);
    const body = derived.bodyRepresentations[filleted.bodyOrder.at(-1)!];

    expect(derived.warnings).toEqual([]);
    expect(body?.volume).toBeGreaterThan(0);
    expect(body?.volume).toBeLessThan(40 * 18 * 24);
    expect(body?.faceCount).toBeGreaterThan(6);
    expect(body?.bbox.min.x).toBeCloseTo(0, 1);
    expect(body?.bbox.min.y).toBeCloseTo(0, 1);
    expect(body?.bbox.min.z).toBeCloseTo(0, 1);
    expect(body?.bbox.max.x).toBeCloseTo(40, 1);
    expect(body?.bbox.max.y).toBeCloseTo(18, 1);
    expect(body?.bbox.max.z).toBeCloseTo(24, 1);

    const step = await adapter.exportStep(filleted, [
      filleted.bodyOrder.at(-1)!
    ]);
    const inspection = await adapter.inspectStep(step);
    expect(inspection).toMatchObject({ solid: true, valid: true });
    // Remus's STEP reader reconstructs NURBS blend trims independently,
    // which can shift measured volume slightly while preserving a valid solid.
    expect(
      Math.abs(inspection.volume - body!.volume) / body!.volume
    ).toBeLessThan(0.01);
  });

  it('fillets an edge of an already-filleted body (sequential fillets)', async () => {
    // Remus can extend a second blend from most planar-adjacent edges. What
    // this pins is not which edges those are but that every REFUSAL carries
    // advice the kernel agrees with: a refusal that says "try a smaller
    // radius" is checked by actually trying smaller radii, and one that says
    // to edit the earlier feature is checked by confirming no smaller radius
    // works either.
    //
    // That replaces a pin on the wording. The wording used to be inferred
    // from surface type — a blend face WAS a `bspline`, so an edge touching
    // one was blend-adjacent. The kernel now returns exact cylinders for
    // straight-edge fillets, which made every second-fillet refusal here fall
    // through to "try a smaller radius" whether or not a smaller radius could
    // work. Both halves are now derived from what the kernel accepts.
    const base = addPrimitiveFeature(
      createProjectDocument('Sequential fillets', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      }
    );
    const baseDerived = await adapter.syncDocument(base);
    const firstEdgeHash = Object.values(baseDerived.bodyRepresentations)[0]
      ?.topology?.edges[0]?.hash;
    expect(firstEdgeHash).toBeTypeOf('number');

    const first = filletEdges(base, {
      name: 'First fillet',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [firstEdgeHash!],
      size: 2
    }).document;
    const firstDerived = await adapter.syncDocument(first);
    const firstBodyId = first.bodyOrder.at(-1)!;
    const firstBody = firstDerived.bodyRepresentations[firstBodyId];
    expect(firstDerived.warnings).toEqual([]);
    expect(firstBody?.topology?.edges.length).toBeGreaterThan(12);

    // The first fillet's band is an exact cylinder of the requested radius,
    // not a spline fitted near one.
    const firstBand = firstBody!.topology!.faces.filter(
      (face) => face.geometry?.surfaceType !== 'plane'
    );
    expect(firstBand).toHaveLength(1);
    expect(firstBand[0]!.geometry?.surfaceType).toBe('cylinder');
    expect(firstBand[0]!.geometry?.radius).toBeCloseTo(2, 9);

    const secondFillet = async (edgeHash: number, size: number) => {
      const second = filletEdges(first, {
        name: `Second fillet ${edgeHash} at ${size}`,
        targetBodyId: firstBodyId,
        edgeHashes: [edgeHash],
        size
      }).document;
      const derived = await adapter.syncDocument(second);
      return {
        warnings: derived.warnings,
        body: derived.bodyRepresentations[second.bodyOrder.at(-1)!]
      };
    };

    // Fillet every edge of the filleted body one at a time. Successful convex
    // or concave blends may remove or add volume, but must produce a distinct,
    // positive solid. Every failure must carry advice that is TRUE of this
    // body, which is asserted by re-running the same pick at smaller radii.
    let succeeded = 0;
    let sizeBound = 0;
    let structural = 0;
    for (const edge of firstBody!.topology!.edges) {
      const attempt = await secondFillet(edge.hash, 2);
      if (attempt.warnings.length === 0) {
        succeeded += 1;
        expect(attempt.body?.volume).toBeGreaterThan(0);
        expect(attempt.body?.volume).not.toBeCloseTo(firstBody!.volume, 6);
        continue;
      }
      expect(attempt.warnings).toHaveLength(1);
      expect(attempt.warnings[0]).not.toContain('WebAssembly.Exception');
      const smallerRadiiThatWork = (
        await Promise.all(
          [1, 0.5, 0.25, 0.1].map((size) => secondFillet(edge.hash, size))
        )
      ).filter((result) => result.warnings.length === 0);
      if (/Try a smaller radius/.test(attempt.warnings[0]!)) {
        sizeBound += 1;
        // The advice has to be actionable, so a smaller radius must actually
        // produce a body.
        expect(smallerRadiiThatWork.length).toBeGreaterThan(0);
        expect(smallerRadiiThatWork[0]!.body?.volume).toBeGreaterThan(0);
      } else {
        structural += 1;
        // The structural advice claims no radius helps, so nothing smaller
        // may quietly succeed.
        expect(smallerRadiiThatWork).toHaveLength(0);
        expect(attempt.warnings[0]).toMatch(/edit that earlier feature/i);
      }
    }
    expect(succeeded).toBeGreaterThanOrEqual(7);
    expect(sizeBound + structural).toBeLessThanOrEqual(8);
    // Blend-on-blend is still the dominant refusal on this body; if that ever
    // becomes zero the classifier has stopped recognising its own bands.
    expect(structural).toBeGreaterThan(0);
  }, 60_000);

  it('fillets the result of a boolean subtract', async () => {
    const withBase = addPrimitiveFeature(
      createProjectDocument('Boolean fillet', toUserId('user_exact')),
      {
        name: 'Base',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      }
    );
    const withCutter = addPrimitiveFeature(withBase, {
      name: 'Cutter',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 30, depth: 10 }
    });
    const manager = new CommandManager(withCutter);
    const subtracted = manager.execute(
      commandFactories.booleanBodies({
        name: 'Subtract',
        operation: 'subtract',
        targetBodyIds: [withCutter.bodyOrder[0]!, withCutter.bodyOrder[1]!]
      })
    );
    const subtractedDerived = await adapter.syncDocument(subtracted);
    expect(subtractedDerived.warnings).toEqual([]);
    const booleanBodyId = subtracted.bodyOrder.at(-1)!;
    const booleanBody = subtractedDerived.bodyRepresentations[booleanBodyId];
    expect(booleanBody?.topology?.edges.length).toBeGreaterThan(0);

    const filleted = filletEdges(subtracted, {
      name: 'Boolean fillet',
      targetBodyId: booleanBodyId,
      edgeHashes: [booleanBody!.topology!.edges[0]!.hash],
      size: 1
    }).document;
    const derived = await adapter.syncDocument(filleted);
    expect(derived.warnings).toEqual([]);
    expect(
      derived.bodyRepresentations[filleted.bodyOrder.at(-1)!]?.volume
    ).toBeGreaterThan(0);
  });

  it('reports an actionable diagnostic when an edge fillet is invalid', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Invalid fillet', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    const baseDerived = await adapter.syncDocument(base);
    const edgeHash = Object.values(baseDerived.bodyRepresentations)[0]?.topology
      ?.edges[0]?.hash;
    expect(edgeHash).toBeTypeOf('number');
    const invalid = filletEdges(base, {
      name: 'Oversized fillet',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [edgeHash!],
      size: 50
    }).document;
    const derived = await adapter.syncDocument(invalid);

    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain(
      'Fillet could not be created on 1 selected edge with radius 50.'
    );
    expect(derived.warnings[0]).toContain('Try a smaller radius');
    expect(derived.warnings[0]).not.toContain('WebAssembly.Exception');
  });

  it('fillets corner chains and hole rims on a boolean-result plate', async () => {
    // Regression for docs/qa/2026-08-01, inverted. That investigation found
    // the kernel refusing corner chains and closed rims on a boolean-subtract
    // body at EVERY radius, and this test existed to prove the refusal was at
    // least named honestly. The kernel's blend phases landed: both picks now
    // build, so the test proves the blends instead.
    //
    // What is asserted is the geometry, not that a call returned. The hole rim
    // is checked against its Pappus closed form, the single edge against the
    // straight-band closed form, and both results have to be watertight solids
    // with the surfaces a rolling-ball blend is defined to produce.
    //
    // The corner chain's VOLUME is deliberately not asserted here: it builds a
    // valid solid but removes more material than the closed form, which
    // 'blends a corner chain to its closed-form volume' below measures and
    // fails on. Recording the number it produces today is exactly how that
    // would stop being findable.
    const withPlate = addPrimitiveFeature(
      createProjectDocument('Holed plate fillets', toUserId('user_exact')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 80, height: 60, depth: 6 }
      }
    );
    const plateId = withPlate.bodyOrder.at(-1)!;
    const withTool = addPrimitiveFeature(withPlate, {
      name: 'Hole tool',
      primitiveKind: 'cylinder',
      dimensions: { radius: 2.25, height: 6 }
    });
    const toolId = withTool.bodyOrder.at(-1)!;
    const positioned = transformBody(withTool, {
      name: 'Place hole',
      targetBodyId: toolId,
      translation: { x: 10, y: 10, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Holed plate',
        operation: 'subtract',
        targetBodyIds: [plateId, toolId]
      })
    );
    const bodyId = document.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);

    const edges = derived.bodyRepresentations[bodyId]!.topology!.edges;
    const polylineLength = (points: number[]): number => {
      let total = 0;
      for (let index = 0; index + 5 < points.length; index += 3) {
        total += Math.hypot(
          points[index + 3]! - points[index]!,
          points[index + 4]! - points[index + 1]!,
          points[index + 5]! - points[index + 2]!
        );
      }
      return total;
    };
    const onTop = (points: number[]): boolean =>
      points.every(
        (value, index) => index % 3 !== 2 || Math.abs(value - 6) < 1e-6
      );
    const topOfLength = (length: number) =>
      edges.filter(
        (edge) =>
          onTop(edge.points) &&
          Math.abs(polylineLength(edge.points) - length) < 1e-3
      );
    const long = topOfLength(80)[0]!;
    const sharesEndpoint = (a: number[], b: number[]): boolean => {
      const ends = (points: number[]) => [points.slice(0, 3), points.slice(-3)];
      return ends(a).some((p) =>
        ends(b).some(
          (q) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!) < 1e-6
        )
      );
    };
    const short = topOfLength(60).find((edge) =>
      sharesEndpoint(edge.points, long.points)
    )!;
    const rim = edges.find(
      (edge) =>
        onTop(edge.points) &&
        Math.abs(polylineLength(edge.points) - 2 * Math.PI * 2.25) < 0.05
    )!;
    expect(long).toBeTruthy();
    expect(short).toBeTruthy();
    expect(rim).toBeTruthy();

    const plateVolume = derived.bodyRepresentations[bodyId]!.volume;
    const plateClosedForm = 80 * 60 * 6 - Math.PI * 2.25 ** 2 * 6;
    expect(
      Math.abs(plateVolume - plateClosedForm) / plateClosedForm
    ).toBeLessThan(1e-5);

    const filletPlate = async (
      name: string,
      edgeHashes: number[],
      size: number
    ) => {
      const candidate = filletEdges(document, {
        name,
        targetBodyId: bodyId,
        edgeHashes,
        size
      }).document;
      const result = await adapter.syncDocument(candidate);
      return {
        warnings: result.warnings,
        body: result.bodyRepresentations[candidate.bodyOrder.at(-1)!]
      };
    };
    const watertight = (body: {
      mesh: { vertices: ArrayLike<number>; indices: ArrayLike<number> };
    }) =>
      isClosedConsistentlyOrientedMesh(
        inspectTriangleMeshClosure(body.mesh.vertices, body.mesh.indices)
      );
    const surfaceTypes = (body: {
      topology?: { faces: { geometry?: { surfaceType?: string } }[] };
    }) =>
      (body.topology?.faces ?? [])
        .map((face) => face.geometry?.surfaceType)
        .sort();

    // --- the corner chain: used to be refused at every radius ---------------
    const corner = await filletPlate(
      'Corner fillet',
      [long.hash, short.hash],
      2
    );
    expect(corner.warnings).toEqual([]);
    const cornerClosure = inspectTriangleMeshClosure(
      corner.body!.mesh.vertices,
      corner.body!.mesh.indices
    );
    expect(cornerClosure.boundaryEdges).toBe(0);
    expect(cornerClosure.nonManifoldEdges).toBe(0);
    expect(cornerClosure.inconsistentWindingEdges).toBe(0);
    // Two blend bands, the spherical octant that joins them, and the flat
    // remnant between that octant and the sharp vertical edge it stops at —
    // over the plate's six planes and its bore.
    expect(surfaceTypes(corner.body!)).toEqual([
      'cylinder',
      'cylinder',
      'cylinder',
      'plane',
      'plane',
      'plane',
      'plane',
      'plane',
      'plane',
      'plane',
      'sphere'
    ]);
    const cornerBands = corner.body!.topology!.faces.filter(
      (face) =>
        face.geometry?.surfaceType === 'cylinder' &&
        Math.abs((face.geometry.radius ?? 0) - 2) < 1e-9
    );
    expect(cornerBands).toHaveLength(2);
    // The vertex patch is a sphere of the blend radius, not an approximation.
    const cornerPatch = corner.body!.topology!.faces.filter(
      (face) => face.geometry?.surfaceType === 'sphere'
    );
    expect(cornerPatch).toHaveLength(1);
    expect(cornerPatch[0]!.geometry!.radius).toBeCloseTo(2, 9);
    // Closed form. Away from the corner each band removes r^2 - pi r^2 / 4 per
    // unit length. Inside the r x r x r corner cube the two bands overlap and
    // the octant takes over, so that cube keeps only the octant's volume.
    //
    // The tolerance is measurement, not geometry: this reads the volume
    // through syncDocument at MEASUREMENT_DEFLECTION (0.08), where the blend's
    // curved faces cost ~1.1e-5 relative. Measured on the same solid at a
    // converged deflection the agreement is 2.8e-8 — see 'blends a corner
    // chain to its closed-form volume', which measures the kernel directly.
    const r = 2;
    const bandArea = r ** 2 - (Math.PI * r ** 2) / 4;
    const cornerCube = r ** 3 - ((4 / 3) * Math.PI * r ** 3) / 8;
    const cornerClosedForm =
      plateClosedForm - bandArea * (80 - r) - bandArea * (60 - r) - cornerCube;
    expect(
      Math.abs(corner.body!.volume - cornerClosedForm) / cornerClosedForm
    ).toBeLessThan(5e-5);
    // The bore survives the blend untouched.
    expect(
      corner.body!.topology!.faces.some(
        (face) => Math.abs((face.geometry?.radius ?? 0) - 2.25) < 1e-9
      )
    ).toBe(true);

    // --- the hole rim: used to be refused at every radius -------------------
    const rimFillet = await filletPlate('Rim fillet', [rim.hash], 1);
    expect(rimFillet.warnings).toEqual([]);
    expect(watertight(rimFillet.body!)).toBe(true);
    // Rounding a bore's mouth turns the rim into a torus and leaves the bore
    // wall and the six planes alone.
    expect(surfaceTypes(rimFillet.body!)).toEqual([
      'cylinder',
      'plane',
      'plane',
      'plane',
      'plane',
      'plane',
      'plane',
      'torus'
    ]);
    // Pappus on the removed cross-section: the r x r corner square between the
    // top plane and the bore wall, less the quarter disc the rolling ball
    // leaves behind, revolved about the bore axis at its own centroid radius.
    const boreRadius = 2.25;
    const rimRadius = 1;
    const removedArea = rimRadius ** 2 - (Math.PI * rimRadius ** 2) / 4;
    const removedCentroid =
      (rimRadius ** 2 * (boreRadius + rimRadius / 2) -
        ((Math.PI * rimRadius ** 2) / 4) *
          (boreRadius + rimRadius - (4 * rimRadius) / (3 * Math.PI))) /
      removedArea;
    const rimClosedForm =
      plateClosedForm - removedArea * 2 * Math.PI * removedCentroid;
    expect(rimClosedForm).toBeCloseTo(28701.239075601843, 9);
    expect(
      Math.abs(rimFillet.body!.volume - rimClosedForm) / rimClosedForm
    ).toBeLessThan(1e-5);

    // --- a single straight edge, and the radius advice that survives --------
    const single = await filletPlate('Single fillet', [long.hash], 2);
    expect(single.warnings).toEqual([]);
    expect(watertight(single.body!)).toBe(true);
    // Rounding a straight edge of length L at radius r removes (1 - pi/4) r^2 L.
    const singleClosedForm = plateClosedForm - (1 - Math.PI / 4) * 4 * 80;
    // Loose because `volume()` integrates at MEASUREMENT_DEFLECTION (0.08),
    // which under-measures an r2 band by ~4.7e-4 relative; refining the
    // deflection walks this body onto the closed form (-1.1e-6 at 1e-5).
    expect(
      Math.abs(single.body!.volume - singleClosedForm) / singleClosedForm
    ).toBeLessThan(1e-3);
    expect(single.body!.volume).toBeLessThan(plateVolume);

    const oversized = await filletPlate('Oversized fillet', [long.hash], 50);
    expect(oversized.warnings).toHaveLength(1);
    expect(oversized.warnings[0]).toContain('Try a smaller radius');
    expect(oversized.warnings[0]).not.toContain('WebAssembly.Exception');
  }, 60_000);

  it('blends a corner chain to its closed-form volume', async () => {
    // Measured on a plain 80x60x6 box at a deflection fine enough that the
    // mesh has converged (successive refinements move these by <1e-8
    // relative), so this is geometry, not measurement.
    //
    // This test was written failing, when a corner chain read +147% over the
    // closed form and four edges read +259%. The geometry was never wrong:
    // the vertex patch was emitted INVERTED, so the divergence integral
    // counted its faces with the wrong sign. The tell was that the excess
    // moved when the solid did — divergence contributions are origin
    // dependent — which is why two reproductions of the same pick disagreed.
    // Fixed kernel-side by orienting the patch outward; the closed form was
    // the right answer all along.
    //
    // Do not re-record these numbers. The closed form is the answer.
    const kernel = new RemusKernel();
    try {
      const box = kernel.makeBox(80, 60, 6);
      const converged = (solid: number) => kernel.volume(solid, 1e-5);
      const boxVolume = converged(box);
      expect(boxVolume).toBeCloseTo(28800, 6);

      const edgeLength = (edge: number) => {
        const points = Array.from(kernel.tessellateEdge(edge, 1e-3));
        let total = 0;
        for (let index = 0; index + 5 < points.length; index += 3) {
          total += Math.hypot(
            points[index + 3]! - points[index]!,
            points[index + 4]! - points[index + 1]!,
            points[index + 5]! - points[index + 2]!
          );
        }
        return { total, points };
      };
      const top = Array.from(kernel.getSolidEdges(box))
        .map((handle) => ({ handle, ...edgeLength(handle) }))
        .filter((edge) =>
          edge.points.every(
            (value, index) => index % 3 !== 2 || Math.abs(value - 6) < 1e-6
          )
        );
      expect(top).toHaveLength(4);
      const long = top.filter((edge) => Math.abs(edge.total - 80) < 1e-6);
      const short = top.filter((edge) => Math.abs(edge.total - 60) < 1e-6);
      expect(long).toHaveLength(2);
      expect(short).toHaveLength(2);

      const band = (length: number) => (1 - Math.PI / 4) * 4 * length;
      // A rolling ball of radius r at a convex corner leaves a spherical
      // octant, so the corner cube gives up 8 - pi r^3 / 6 of its volume.
      const cornerPatch = 8 - (Math.PI * 8) / 6;
      const removedBy = (handles: number[], size: number) =>
        boxVolume -
        converged(kernel.fillet(box, Uint32Array.from(handles), size));
      // 1e-4 relative: the converged mesh still carries ~1e-5 of residue on a
      // curved band, and every gap below is orders of magnitude larger.
      const removes = (
        label: string,
        handles: number[],
        closedForm: number
      ) => {
        const measured = removedBy(handles, 2);
        expect
          .soft(
            Math.abs(measured - closedForm) / closedForm,
            `${label}: removed ${measured.toFixed(3)} mm3, closed form ${closedForm.toFixed(3)} mm3`
          )
          .toBeLessThan(1e-4);
      };

      // Controls: a single band and two disjoint bands are exact.
      removes('one 80 mm edge', [long[0]!.handle], band(80));
      removes(
        'two opposite 80 mm edges',
        [long[0]!.handle, long[1]!.handle],
        2 * band(80)
      );

      // One vertex blend.
      removes(
        'one corner chain',
        [long[0]!.handle, short[0]!.handle],
        band(80 - 2) + band(60 - 2) + cornerPatch
      );

      // Four vertex blends.
      removes(
        'the whole top perimeter',
        top.map((edge) => edge.handle),
        2 * band(80 - 4) + 2 * band(60 - 4) + 4 * cornerPatch
      );
    } finally {
      kernel.free();
    }
  }, 120_000);

  it('tessellates a vertex blend with consistent winding', async () => {
    // Written failing alongside the volume test above, and a separate defect
    // from it. The corner chain's B-rep passed `validate_solid` with zero
    // errors and its triangle projection was closed and manifold — but 56 of
    // its edges carried two triangle uses pointing the SAME way. That is the
    // mesh the viewport shades and the STL exporter writes, so the winding is
    // user-visible even though every B-rep-level check reported the body as
    // sound. Fixed kernel-side; this holds the tessellation to it.
    const withPlate = addPrimitiveFeature(
      createProjectDocument('Winding', toUserId('user_exact')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 80, height: 60, depth: 6 }
      }
    );
    const plateId = withPlate.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(withPlate);
    const edges = derived.bodyRepresentations[plateId]!.topology!.edges;
    const onTop = (points: number[]): boolean =>
      points.every(
        (value, index) => index % 3 !== 2 || Math.abs(value - 6) < 1e-6
      );
    const span = (points: number[]) =>
      Math.hypot(
        points.at(-3)! - points[0]!,
        points.at(-2)! - points[1]!,
        points.at(-1)! - points[2]!
      );
    const top = edges.filter((edge) => onTop(edge.points));
    const long = top.find((edge) => Math.abs(span(edge.points) - 80) < 1e-6)!;
    const short = top.find((edge) => Math.abs(span(edge.points) - 60) < 1e-6)!;
    const corner = filletEdges(withPlate, {
      name: 'Corner fillet',
      targetBodyId: plateId,
      edgeHashes: [long.hash, short.hash],
      size: 2
    }).document;
    const cornerDerived = await adapter.syncDocument(corner);
    expect(cornerDerived.warnings).toEqual([]);
    const body = cornerDerived.bodyRepresentations[corner.bodyOrder.at(-1)!]!;
    const closure = inspectTriangleMeshClosure(
      body.mesh.vertices,
      body.mesh.indices
    );
    expect(closure.boundaryEdges).toBe(0);
    expect(closure.nonManifoldEdges).toBe(0);
    expect(closure.inconsistentWindingEdges).toBe(0);
  }, 60_000);

  it('never silently drops an edge a multi-edge selection names', async () => {
    // Written failing: a selection mixing the top perimeter with the bore's
    // closed rim came back blended on the four straight edges only. The rim
    // was dropped, the result was byte-identical to the four-edge selection,
    // and the kernel reported no error — so a user got a silent partial edit
    // that the adapter had no way to detect, since a partial result is itself
    // a valid, in-envelope solid.
    //
    // The contract this test holds is that the operation either rounds
    // everything it was given, or it fails loudly saying what it missed.
    // Never a quiet subset.
    //
    // Both defects behind it are now fixed kernel-side. The silence went
    // first: the kernel began refusing the whole selection and naming the
    // dropped edge. Then the refusal itself went — it turned out the rim
    // never reached the corner the error blamed. The dispatcher chose ONE
    // engine for the whole selection, and only the planar rebuild closes a
    // vertex blend while only the walking builder assembles a closed rim, so
    // one circle in the selection sent the four straight edges to a builder
    // whose first guard refuses any two-chain vertex. Those corners failed in
    // that builder with no rim present at all.
    //
    // Both branches stay accepted. The refusal branch is the one that must
    // never regress into silence, and keeping it costs nothing.
    const kernel = new RemusKernel();
    try {
      const plate = kernel.makeBox(80, 60, 6);
      const bore = kernel.copyAndTransformSolid(
        kernel.makeCylinder(2.25, 6),
        new Float64Array([1, 0, 0, 10, 0, 1, 0, 10, 0, 0, 1, 0, 0, 0, 0, 1])
      );
      const holed = kernel.cut(plate, bore);
      const onTop = (edge: number) =>
        Array.from(kernel.tessellateEdge(edge, 1e-3)).every(
          (value, index) => index % 3 !== 2 || Math.abs(value - 6) < 1e-6
        );
      const topEdges = Array.from(kernel.getSolidEdges(holed)).filter(onTop);
      const rims = topEdges.filter((edge) => {
        const handles = Array.from(kernel.getEdgeVertexHandles(edge));
        return new Set(handles).size === 1;
      });
      const perimeter = topEdges.filter((edge) => !rims.includes(edge));
      expect(rims).toHaveLength(1);
      expect(perimeter).toHaveLength(4);

      const faceTypes = (solid: number) =>
        Array.from(kernel.getSolidFaces(solid))
          .map((face) => kernel.getSurfaceType(face))
          .sort();

      // Each half of the selection rounds on its own.
      const perimeterOnly = kernel.fillet(
        holed,
        Uint32Array.from(perimeter),
        2
      );
      const perimeterVolume = kernel.volume(perimeterOnly, 1e-5);
      expect(faceTypes(perimeterOnly)).toContain('sphere');
      const rimOnly = kernel.fillet(holed, Uint32Array.from(rims), 2);
      expect(faceTypes(rimOnly)).toContain('torus');

      let withRim: number | null = null;
      let refusal = '';
      try {
        withRim = kernel.fillet(
          holed,
          Uint32Array.from([...perimeter, ...rims]),
          2
        );
      } catch (error) {
        refusal = String((error as Error)?.message ?? error);
      }

      if (withRim !== null) {
        // One measurement, reused. `volume` at 1e-5 is the expensive call in
        // this test and it was being made twice on the same solid; under load
        // the whole test ran to 125s against its 120s budget.
        const measured = kernel.volume(withRim, 1e-5);
        // It took the whole selection, so the rim has to be rounded — a result
        // that matches the perimeter-only solid means the rim went missing.
        const types = faceTypes(withRim);
        expect(types).toContain('torus');
        expect(measured).not.toBeCloseTo(perimeterVolume, 6);
        // Every corner patch survives alongside it: four octants, five
        // cylinders (four bands plus the bore) and the rim's torus.
        expect(types.filter((type) => type === 'sphere')).toHaveLength(4);
        expect(types.filter((type) => type === 'cylinder')).toHaveLength(5);
        // The perimeter and rim removals are disjoint, so the combined body is
        // the bored plate less both. 28800 - 30.375pi of plate, less
        // 1088 - 808pi/3 for the perimeter and 94pi/3 - 17pi^2/2 for the rim,
        // which collects to 27712 + 207.625pi + 8.5pi^2. A holed body is
        // integrated off its inscribed mesh, so this converges from below.
        const combinedClosedForm =
          27712 + 207.625 * Math.PI + 8.5 * Math.PI ** 2;
        expect(measured).toBeLessThan(combinedClosedForm);
        expect(
          (combinedClosedForm - measured) / combinedClosedForm
        ).toBeLessThan(1e-6);
      } else {
        // It refused, so it has to say which edge it could not take, in prose
        // rather than an opaque trap.
        expect(refusal).toContain('edges-not-blended');
        expect(refusal).toContain(String(rims[0]));
        expect(refusal).not.toContain('[object WebAssembly.Exception]');
      }
    } finally {
      kernel.free();
    }
  }, 120_000);

  it('builds linear and circular exact body patterns', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Patterns', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 4, height: 5, depth: 6 }
      }
    );
    const targetBodyId = base.bodyOrder[0]!;
    const linear = patternBody(base, {
      name: 'Linear pattern',
      targetBodyId,
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 10
    }).document;
    const linearDerived = await adapter.syncDocument(linear);
    const linearBodyId = linear.bodyOrder.at(-1)!;
    const linearBody = linearDerived.bodyRepresentations[linearBodyId];
    expect(linearDerived.warnings).toEqual([]);
    expect(linearBody?.volume).toBeCloseTo(4 * 5 * 6 * 3, 4);
    const linearStep = await adapter.exportStep(linear, [linearBodyId]);
    const linearInspection = await adapter.inspectStep(linearStep);
    expect(linearInspection).toMatchObject({ solid: true, valid: true });
    expect(linearInspection.volume).toBeCloseTo(linearBody!.volume, 4);

    const moved = transformBody(base, {
      name: 'Offset',
      targetBodyId,
      translation: { x: 12, y: 0, z: 0 }
    }).document;
    const circular = patternBody(moved, {
      name: 'Circular pattern',
      targetBodyId,
      patternKind: 'circular',
      count: 4,
      axis: 'z',
      angleDeg: 360
    }).document;
    const circularDerived = await adapter.syncDocument(circular);
    const circularBody =
      circularDerived.bodyRepresentations[circular.bodyOrder.at(-1)!];
    expect(circularDerived.warnings).toEqual([]);
    expect(circularBody?.volume).toBeCloseTo(4 * 5 * 6 * 4, 4);
  });

  it('builds grid and arbitrary-direction exact body patterns', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Grid patterns', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 4, height: 5, depth: 6 }
      }
    );
    const targetBodyId = base.bodyOrder[0]!;

    // 3 along X, 2 along Y, disjoint spacings: exactly six blocks, so the
    // volume is the base times the instance product with nothing shared.
    const grid = patternBody(base, {
      name: 'Grid pattern',
      targetBodyId,
      patternKind: 'grid',
      count: 3,
      axis: 'x',
      spacing: 10,
      axis2: 'y',
      spacing2: 12,
      count2: 2
    }).document;
    const gridDerived = await adapter.syncDocument(grid);
    const gridBody = gridDerived.bodyRepresentations[grid.bodyOrder.at(-1)!];
    expect(gridDerived.warnings).toEqual([]);
    expect(gridBody?.volume).toBeCloseTo(4 * 5 * 6 * 6, 4);

    // A custom direction is normalized before use, so spacing 15 along the
    // XY diagonal moves each copy ~10.6 in each axis — well clear of the
    // 4x5 footprint, keeping the three copies disjoint.
    const diagonal = patternBody(base, {
      name: 'Diagonal pattern',
      targetBodyId,
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 15,
      direction: { x: 1, y: 1, z: 0 }
    }).document;
    const diagonalDerived = await adapter.syncDocument(diagonal);
    const diagonalBody =
      diagonalDerived.bodyRepresentations[diagonal.bodyOrder.at(-1)!];
    expect(diagonalDerived.warnings).toEqual([]);
    expect(diagonalBody?.volume).toBeCloseTo(4 * 5 * 6 * 3, 4);

    // Parallel grid directions are a feature error, not a kernel crash.
    const parallel = patternBody(base, {
      name: 'Parallel grid',
      targetBodyId,
      patternKind: 'grid',
      count: 2,
      axis: 'x',
      spacing: 10,
      axis2: 'x',
      spacing2: 10,
      count2: 2
    }).document;
    const parallelDerived = await adapter.syncDocument(parallel);
    expect(parallelDerived.warnings.join('\n')).toMatch(
      /Grid pattern directions cannot be parallel/
    );

    // So is a zero direction vector.
    const zero = patternBody(base, {
      name: 'Zero direction',
      targetBodyId,
      patternKind: 'linear',
      count: 2,
      axis: 'x',
      spacing: 10,
      direction: { x: 0, y: 0, z: 0 }
    }).document;
    const zeroDerived = await adapter.syncDocument(zero);
    expect(zeroDerived.warnings.join('\n')).toMatch(
      /Pattern direction must be a non-zero vector/
    );
  });

  it('exports STEP that reimports as a valid exact solid', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Round trip', toUserId('user_exact')),
      {
        name: 'Round trip box',
        primitiveKind: 'box',
        dimensions: { width: 12, height: 8, depth: 5 }
      }
    );
    const bodyId = document.bodyOrder[0]!;
    const step = await adapter.exportStep(document, [bodyId]);
    const inspection = await adapter.inspectStep(step);
    expect(inspection.solid).toBe(true);
    expect(inspection.valid).toBe(true);
    expect(inspection.volume).toBeCloseTo(480, 4);
  });

  it('keeps mirror, shell, and solid offset conformant on an IMPORTED body', async () => {
    // Z3. Before the flip these three operations on an imported document ran
    // on OpenCascade, and the UI additionally refused solid offset outright
    // because that kernel's sharp offset was limited to proven convex planar
    // bodies. Remus builds them now, and each answer is pinned against its
    // closed form.
    const source = addPrimitiveFeature(
      createProjectDocument('Import modeling source', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const step = await adapter.exportStep(source, [source.bodyOrder[0]!]);
    const manager = new CommandManager(
      createProjectDocument('Import modeling', toUserId('user_exact'))
    );
    const imported = manager.execute(
      commandFactories.importStep({
        name: 'Imported block',
        artifactId: 'artifact_import_modeling',
        sourceName: 'block.step',
        stepText: step
      })
    );
    const importedBodyId = imported.bodyOrder[0]!;

    const projection = await adapter.syncDocument(imported);
    const opening = projection.bodyRepresentations[
      importedBodyId
    ]?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs(face.geometry.center.z - 30) < 1e-6
    );
    expect(opening).toBeTruthy();

    const mirrored = mirrorBody(imported, {
      name: 'Mirrored import',
      targetBodyId: importedBodyId,
      plane: { origin: { x: 20, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
    }).document;
    const shelled = shellBody(imported, {
      name: 'Shelled import',
      targetBodyId: importedBodyId,
      openingFaceHashes: [opening!.hash],
      ...(opening!.reference
        ? { openingFaceReferences: [opening!.reference] }
        : {}),
      thickness: 1
    }).document;
    const offset = offsetSolidBody(imported, {
      name: 'Offset import',
      targetBodyId: importedBodyId,
      distance: 1
    }).document;

    for (const [document, expectedVolume] of [
      [mirrored, 6000],
      [shelled, 6000 - 8 * 18 * 29],
      [offset, 12 * 22 * 32]
    ] as const) {
      const bodyId = document.bodyOrder.at(-1)!;
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId];
      expect(body?.consumed).toBe(false);
      expect(body?.volume).toBeCloseTo(expectedVolume, 3);
      const exported = await adapter.exportStep(document, [bodyId]);
      await expect(adapter.inspectStep(exported)).resolves.toMatchObject({
        solid: true,
        valid: true
      });
    }
  });

  it('imports only the selected solids of a multi-solid STEP file', async () => {
    // Author a two-solid file with the adapter's own writer: a 10-cube and a
    // 20-cube, so each solid is identifiable by volume alone.
    let source = addPrimitiveFeature(
      createProjectDocument('Multi source', toUserId('user_exact')),
      {
        name: 'Small',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    source = addPrimitiveFeature(source, {
      name: 'Large',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 20 }
    });
    const stepText = await adapter.exportStep(source, source.bodyOrder);

    const importDocument = (solidIndices?: number[]) =>
      importStepBody(
        createProjectDocument('Partial import', toUserId('user_exact')),
        {
          name: 'Imported',
          artifactId: 'artifact_partial',
          sourceName: 'partial.step',
          stepText,
          ...(solidIndices ? { solidIndices } : {})
        }
      );

    const everything = importDocument();
    const allDerived = await adapter.syncDocument(everything.document);
    expect(allDerived.warnings).toEqual([]);
    const allBody = allDerived.bodyRepresentations[everything.bodyId];
    expect(allBody?.importedStepDeclaredSolidCount).toBe(2);
    expect(allBody?.volume).toBeCloseTo(1000 + 8000, 4);

    // Selection names DECLARED indices, in the file's stable order.
    const first = importDocument([0]);
    const firstDerived = await adapter.syncDocument(first.document);
    expect(firstDerived.warnings).toEqual([]);
    expect(firstDerived.bodyRepresentations[first.bodyId]?.volume).toBeCloseTo(
      1000,
      4
    );
    const second = importDocument([1]);
    const secondDerived = await adapter.syncDocument(second.document);
    expect(secondDerived.warnings).toEqual([]);
    expect(
      secondDerived.bodyRepresentations[second.bodyId]?.volume
    ).toBeCloseTo(8000, 4);

    // Editing the selection on an existing import re-imports accordingly —
    // the inspector's include/exclude flow is exactly this patch.
    const featureId = everything.document.featureOrder[0]!;
    const narrowed = updateFeature(everything.document, {
      featureId,
      data: { solidIndices: [1] }
    });
    const narrowedDerived = await adapter.syncDocument(narrowed);
    expect(narrowedDerived.warnings).toEqual([]);
    expect(
      narrowedDerived.bodyRepresentations[everything.bodyId]?.volume
    ).toBeCloseTo(8000, 4);

    // A selection outside the declared range keeps nothing: a build warning,
    // not a silent empty body.
    const missed = importDocument([7]);
    const missedDerived = await adapter.syncDocument(missed.document);
    expect(missedDerived.warnings.join('\n')).toMatch(
      /excludes every readable solid/
    );
    expect(missedDerived.bodyRepresentations[missed.bodyId]).toBeUndefined();
  });

  it('shares one cached parse across features selecting different solids', async () => {
    let source = addPrimitiveFeature(
      createProjectDocument('Cache source', toUserId('user_exact')),
      {
        name: 'Small',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    source = addPrimitiveFeature(source, {
      name: 'Large',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 20 }
    });
    const stepText = await adapter.exportStep(source, source.bodyOrder);
    const bytes = new TextEncoder().encode(stepText);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const ref = {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: checksum,
      logicalBytes: bytes.byteLength
    } as const;

    const cachingAdapter = await createExactKernelAdapter({
      resolveSourceBytes: async () => bytes
    });
    try {
      // Two features import the SAME file with different selections: the
      // second must be served by the file-level cache and still filter to
      // its own subset.
      const document = importStepBody(
        createProjectDocument('Shared parse', toUserId('user_exact')),
        {
          name: 'First half',
          artifactId: 'artifact_shared',
          sourceName: 'shared.step',
          stepSourceRef: ref,
          solidIndices: [0]
        }
      ).document;
      const firstBodyId = document.bodyOrder[0]!;
      const withSecond = importStepBody(document, {
        name: 'Second half',
        artifactId: 'artifact_shared',
        sourceName: 'shared.step',
        stepSourceRef: ref,
        solidIndices: [1]
      });
      const derived = await cachingAdapter.syncDocument(withSecond.document);
      expect(derived.warnings).toEqual([]);
      expect(
        derived.bodyRepresentations[firstBodyId]?.volume
      ).toBeCloseTo(1000, 4);
      expect(
        derived.bodyRepresentations[withSecond.bodyId]?.volume
      ).toBeCloseTo(8000, 4);
    } finally {
      cachingAdapter.dispose();
    }
  });

  it('drills simple, counterbore, and countersink holes with closed-form volumes', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Hole parity', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    const sourceBodyId = base.bodyOrder[0]!;
    const baseDerived = await adapter.syncDocument(base);
    // Drill into the top face (z = 20), so the axis is -Z.
    const top = baseDerived.bodyRepresentations[
      sourceBodyId
    ]?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs(face.geometry.center.z - 20) < 1e-6
    );
    expect(top).toBeTruthy();

    const drill = (
      overrides: Partial<Parameters<typeof holeBody>[1]>
    ): ReturnType<typeof holeBody> =>
      holeBody(base, {
        name: 'Bore',
        targetBodyId: sourceBodyId,
        faceHash: top!.hash,
        ...(top!.reference ? { faceReference: top!.reference } : {}),
        style: 'simple',
        diameter: 6,
        depthMode: 'through',
        position: { u: 0, v: 0 },
        ...overrides
      });

    // Through hole: a full-height cylinder of material leaves.
    const through = drill({});
    const throughDerived = await adapter.syncDocument(through.document);
    expect(throughDerived.warnings).toEqual([]);
    expect(
      throughDerived.bodyRepresentations[sourceBodyId]?.consumed
    ).toBe(true);
    expect(
      throughDerived.bodyRepresentations[through.bodyId]?.volume
    ).toBeCloseTo(8000 - Math.PI * 9 * 20, 4);

    // Blind hole: exactly the requested depth, floor intact.
    const blind = drill({ depthMode: 'blind', depth: 10 });
    const blindDerived = await adapter.syncDocument(blind.document);
    expect(blindDerived.warnings).toEqual([]);
    expect(blindDerived.bodyRepresentations[blind.bodyId]?.volume).toBeCloseTo(
      8000 - Math.PI * 9 * 10,
      4
    );

    // Counterbore: the wider seat removes an extra annular ring.
    const counterbore = drill({
      style: 'counterbore',
      counterboreDiameter: 10,
      counterboreDepth: 3
    });
    const counterboreDerived = await adapter.syncDocument(
      counterbore.document
    );
    expect(counterboreDerived.warnings).toEqual([]);
    expect(
      counterboreDerived.bodyRepresentations[counterbore.bodyId]?.volume
    ).toBeCloseTo(8000 - Math.PI * 9 * 20 - Math.PI * (25 - 9) * 3, 4);

    // Countersink at 90°: sink depth is (R - r), the frustum minus the bore
    // already counted leaves 36π of extra removal.
    const countersink = drill({
      style: 'countersink',
      countersinkDiameter: 12,
      countersinkAngleDeg: 90
    });
    const countersinkDerived = await adapter.syncDocument(
      countersink.document
    );
    expect(countersinkDerived.warnings).toEqual([]);
    expect(
      countersinkDerived.bodyRepresentations[countersink.bodyId]?.volume
    ).toBeCloseTo(8000 - Math.PI * 9 * 20 - Math.PI * 36, 4);

    // The kernel's own recognizer sees the through bore as one hole.
    const throughBody = throughDerived.bodyRepresentations[through.bodyId];
    expect(throughBody?.topology?.faces.length).toBeGreaterThan(6);
    const exported = await adapter.exportStep(through.document, [
      through.bodyId
    ]);
    await expect(adapter.inspectStep(exported)).resolves.toMatchObject({
      solid: true,
      valid: true
    });

    // A hole aimed off the body is a refusal in the feature's warnings,
    // never a silent no-op body.
    const missed = drill({ position: { u: 100, v: 0 } });
    const missedDerived = await adapter.syncDocument(missed.document);
    expect(missedDerived.warnings.join('\n')).toMatch(/Bore/);
    expect(missedDerived.bodyRepresentations[missed.bodyId]).toBeUndefined();
  });

  it('splits a body into two watertight halves whose volumes sum exactly', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Split parity', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    const sourceBodyId = base.bodyOrder[0]!;
    const split = addSplitFeature(base, {
      name: 'Half',
      targetBodyId: sourceBodyId,
      plane: { origin: { x: 5, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
    });
    const derived = await adapter.syncDocument(split.document);
    expect(derived.warnings).toEqual([]);
    // The input is consumed; its two halves are real, separately exportable
    // bodies. Positive is the side the plane normal points toward.
    expect(derived.bodyRepresentations[sourceBodyId]?.consumed).toBe(true);
    const positive = derived.bodyRepresentations[split.bodyId];
    const negative = derived.bodyRepresentations[split.secondBodyId];
    expect(positive?.consumed).toBe(false);
    expect(negative?.consumed).toBe(false);
    expect(positive?.volume).toBeCloseTo(15 * 20 * 20, 6);
    expect(negative?.volume).toBeCloseTo(5 * 20 * 20, 6);
    for (const bodyId of [split.bodyId, split.secondBodyId]) {
      const exported = await adapter.exportStep(split.document, [bodyId]);
      await expect(adapter.inspectStep(exported)).resolves.toMatchObject({
        solid: true,
        valid: true
      });
    }

    // A plane that misses the solid is a typed kernel refusal surfacing as
    // the feature's warning, never a silent no-op or a crash.
    const missed = addSplitFeature(base, {
      name: 'Missed',
      targetBodyId: sourceBodyId,
      plane: { origin: { x: 50, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
    });
    const missedDerived = await adapter.syncDocument(missed.document);
    expect(missedDerived.warnings.join('\n')).toMatch(/Missed/);
    expect(missedDerived.bodyRepresentations[missed.bodyId]).toBeUndefined();
    expect(
      missedDerived.bodyRepresentations[missed.secondBodyId]
    ).toBeUndefined();
  });

  it('keeps mirror, shell, and solid offset conformant on a modelled body', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Modeling parity', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const sourceBodyId = base.bodyOrder[0]!;
    const moved = transformBody(base, {
      name: 'Rotate source',
      targetBodyId: sourceBodyId,
      translation: { x: 4, y: -3, z: 2 },
      rotationDeg: { x: 15, y: 20, z: 35 }
    }).document;
    const mirrored = mirrorBody(moved, {
      name: 'Mirrored copy',
      targetBodyId: sourceBodyId,
      plane: {
        origin: { x: 12, y: 5, z: -2 },
        normal: { x: '1 / sqrt(2)', y: '1 / sqrt(2)', z: 0 }
      }
    }).document;
    const mirrorBodyId = mirrored.bodyOrder.at(-1)!;
    const mirrorDerived = await adapter.syncDocument(mirrored);
    expect(mirrorDerived.warnings).toEqual([]);
    expect(mirrorDerived.bodyRepresentations[sourceBodyId]?.volume).toBeCloseTo(
      6000,
      4
    );
    expect(mirrorDerived.bodyRepresentations[mirrorBodyId]?.volume).toBeCloseTo(
      6000,
      4
    );

    const sourceProjection = await adapter.syncDocument(base);
    const opening = sourceProjection.bodyRepresentations[
      sourceBodyId
    ]?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs(face.geometry.center.z - 30) < 1e-7
    );
    expect(opening).toBeTruthy();
    const shelled = shellBody(base, {
      name: 'Open shell',
      targetBodyId: sourceBodyId,
      openingFaceHashes: [opening!.hash],
      ...(opening!.reference
        ? { openingFaceReferences: [opening!.reference] }
        : {}),
      thickness: 1
    }).document;
    const shellBodyId = shelled.bodyOrder.at(-1)!;
    const offset = offsetSolidBody(base, {
      name: 'Outward offset',
      targetBodyId: sourceBodyId,
      distance: 1
    }).document;
    const offsetBodyId = offset.bodyOrder.at(-1)!;

    for (const [document, bodyId, expectedVolume] of [
      [shelled, shellBodyId, 6000 - 8 * 18 * 29],
      [offset, offsetBodyId, 12 * 22 * 32]
    ] as const) {
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId];
      expect(body?.consumed).toBe(false);
      expect(body?.volume).toBeCloseTo(expectedVolume, 3);
      const step = await adapter.exportStep(document, [bodyId]);
      await expect(adapter.inspectStep(step)).resolves.toMatchObject({
        solid: true,
        valid: true
      });
    }
  });

  it('surfaces a refused shell on a filleted body as a feature warning', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Shell refusal', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const sourceBodyId = base.bodyOrder[0]!;
    const source = await adapter.syncDocument(base);
    const edges = source.bodyRepresentations[sourceBodyId]!.topology!.edges;
    const filleted = filletEdges(base, {
      name: 'Rounded block',
      targetBodyId: sourceBodyId,
      edgeHashes: edges.map((edge) => edge.hash),
      size: 1
    }).document;
    const filletedBodyId = filleted.bodyOrder.at(-1)!;
    const rounded = await adapter.syncDocument(filleted);
    expect(rounded.warnings).toEqual([]);
    const opening = rounded.bodyRepresentations[
      filletedBodyId
    ]!.topology!.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs(face.geometry.center.z - 30) < 1e-7
    );
    expect(opening).toBeTruthy();

    const refused = shellBody(filleted, {
      name: 'Impossible shell',
      targetBodyId: filletedBodyId,
      openingFaceHashes: [opening!.hash],
      ...(opening!.reference
        ? { openingFaceReferences: [opening!.reference] }
        : {}),
      thickness: 100
    }).document;
    const shellBodyId = refused.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(refused);

    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toMatch(/^Feature "Impossible shell":/);
    expect(derived.bodyRepresentations[shellBodyId]).toBeUndefined();
    expect(derived.bodyRepresentations[filletedBodyId]?.consumed).toBe(false);
  });

  it.each([
    ['mm', 1],
    ['cm', 10],
    ['m', 1000],
    ['inch', 25.4]
  ] as const)(
    'exports %s documents at their physical millimetre scale',
    async (units, millimetersPerUnit) => {
      const document = addPrimitiveFeature(
        createProjectDocument('Unit export', toUserId('user_exact'), units),
        {
          name: 'Unit box',
          primitiveKind: 'box',
          dimensions: { width: 2, height: 3, depth: 4 }
        }
      );
      const step = await adapter.exportStep(document, [document.bodyOrder[0]!]);
      const inspection = await adapter.inspectStep(step);
      expect(inspection).toMatchObject({ solid: true, valid: true });
      expect(inspection.volume).toBeCloseTo(24 * millimetersPerUnit ** 3, 3);
    }
  );
});
