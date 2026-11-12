import { describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  directEditBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DerivedState,
  type FaceTopology,
  type FeatureWarning,
  type ProjectDocument
} from '@openzcad/shared';
import { previewDisplayTessellation } from '../packages/kernel-adapter/src/display-tessellation';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { filletedUnion } from './support/filleted-union';

/**
 * A released face drag or cylinder resize is accepted with the drag
 * tessellation it was last drawn with; every check, measurement and quantity
 * is the complete sync's. The next complete sync of the same result publishes
 * exactly what a full-quality commit would have.
 */

const TOP = 'boolean.face.operand.1.primitive.box.face.z-max';

function faceNamed(body: BodyRepresentation, lineageName: string) {
  const face = body.topology?.faces.find(
    (candidate) => candidate.reference?.lineageName === lineageName
  );
  if (!face) throw new Error(`No face ${lineageName}.`);
  return face;
}

function offsetTop(
  document: ProjectDocument,
  bodyId: BodyId,
  top: FaceTopology,
  offset: number
): ProjectDocument {
  return directEditBody(document, {
    name: 'Offset top',
    targetBodyId: bodyId,
    operation: {
      kind: 'offset-face',
      faceHash: top.hash,
      faceReference: top.reference,
      sourceSurfaceType: 'plane',
      sourceArea: top.geometry!.area,
      sourceCenter: top.geometry!.center,
      sourceNormal: top.geometry!.normal!,
      offset
    }
  }).document;
}

/** Everything but the display mesh and the face triangle ranges. */
function exactParts(derived: DerivedState) {
  const {
    updatedAt: _updatedAt,
    bodyRepresentations,
    ...rest
  } = structuredClone(derived);
  return {
    ...rest,
    bodies: Object.values(bodyRepresentations).map(
      ({ mesh: _mesh, displayQuality: _quality, bbox: _bbox, ...body }) => ({
        ...body,
        topology: body.topology && {
          ...body.topology,
          faces: body.topology.faces.map(
            ({ triangleStart: _start, triangleCount: _count, ...face }) => face
          )
        }
      })
    )
  };
}

const gapAdvisories = (warnings: readonly FeatureWarning[] | undefined) =>
  (warnings ?? []).filter(
    (warning) =>
      warning.kind === 'advisory' &&
      warning.message.includes('display mesh has gaps')
  );

/** The drag tessellation's angular deflection, distinct from full quality. */
const DRAG_ANGULAR = previewDisplayTessellation({
  linearDeflection: 1,
  angularDeflection: 0
}).angularDeflection;

/**
 * Leaves the last face's triangles out of every grouped mesh at the drag
 * tessellation (`gapsAt: 'drag'`) or at any other one (`'full'`), as the
 * Remus defect behind the display-gap advisory does at some deflections.
 */
function stubDisplayGaps(gapsAt: 'drag' | 'full') {
  const original = RemusKernel.prototype.tessellateSolidGroupedBinary;
  return vi
    .spyOn(RemusKernel.prototype, 'tessellateSolidGroupedBinary')
    .mockImplementation(function (this: RemusKernel, ...args) {
      const mesh = original.apply(this, args);
      if ((args[2] === DRAG_ANGULAR) !== (gapsAt === 'drag')) return mesh;
      try {
        const offsets = mesh.faceOffsets.slice();
        const last = offsets.length - 1;
        const indices = mesh.indices.slice(0, offsets[last - 1]);
        offsets[last] = offsets[last - 1]!;
        return {
          positions: mesh.positions.slice(),
          indices,
          faceOffsets: offsets,
          free() {}
        } as unknown as ReturnType<typeof original>;
      } finally {
        mesh.free();
      }
    });
}

function withoutClock(derived: DerivedState) {
  const { updatedAt: _updatedAt, ...rest } = derived;
  return rest;
}

async function withAdapters<T>(
  run: (dragged: ExactKernelAdapter, plain: ExactKernelAdapter) => Promise<T>
): Promise<T> {
  const dragged = await createExactKernelAdapter();
  const plain = await createExactKernelAdapter();
  try {
    return await run(dragged, plain);
  } finally {
    dragged.dispose();
    plain.dispose();
  }
}

