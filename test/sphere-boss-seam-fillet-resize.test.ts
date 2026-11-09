import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import type { BodyId, FaceTopology, ProjectDocument } from '@openzcad/shared';
import { listFeaturesInOrder } from '@openzcad/document-core';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { sphereCylinderUnionInputs } from './support/sphere-cylinder-union';
import { inspectTriangleMeshClosure } from '../packages/kernel-adapter/src/boolean-result-validation';

/**
 * The owner's original 2026-11-05 case: a direct diameter edit of a boss that
 * grows out of a sphere, with its seam rounded by an R2 fillet
 * (docs/plans/kernel-robustness-plan-2026-11-05.md, WS6/WS7, reference R2).
 *
 * An imported body has no source dimension, so the only route is local. The
 * kernel's detailed resize removes the seam band, resizes the sharp wall and
 * rolls the R2 ball back onto the new seam in one call. The off-axis band has
 * no exact form, so under the owner's 2026-11-06 rule it comes back at the
 * approximate quality it already had, disclosed, and must match the body the
 * source route builds. The second block pins the remaining kernel gaps for
 * the adapter's own WS6 ladder: when a Remus pin bump makes one of them
 * succeed, the tripwire identifies which step can now be built.
 */

const SEAM_FILLET = 2;
const APPROXIMATE_REBLEND =
  'The fillet along this wall was rebuilt at its new size as an approximate surface, as it was before: a NURBS fit within modeling tolerance. Volume, measurements and STEP export use that approximate surface.';

