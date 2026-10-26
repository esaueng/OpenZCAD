import { afterEach, describe, expect, it } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { chamferedCylinderSolid } from './support/chamfered-cylinder';
import { tryExactChamferedCylinderCapOffset } from '../packages/kernel-adapter/src/exact-chamfered-cylinder';

const adapters: Awaited<ReturnType<typeof createExactKernelAdapter>>[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
});

function cap(body: BodyRepresentation, sense: number): FaceTopology {
  return body.topology!.faces.find(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      sense * face.geometry.normal!.z > 0.99
  )!;
}

async function fixture(
  options: { topChamfer?: boolean; mirrored?: boolean } = {}
) {
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  const solid = chamferedCylinderSolid(kernel, options);
  const stepText = new TextDecoder().decode(
    io.exportStep(kernel.serializeSolid(solid))
  );
  kernel.free();
  const adapter = await createExactKernelAdapter();
  adapters.push(adapter);
  const imported = importStepBody(
    createProjectDocument('Chamfered rod', toUserId('user_test')),
    {
      name: 'Rod',
      sourceName: 'rod.step',
      artifactId: 'artifact_rod',
      stepText
    }
  );
  const document = imported.document;
  const derived = await adapter.syncDocument(document);
  expect(derived.warnings).toEqual([]);
  document.derived = derived;
  return {
    adapter,
    document,
    bodyId: imported.bodyId,
    before: derived.bodyRepresentations[imported.bodyId]!
  };
}