describe('draft display on a released direct edit', () => {
  it('accepts a face drag with its drag mesh, then refines to the full-quality result', async () => {
    await withAdapters(async (dragged, plain) => {
      const model = await filletedUnion(dragged, { heightEdit: false });
      const top = faceNamed(model.body, TOP);
      const released = offsetTop(model.document, model.bodyId, top, -3);
      // The same history and held deflections, committed without a drag.
      await plain.syncDocument(model.document);
      const reference = await plain.syncDocument(released);
      expect(
        reference.bodyRepresentations[model.bodyId]!.displayQuality
      ).toBeUndefined();

      for (const offset of [-2, -2.5, -3])
        await dragged.previewGeometry(
          offsetTop(model.document, model.bodyId, top, offset),
          { deferTopology: true }
        );
      const draft = await dragged.syncDocument(released);
      const draftBody = draft.bodyRepresentations[model.bodyId]!;
      const referenceBody = reference.bodyRepresentations[model.bodyId]!;
      expect(draftBody.displayQuality).toBe('draft');
      // Coarser, but every check and exact quantity is the complete one.
      expect(draftBody.mesh.indices.length).toBeLessThan(
        referenceBody.mesh.indices.length
      );
      expect(exactParts(draft)).toEqual(exactParts(reference));
      expect(
        draftBody.topology!.faces.reduce(
          (sum, face) => sum + face.triangleCount,
          0
        )
      ).toBe(draftBody.mesh.indices.length / 3);
      // The draft box is still a valid bound, within the drag deflection.
      for (const side of ['min', 'max'] as const)
        for (const axis of ['x', 'y', 'z'] as const)
          expect(
            Math.abs(
              draftBody.bbox[side][axis] - referenceBody.bbox[side][axis]
            )
          ).toBeLessThan(0.1);

      // The next complete sync of the same result swaps in the full mesh.
      const refined = await dragged.syncDocument(released);
      expect(withoutClock(refined)).toEqual(withoutClock(reference));

      // Exports never read a display mesh.
      expect(await dragged.exportStl(released, [model.bodyId], 0.08)).toBe(
        await plain.exportStl(released, [model.bodyId], 0.08)
      );
    });
  }, 120_000);

  it('never raises the display-gap advisory from a draft mesh', async () => {
    // A draft whose drag mesh has gaps while the full-quality one is closed:
    // the accepted commit's warnings are the full-quality commit's.
    await withAdapters(async (dragged, plain) => {
      const model = await filletedUnion(dragged, { heightEdit: false });
      const top = faceNamed(model.body, TOP);
      const released = offsetTop(model.document, model.bodyId, top, -3);
      await plain.syncDocument(model.document);
      const reference = await plain.syncDocument(released);
      for (const offset of [-2, -3])
        await dragged.previewGeometry(
          offsetTop(model.document, model.bodyId, top, offset),
          { deferTopology: true }
        );
      const spy = stubDisplayGaps('drag');
      try {
        const draft = await dragged.syncDocument(released);
        expect(draft.bodyRepresentations[model.bodyId]!.displayQuality).toBe(
          'draft'
        );
        expect(gapAdvisories(reference.featureWarnings)).toEqual([]);
        expect(draft.featureWarnings).toEqual(reference.featureWarnings);
        expect(draft.warnings).toEqual(reference.warnings);
        const refined = await dragged.syncDocument(released);
        expect(refined.featureWarnings).toEqual(reference.featureWarnings);
      } finally {
        spy.mockRestore();
      }
    });
  }, 120_000);

  it('raises a full-quality mesh gap with the refinement', async () => {
    // The opposite: only the full-quality mesh has gaps. The draft commit
    // cannot know that without the tessellation it exists to skip, so the
    // advisory arrives with the refinement, which equals a full commit.
    await withAdapters(async (dragged, plain) => {
      const model = await filletedUnion(dragged, { heightEdit: false });
      const top = faceNamed(model.body, TOP);
      const released = offsetTop(model.document, model.bodyId, top, -3);
      await plain.syncDocument(model.document);
      for (const offset of [-2, -3])
        await dragged.previewGeometry(
          offsetTop(model.document, model.bodyId, top, offset),
          { deferTopology: true }
        );
      const spy = stubDisplayGaps('full');
      try {
        const reference = await plain.syncDocument(released);
        expect(gapAdvisories(reference.featureWarnings)).toHaveLength(1);
        const draft = await dragged.syncDocument(released);
        expect(draft.bodyRepresentations[model.bodyId]!.displayQuality).toBe(
          'draft'
        );
        expect(gapAdvisories(draft.featureWarnings)).toEqual([]);
        // Every other warning is already the full commit's.
        expect(draft.featureWarnings).toEqual(
          (reference.featureWarnings ?? []).filter(
            (warning) => !gapAdvisories([warning]).length
          )
        );
        const refined = await dragged.syncDocument(released);
        expect(refined.bodyRepresentations[model.bodyId]!.displayQuality).toBe(
          undefined
        );
        expect(refined.featureWarnings).toEqual(reference.featureWarnings);
        expect(refined.warnings).toEqual(reference.warnings);
      } finally {
        spy.mockRestore();
      }
    });
  }, 120_000);

  it('draws a cylinder resize release with its drag mesh too', async () => {
    await withAdapters(async (dragged, plain) => {
      const model = await filletedUnion(dragged, { heightEdit: false });
      const wall = model.body.topology!.faces.find(
        (face) =>
          face.geometry?.surfaceType === 'cylinder' &&
          face.reference?.lineageName.endsWith('primitive.cylinder.face.wall')
      )!;
      const resize = (radius: number) =>
        directEditBody(model.document, {
          name: 'Resize cylinder',
          targetBodyId: model.bodyId,
          operation: {
            kind: 'resize-cylindrical-face',
            faceHash: wall.hash,
            ...(wall.reference ? { faceReference: wall.reference } : {}),
            sourceRadius: wall.geometry!.radius!,
            sourceAxisStart: wall.geometry!.axisStart!,
            sourceAxisEnd: wall.geometry!.axisEnd!,
            concavity: 'boss',
            radius
          }
        }).document;
      const released = resize(5.5);
      await plain.syncDocument(model.document);
      const reference = await plain.syncDocument(released);
      for (const radius of [5.8, 5.5])
        await dragged.previewGeometry(resize(radius), { deferTopology: true });
      const draft = await dragged.syncDocument(released);
      expect(draft.bodyRepresentations[model.bodyId]!.displayQuality).toBe(
        'draft'
      );
      expect(exactParts(draft)).toEqual(exactParts(reference));
      const refined = await dragged.syncDocument(released);
      expect(withoutClock(refined)).toEqual(withoutClock(reference));
    });
  }, 120_000);

  it('keeps a paused drag drafted through an idle refinement of the last release', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const model = await filletedUnion(adapter, { heightEdit: false });
      const top = faceNamed(model.body, TOP);
      const first = offsetTop(model.document, model.bodyId, top, -2);
      await adapter.previewGeometry(
        offsetTop(model.document, model.bodyId, top, -1),
        { deferTopology: true }
      );
      await adapter.previewGeometry(first, { deferTopology: true });
      const draft = await adapter.syncDocument(first);
      expect(draft.bodyRepresentations[model.bodyId]!.displayQuality).toBe(
        'draft'
      );
      // The next drag starts before the worker refined that release.
      const nextTop = faceNamed(draft.bodyRepresentations[model.bodyId]!, TOP);
      const next = (offset: number) =>
        offsetTop(first, model.bodyId, nextTop, offset);
      await adapter.previewGeometry(next(-1), { deferTopology: true });
      // The hand pauses; the idle refinement of the first release runs.
      const refined = await adapter.syncDocument(
        first,
        undefined,
        undefined,
        undefined,
        {
          displayRefinement: true
        }
      );
      expect(
        refined.bodyRepresentations[model.bodyId]!.displayQuality
      ).toBeUndefined();
      // Released where it paused: still accepted with its drag mesh.
      const released = await adapter.syncDocument(next(-1));
      expect(released.bodyRepresentations[model.bodyId]!.displayQuality).toBe(
        'draft'
      );
    } finally {
      adapter.dispose();
    }
  }, 120_000);

  it('keeps full quality without a drag mesh to commit, or for a strict union', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const model = await filletedUnion(adapter, { heightEdit: false });
      const top = faceNamed(model.body, TOP);
      const rested = offsetTop(model.document, model.bodyId, top, -1);
      await adapter.previewGeometry(rested, { deferTopology: true });
      // Its release will commit a draft: there is nothing to warm at rest.
      expect(await adapter.refineEditPreview!(rested)).toBe(false);
      // A cancelled drag leaves no drag mesh to commit.
      adapter.releaseEditPreview!();
      const committed = await adapter.syncDocument(rested);
      expect(
        committed.bodyRepresentations[model.bodyId]!.displayQuality
      ).toBeUndefined();

      // A union's closure check reads its display mesh: never drafted.
      const box = addPrimitiveFeature(
        createProjectDocument('Strict union', toUserId('user_draft_display')),
        {
          name: 'Box',
          primitiveKind: 'box',
          dimensions: { width: 30, height: 18, depth: 26 }
        }
      );
      const cylinder = addPrimitiveFeature(box, {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 6, height: 35 }
      });
      const joined = booleanBodies(cylinder, {
        name: 'Union',
        operation: 'union',
        targetBodyIds: [cylinder.bodyOrder[1]!, box.bodyOrder[0]!]
      });
      const base = await adapter.syncDocument(joined.document);
      const union = base.bodyRepresentations[joined.bodyId]!;
      const unionTop = faceNamed(union, TOP);
      const unionRest = offsetTop(joined.document, joined.bodyId, unionTop, -2);
      await adapter.previewGeometry(
        offsetTop(joined.document, joined.bodyId, unionTop, -1),
        { deferTopology: true }
      );
      await adapter.previewGeometry(unionRest, { deferTopology: true });
      // Its full-quality commit still benefits from the at-rest warm-up.
      expect(await adapter.refineEditPreview!(unionRest)).toBe(true);
      const strict = await adapter.syncDocument(unionRest);
      expect(strict.featureWarnings ?? []).toEqual([]);
      expect(
        strict.bodyRepresentations[joined.bodyId]!.displayQuality
      ).toBeUndefined();
    } finally {
      adapter.dispose();
    }
  }, 120_000);
});