describe('direct resize of a seam-filleted boss on a sphere', () => {
  let adapter: ExactKernelAdapter;
  let document: ProjectDocument;
  let bodyId: BodyId;
  let wall: FaceTopology;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    const inputs = sphereCylinderUnionInputs();
    const manager = new CommandManager(inputs.document);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Combine',
        operation: 'union',
        targetBodyIds: [inputs.sphere, inputs.cylinder]
      })
    );
    const unionId = manager.document.bodyOrder.at(-1)!;
    const union = await adapter.syncDocument(manager.document);
    expect(union.warnings).toEqual([]);
    const topology = union.bodyRepresentations[unionId]!.topology!;
    const boss = topology.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    const sphereFaces = new Set(
      topology.faces
        .filter((face) => face.geometry?.surfaceType === 'sphere')
        .map((face) => face.hash)
    );
    // The seam is the off-axis cylinder/sphere intersection: one closed
    // space curve, split across the sphere's two hemisphere patches.
    const seam = topology.edges.filter(
      (edge) =>
        edge.displayRole !== 'seam' &&
        edge.adjacentFaceHashes?.includes(boss.hash) &&
        edge.adjacentFaceHashes.some((hash) => sphereFaces.has(hash))
    );
    expect(seam.length).toBeGreaterThan(0);
    const references = seam.map((edge) => edge.reference);
    manager.execute(
      commandFactories.filletEdges({
        name: 'Fillet seam',
        targetBodyId: unionId,
        edgeHashes: seam.map((edge) => edge.hash),
        ...(references.every((reference) => reference !== undefined)
          ? { edgeReferences: references }
          : {}),
        size: SEAM_FILLET
      })
    );
    document = manager.document;
    bodyId = document.bodyOrder.at(-1)!;
    const filleted = await adapter.syncDocument(document);
    expect(
      filleted.featureWarnings?.filter((entry) => entry.kind !== 'advisory')
    ).toEqual([]);
    const faces = filleted.bodyRepresentations[bodyId]!.topology!.faces;
    // The band between an off-axis cylinder and a sphere has no analytic
    // form: the fillet builds it as one freeform face.
    expect(
      faces.filter((face) => face.geometry?.surfaceType === 'bspline')
    ).toHaveLength(1);
    wall = faces.find(
      (face) =>
        face.geometry?.surfaceType === 'cylinder' &&
        Math.abs((face.geometry.radius ?? 0) - 6) < 1e-6
    )!;
  }, 600_000);

  afterAll(() => {
    adapter.dispose();
  });

  function resized(radius: number): ProjectDocument {
    return new CommandManager(document).runTransaction('Resize', [
      commandFactories.directEditBody({
        name: 'Resize Cylinder',
        targetBodyId: bodyId,
        operation: {
          kind: 'resize-cylindrical-face',
          faceHash: wall.hash,
          ...(wall.reference ? { faceReference: wall.reference } : {}),
          sourceRadius: 6,
          sourceAxisStart: wall.geometry!.axisStart!,
          sourceAxisEnd: wall.geometry!.axisEnd!,
          concavity: 'boss',
          radius
        }
      })
    ]);
  }

  /** The source route: the same history with the Cylinder itself resized. */
  async function sourceRouteVolume(radius: number): Promise<number> {
    const manager = new CommandManager(document);
    const cylinder = listFeaturesInOrder(manager.document).find(
      (feature) => feature.name === 'Cylinder'
    )!;
    if (cylinder.data.featureKind !== 'primitive') {
      throw new Error('The boss source is not a primitive.');
    }
    manager.execute(
      commandFactories.updateFeature(
        {
          featureId: cylinder.featureId,
          data: { dimensions: { ...cylinder.data.dimensions, radius } }
        },
        'Resize source'
      )
    );
    const derived = await adapter.syncDocument(manager.document);
    expect(
      derived.featureWarnings?.filter((entry) => entry.kind !== 'advisory')
    ).toEqual([]);
    return derived.bodyRepresentations[manager.document.bodyOrder.at(-1)!]!
      .volume;
  }

  it.each([7, 5, 6.3, 12])(
    'resizes r 6 → %d, re-filleting the seam at its approximate quality, disclosed',
    async (radius) => {
      const derived = await adapter.syncDocument(resized(radius));
      const warnings = (derived.featureWarnings ?? []).filter(
        (entry) => entry.featureName === 'Resize Cylinder'
      );
      // The owner's 2026-11-06 rule: the band was a NURBS fit before the
      // edit, so it may come back as one, and the edit says so.
      expect(warnings.map((entry) => entry.kind)).toEqual(['advisory']);
      expect(warnings[0]!.message).toContain(APPROXIMATE_REBLEND);
      const body = derived.bodyRepresentations[bodyId]!;
      const faces = body.topology!.faces;
      expect(
        faces.filter(
          (face) =>
            face.geometry?.surfaceType === 'cylinder' &&
            Math.abs((face.geometry.radius ?? 0) - radius) < 1e-6
        )
      ).toHaveLength(1);
      // One band, rebuilt on the new seam rather than left at the old size.
      expect(
        faces.filter((face) => face.geometry?.surfaceType === 'bspline')
      ).toHaveLength(1);
      expect(faces).toHaveLength(5);
      expect(body.exportableStep).toBe(true);
      expect(
        inspectTriangleMeshClosure(body.mesh.vertices, body.mesh.indices)
      ).toMatchObject({
        boundaryEdges: 0,
        nonManifoldEdges: 0,
        inconsistentWindingEdges: 0
      });
      // The direct edit and the source edit build the same body: both are
      // the sphere ∪ an r-`radius` boss with an R2 rolling-ball seam.
      const source = await sourceRouteVolume(radius);
      expect(Math.abs(body.volume - source)).toBeLessThan(
        Math.max(0.05, 1e-7 * source)
      );
    },
    600_000
  );

  it('refuses typed when the ball no longer rolls on the new seam, keeping the body', async () => {
    const before = await adapter.syncDocument(document);
    const derived = await adapter.syncDocument(resized(1));
    const warning = derived.featureWarnings?.find(
      (entry) => entry.featureName === 'Resize Cylinder'
    );
    expect(warning?.kind).toBe('build-failed');
    expect(warning?.kernelRefusal).toMatchObject({
      family: 'direct-edit',
      operation: 'resize-cylindrical-face'
    });
    expect(derived.bodyRepresentations[bodyId]!.volume).toBe(
      before.bodyRepresentations[bodyId]!.volume
    );
  }, 600_000);
});

const translation = (x: number, y: number, z: number) =>
  new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);

