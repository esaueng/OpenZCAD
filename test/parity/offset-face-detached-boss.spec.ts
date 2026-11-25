/**
 * Offsetting a planar face must not carry a separate boss joined to it by a
 * fillet.
 *
 * The body, as a user built it: a 30 × 18 × 24 box fused with an r6, 28 tall
 * cylinder on the origin, an r1 fillet on five edges (the boss's seams with
 * the box's front and left faces, the boss's seam with the box top, and the
 * two top edges running from it) and a 0.5 chamfer around the whole bottom
 * ring. Offsetting the box's front face by +5 then −9 moved the boss 5 mm
 * toward the viewer and 9 mm back: the pinned kernel returned a clean, exact
 * body with the boss wall, both r1 rounds on it and its bottom chamfer
 * translated rigidly with the face, and the front face at its old area.
 * Saved models recorded the boss's axis at y = 4 while its Cylinder feature
 * still placed it on the origin.
 *
 * The adapter now refuses that result, typed, through both the drag preview
 * and the commit rebuild, and the boss stays on the origin. When the kernel
 * re-solves the round instead of carrying the boss, the offsets here build
 * and this spec should assert the boss's axis instead of the refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  booleanBodies,
  chamferEdges,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import { RemusKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type EdgeTopology,
  type FaceTopology,
  type FeatureWarning,
  type GeometryBodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

type Point = readonly [number, number, number];

/** The two ends of an edge's display polyline. */
function endsOf(edge: EdgeTopology): [Point, Point] {
  const p = edge.points;
  const n = p.length;
  return [
    [p[0]!, p[1]!, p[2]!],
    [p[n - 3]!, p[n - 2]!, p[n - 1]!]
  ];
}

const samePoint = (a: Point, b: Point) =>
  near(a[0], b[0]) && near(a[1], b[1]) && near(a[2], b[2]);

/** Whether `edge` runs between `a` and `b`, either way. */
function joins(edge: EdgeTopology, a: Point, b: Point): boolean {
  const [s, e] = endsOf(edge);
  return (
    (samePoint(s, a) && samePoint(e, b)) || (samePoint(s, b) && samePoint(e, a))
  );
}

interface Built {
  bodyRepresentations: Record<BodyId, GeometryBodyRepresentation>;
  warnings: string[];
  featureWarnings?: FeatureWarning[];
}

/** The r6 boss wall's axis foot, read from the face's exact witness. */
function bossAxisFoot(body: GeometryBodyRepresentation): number[] {
  const walls = body
    .topology!.faces.map((face) => face.reference?.witness.analytic)
    .filter(
      (analytic) =>
        analytic?.kind === 'cylinder' && analytic.radius === 6_000_000
    );
  expect(walls.length, 'the boss wall').toBeGreaterThan(0);
  const feet = walls.map((analytic) =>
    analytic?.kind === 'cylinder' ? analytic.axisFoot.map((v) => v / 1e6) : []
  );
  for (const foot of feet) expect(foot).toEqual(feet[0]);
  return feet[0]!;
}

describe('offset face beside a filleted boss', { timeout: 180_000 }, () => {
  let adapter: RemusKernelAdapter;
  let document: ProjectDocument;
  let bodyId: BodyId;
  let front: FaceTopology;

  beforeAll(async () => {
    adapter = new RemusKernelAdapter();
    let doc = addPrimitiveFeature(
      createProjectDocument('Filleted boss', toUserId('user_boss_offset')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      }
    );
    const box = doc.bodyOrder.at(-1)!;
    doc = addPrimitiveFeature(doc, {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 6, height: 28 }
    });
    const cylinder = doc.bodyOrder.at(-1)!;
    let fused = booleanBodies(doc, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [cylinder, box]
    });
    const edgesOf = async (target: BodyId) =>
      (await adapter.syncDocument(fused.document)).bodyRepresentations[target]!
        .topology!.edges;

    const seams = (await edgesOf(fused.bodyId)).filter(
      (edge) =>
        joins(edge, [0, 6, 0], [0, 6, 24]) ||
        joins(edge, [0, 6, 24], [0, 18, 24]) ||
        joins(edge, [0, 6, 24], [6, 0, 24]) ||
        joins(edge, [6, 0, 24], [30, 0, 24]) ||
        joins(edge, [6, 0, 0], [6, 0, 24])
    );
    expect(seams).toHaveLength(5);
    fused = filletEdges(fused.document, {
      name: 'Fillet',
      targetBodyId: fused.bodyId,
      size: 1,
      edgeHashes: seams.map((edge) => edge.hash),
      edgeReferences: seams.map((edge) => edge.reference!)
    });

    // Every edge of the bottom face: the box's four sides, the boss's
    // three arcs and the feet of the two vertical rounds.
    const ring = (await edgesOf(fused.bodyId)).filter((edge) => {
      const p = edge.points;
      for (let i = 2; i < p.length; i += 3) if (!near(p[i]!, 0)) return false;
      return true;
    });
    expect(ring).toHaveLength(9);
    fused = chamferEdges(fused.document, {
      name: 'Chamfer',
      targetBodyId: fused.bodyId,
      size: 0.5,
      edgeHashes: ring.map((edge) => edge.hash),
      ...(ring.every((edge) => edge.reference)
        ? { edgeReferences: ring.map((edge) => edge.reference!) }
        : {})
    });
    document = fused.document;
    bodyId = fused.bodyId;

    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[bodyId]!;
    expect(bossAxisFoot(body)).toEqual([0, 0, 0]);
    front = body
      .topology!.faces.filter(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.normal!.y < -0.999 &&
          near(face.geometry.center.y, 0)
      )
      .sort((a, b) => b.geometry!.area - a.geometry!.area)[0]!;
    expect(front).toBeDefined();
  });

  afterAll(() => {
    adapter.dispose();
  });

  function offsetBy(offset: number): ProjectDocument {
    return commandFactories
      .directEditBody({
        name: 'Offset Face',
        targetBodyId: bodyId,
        operation: {
          kind: 'offset-face',
          faceHash: front.hash,
          ...(front.reference ? { faceReference: front.reference } : {}),
          sourceSurfaceType: 'plane',
          sourceArea: front.geometry!.area,
          sourceCenter: front.geometry!.center,
          sourceNormal: front.geometry!.normal!,
          offset,
          ambiguousRim: 'refuse'
        }
      })
      .apply(document);
  }

  /** The preview a drag shows, then the rebuild a commit runs. */
  async function builds(candidate: ProjectDocument): Promise<Built[]> {
    return [
      await adapter.previewGeometry(candidate, { deferTopology: true }),
      await adapter.syncDocument(candidate)
    ];
  }

  for (const offset of [5, -3]) {
    it(`refuses ${offset} rather than carrying the boss with the face`, async () => {
      const candidate = offsetBy(offset);
      const [preview, committed] = await builds(candidate);
      for (const built of [preview!, committed!]) {
        const refusal = (built.featureWarnings ?? []).find(
          (warning) =>
            warning.featureName === 'Offset Face' &&
            (warning.kind === 'build-failed' || warning.kind === 'refusal')
        );
        expect(refusal, 'the offset is refused').toBeDefined();
        expect(refusal!.kernelRefusal).toMatchObject({
          family: 'direct-edit',
          category: 'unsupported',
          code: 'offset_face_carried_detached_support'
        });
        expect(refusal!.message).toContain('separate curved feature');
      }
      // Whatever the rebuild keeps, the boss is still on the origin.
      const body = committed!.bodyRepresentations[bodyId];
      if (body?.topology) expect(bossAxisFoot(body)).toEqual([0, 0, 0]);
    });
  }
});