describe('chamfer-preserving imported cylinder cap offsets', () => {
  it.each([
    { mirrored: false, sense: -1, offset: 60 },
    { mirrored: false, sense: -1, offset: -20 },
    { mirrored: false, sense: -1, offset: -235 },
    { mirrored: false, sense: 1, offset: 60 },
    { mirrored: true, sense: -1, offset: 60 },
    { mirrored: true, sense: 1, offset: -20 }
  ])(
    'moves the cap and keeps both bevels (%j)',
    async ({ mirrored, sense, offset }) => {
      const { adapter, document, bodyId, before } = await fixture({ mirrored });
      const picked = cap(before, sense);
      const opposite = cap(before, -sense);
      expect(picked.geometry!.area).toBeCloseTo(Math.PI * 8 ** 2, 5);
      const plan = planFaceOffset({
        document,
        bodyId,
        face: picked,
        faceHash: picked.hash,
        offset
      });
      expect(plan?.kind).toBe('direct-edit');
      const manager = new CommandManager(document);
      manager.execute(plan!.command);
      const derived = await adapter.syncDocument(manager.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId]!;
      expect(body.faceCount).toBe(5);
      expect(cap(body, sense).geometry!.center.z).toBeCloseTo(
        picked.geometry!.center.z + sense * offset,
        6
      );
      const fixed = cap(body, -sense).geometry!;
      expect(fixed.normal).toEqual(opposite.geometry!.normal);
      expect(fixed.planeOffset).toBeCloseTo(
        opposite.geometry!.planeOffset!,
        10
      );
      expect(fixed.area).toBeCloseTo(opposite.geometry!.area, 7);
      expect(cap(body, sense).geometry!.area).toBeCloseTo(
        picked.geometry!.area,
        6
      );
      expect(body.volume - before.volume).toBeCloseTo(
        Math.PI * 10 ** 2 * offset,
        1
      );
      const step = await adapter.exportStep(manager.document, [bodyId]);
      const kernel = new RemusKernel();
      try {
        const io = await loadRemusTranslators();
        const [solid] = kernel.deserializeSolids(
          io.importStep(new TextEncoder().encode(step))
        );
        expect(kernel.validateSolid(solid!)).toBe(0);
        const cones = [...kernel.getSolidFaces(solid!)].filter(
          (face) => kernel.getSurfaceType(face) === 'cone'
        );
        expect(cones).toHaveLength(2);
        for (const cone of cones) {
          const parameters = JSON.parse(
            kernel.getAnalyticSurfaceParams(cone)
          ) as { halfAngle: number };
          expect(parameters.halfAngle).toBeCloseTo(Math.PI / 4, 10);
          const radii = [...kernel.getFaceEdges(cone)]
            .filter((edge) => kernel.getEdgeCurveType(edge) === 'CIRCLE')
            .map((edge) => 1 / kernel.measureCurvatureAtEdge(edge, 0)[0]!)
            .sort((a, b) => a - b);
          expect(radii[0]).toBeCloseTo(8, 7);
          expect(radii[1]).toBeCloseTo(10, 7);
        }
      } finally {
        kernel.free();
      }
    }
  );

  it('moves a single chamfer, retains face references, and replays a second offset', async () => {
    const { adapter, document, bodyId, before } = await fixture({
      topChamfer: false
    });
    const picked = cap(before, -1);
    const manager = new CommandManager(document);
    manager.execute(
      planFaceOffset({
        document,
        bodyId,
        face: picked,
        faceHash: picked.hash,
        offset: 60
      })!.command
    );
    const first = await adapter.syncDocument(manager.document);
    expect(first.warnings).toEqual([]);
    const moved = cap(first.bodyRepresentations[bodyId]!, -1);
    expect(moved.reference?.lineageName).toBe(picked.reference?.lineageName);
    expect(moved.reference?.producingFeatureId).toBe(
      picked.reference?.producingFeatureId
    );
    manager.commitDerivedState(first);
    manager.execute(
      planFaceOffset({
        document: manager.document,
        bodyId,
        face: moved,
        faceHash: moved.hash,
        offset: 1
      })!.command
    );
    const fresh = await createExactKernelAdapter();
    adapters.push(fresh);
    const replayed = await fresh.syncDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(replayed.warnings).toEqual([]);
    expect(
      cap(replayed.bodyRepresentations[bodyId]!, -1).geometry!.center.z
    ).toBeCloseTo(-61, 6);
    expect(replayed.bodyRepresentations[bodyId]!.faceCount).toBe(4);
  });

  it('refuses a shortening that consumes the wall and keeps the source body', async () => {
    const { adapter, document, bodyId, before } = await fixture();
    const picked = cap(before, -1);
    const manager = new CommandManager(document);
    manager.execute(
      planFaceOffset({
        document,
        bodyId,
        face: picked,
        faceHash: picked.hash,
        offset: -237
      })!.command
    );
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings.join('\n')).toMatch(/no cylindrical wall/i);
    expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      before.volume,
      6
    );
    expect(cap(derived.bodyRepresentations[bodyId]!, -1).geometry).toEqual(
      picked.geometry
    );
  });

  it('edits only the chamfered solid in an imported compound', async () => {
    const kernel = new RemusKernel();
    const io = await loadRemusTranslators();
    const rod = chamferedCylinderSolid(kernel);
    const sibling = kernel.makeBox(2, 3, 4);
    const stepText = new TextDecoder().decode(
      io.exportStep(kernel.serializeSolids(Uint32Array.of(sibling, rod)))
    );
    kernel.free();
    const imported = importStepBody(
      createProjectDocument('Compound rods', toUserId('user_test')),
      {
        name: 'Components',
        sourceName: 'components.step',
        artifactId: 'artifact_compound',
        stepText
      }
    );
    const adapter = await createExactKernelAdapter();
    adapters.push(adapter);
    const derived = await adapter.syncDocument(imported.document);
    const document = { ...imported.document, derived };
    const before = derived.bodyRepresentations[imported.bodyId]!;
    const picked = before.topology!.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        face.geometry.normal!.z < -0.99 &&
        face.geometry.area > 200
    )!;
    const manager = new CommandManager(document);
    manager.execute(
      planFaceOffset({
        document,
        bodyId: imported.bodyId,
        face: picked,
        faceHash: picked.hash,
        offset: 60
      })!.command
    );
    const after = await adapter.syncDocument(manager.document);
    expect(after.warnings).toEqual([]);
    const edited = after.bodyRepresentations[imported.bodyId]!;
    expect(edited.faceCount).toBe(11);
    const boxFaces = (body: BodyRepresentation) =>
      body
        .topology!.faces.filter(
          (face) =>
            face.geometry?.surfaceType === 'plane' && face.geometry.area < 20
        )
        .map((face) => ({
          hash: face.hash,
          reference: face.reference,
          geometry: face.geometry
        }))
        .sort((a, b) => a.hash - b.hash);
    expect(boxFaces(before)).toHaveLength(6);
    expect(boxFaces(edited)).toEqual(boxFaces(before));
    expect(edited.volume - before.volume).toBeCloseTo(Math.PI * 100 * 60, 1);
  });

  it('supports a rotated, translated rod with unequal chamfer setbacks without changing its source', () => {
    const kernel = new RemusKernel();
    try {
      const base = kernel.makeCylinder(10, 240);
      const rims = [...kernel.getSolidEdges(base)].filter(
        (edge) => kernel.getEdgeCurveType(edge) === 'CIRCLE'
      );
      const solid = kernel.copyAndTransformSolid(
        kernel.chamferV2(base, Uint32Array.from(rims), 2, 1),
        Float64Array.of(0, 0, 1, 50, 0, 1, 0, 30, -1, 0, 0, 10, 0, 0, 0, 1)
      );
      const source = kernel.serializeSolid(solid);
      const cap = [...kernel.getSolidFaces(solid)].find(
        (face) =>
          kernel.getSurfaceType(face) === 'plane' &&
          kernel.getFaceNormal(face)[0]! < -0.99
      )!;
      const result = tryExactChamferedCylinderCapOffset(kernel, solid, cap, 60);
      expect(result).not.toBeNull();
      expect(kernel.validateSolid(result!.solid)).toBe(0);
      expect(
        kernel.volume(result!.solid, 0.001) - kernel.volume(solid, 0.001)
      ).toBeCloseTo(Math.PI * 100 * 60, 1);
      expect(kernel.boundingBox(result!.solid)[0]).toBeCloseTo(
        kernel.boundingBox(solid)[0]! - 60,
        7
      );
      expect(kernel.boundingBox(result!.solid)[3]).toBeCloseTo(
        kernel.boundingBox(solid)[3]!,
        7
      );
      expect(kernel.serializeSolid(solid)).toEqual(source);
    } finally {
      kernel.free();
    }
  });

  it('declines tubes, non-cap selections, and noncylindrical parts', () => {
    const kernel = new RemusKernel();
    try {
      const rod = chamferedCylinderSolid(kernel);
      const cone = [...kernel.getSolidFaces(rod)].find(
        (face) => kernel.getSurfaceType(face) === 'cone'
      )!;
      expect(
        tryExactChamferedCylinderCapOffset(kernel, rod, cone, 60)
      ).toBeNull();
      const tube = kernel.cut(rod, kernel.makeCylinder(2, 240));
      const cap = [...kernel.getSolidFaces(tube)].find(
        (face) => kernel.getSurfaceType(face) === 'plane'
      )!;
      expect(
        tryExactChamferedCylinderCapOffset(kernel, tube, cap, 60)
      ).toBeNull();
      const box = kernel.makeBox(10, 10, 10);
      expect(
        tryExactChamferedCylinderCapOffset(
          kernel,
          box,
          kernel.getSolidFaces(box)[0]!,
          60
        )
      ).toBeNull();
    } finally {
      kernel.free();
    }
  });
});