/** The boss on the sphere, raw: off-axis as reported, or coaxial. */
function bossOnSphere(kernel: RemusKernel, coaxial: boolean) {
  const sphere = kernel.makeSphere(73.5, 64);
  if (!coaxial) kernel.transformSolid(sphere, translation(25.5, -1.5, 0));
  const boss = kernel.makeCylinder(6, 64.10000000000001);
  kernel.transformSolid(boss, translation(0, 0, 58));
  const solid = kernel.fuse(sphere, boss);
  const faces = Array.from(kernel.getSolidFaces(solid));
  const wall = faces.find(
    (face) => kernel.getSurfaceType(face) === 'cylinder'
  )!;
  const wallEdges = new Set(kernel.getFaceEdges(wall));
  const seam = faces
    .filter((face) => kernel.getSurfaceType(face) === 'sphere')
    .flatMap((face) => Array.from(kernel.getFaceEdges(face)))
    .filter((edge) => wallEdges.has(edge));
  return { solid, seam: Uint32Array.from(new Set(seam)) };
}

function bandOf(kernel: RemusKernel, solid: number, surfaceType: string) {
  const bands = Array.from(kernel.getSolidFaces(solid)).filter(
    (face) => kernel.getSurfaceType(face) === surfaceType
  );
  expect(bands).toHaveLength(1);
  return bands[0]!;
}

const NOW_POSSIBLE =
  'The pinned kernel can now do this WS6 step; extend exact-direct-edit-reblend.ts to use it and update this tripwire.';

describe('why the WS6 remove → resize → re-blend ladder cannot run on this pin', () => {
  it('cannot rebuild the off-axis seam band exactly: it has no exact form', () => {
    const kernel = new RemusKernel();
    const { solid, seam } = bossOnSphere(kernel, false);
    const exact = kernel.filletDetailed(solid, seam, SEAM_FILLET, true);
    expect(exact.status, NOW_POSSIBLE).toBe('error');
    expect(exact.details).toMatchObject({
      kernelCode: 'exact_only_unattainable'
    });
    const any = kernel.filletDetailed(solid, seam, SEAM_FILLET, false);
    expect(any.status).toBe('ok');
    expect(any.details).toMatchObject({ quality: 'approximate' });
  }, 120_000);

  it('cannot recognise or remove the off-axis freeform seam band', () => {
    const kernel = new RemusKernel();
    const { solid, seam } = bossOnSphere(kernel, false);
    const filleted = kernel.filletDetailed(solid, seam, SEAM_FILLET, false);
    expect(filleted.status).toBe('ok');
    const body = filleted.value!;
    const band = bandOf(kernel, body, 'bspline');
    expect(() => kernel.getBlendRegion(body, band), NOW_POSSIBLE).toThrow(
      /not an analytic torus\/cylinder\/sphere blend: nurbs/
    );
    expect(
      () => kernel.resizeBlend(body, band, SEAM_FILLET, 0),
      NOW_POSSIBLE
    ).toThrow();
    expect(
      () => kernel.removeBlendsJournaled(body, Uint32Array.of(band)),
      NOW_POSSIBLE
    ).toThrow();
    // Defeaturing caps the gap only against planar neighbours.
    expect(
      () => kernel.defeature(body, Uint32Array.of(band)),
      NOW_POSSIBLE
    ).toThrow(/only implemented for planar wound neighbors/);
  }, 120_000);

  it('removes the exact torus band of a coaxial boss as a closed valid solid', () => {
    const kernel = new RemusKernel();
    const { solid, seam } = bossOnSphere(kernel, true);
    const filleted = kernel.filletDetailed(solid, seam, SEAM_FILLET, true);
    expect(filleted.status).toBe('ok');
    expect(filleted.details).toMatchObject({ quality: 'exact' });
    const body = filleted.value!;
    const band = bandOf(kernel, body, 'torus');
    expect(JSON.parse(kernel.getBlendRegion(body, band))).toEqual({
      faces: [band],
      radius: SEAM_FILLET
    });
    const sharp = kernel.resizeBlend(body, band, SEAM_FILLET, 0);
    expect(kernel.validateSolid(sharp)).toBe(0);
    expect(
      [...kernel.getSolidFaces(sharp)].map((face) =>
        kernel.getSurfaceType(face)
      )
    ).not.toContain('torus');
    const mesh = kernel.tessellateSolidGroupedBinary(sharp, 0.02, 0.06);
    try {
      expect(
        inspectTriangleMeshClosure(mesh.positions, mesh.indices)
      ).toMatchObject({
        boundaryEdges: 0,
        nonManifoldEdges: 0,
        inconsistentWindingEdges: 0
      });
    } finally {
      mesh.free();
    }
  }, 120_000);
});
