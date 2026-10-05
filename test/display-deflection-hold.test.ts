import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { displayTessellationForExtents } from '../packages/kernel-adapter/src/display-tessellation';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

/**
 * A face offset nudges the body's bounding box, and the nominal display
 * deflection follows the box. The kernel reuses per-face display meshes only
 * at the same deflection, so the adapter holds a body's deflection across
 * edits that keep its size close. This pins that the edited body is meshed at
 * the held value, not at the new nominal one.
 */
describe('display deflection held across a small edit', () => {
  let adapter: ExactKernelAdapter;
  const deflections: number[] = [];

  beforeAll(async () => {
    const underlying = RemusKernel.prototype.tessellateSolidGroupedBinary;
    vi.spyOn(
      RemusKernel.prototype,
      'tessellateSolidGroupedBinary'
    ).mockImplementation(function (
      this: RemusKernel,
      ...args: Parameters<RemusKernel['tessellateSolidGroupedBinary']>
    ) {
      deflections.push(args[1]);
      return underlying.apply(this, args);
    });
    adapter = await createExactKernelAdapter();
  }, 60_000);

  afterAll(() => {
    vi.restoreAllMocks();
    adapter.dispose();
  });

  it('meshes the offset body at the deflection its source used', async () => {
    const manager = new CommandManager(
      createProjectDocument('Deflection hold', toUserId('user_deflection_hold'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 50, height: 20, depth: 30 }
      })
    );
    const base: ProjectDocument = {
      ...manager.document,
      derived: await adapter.syncDocument(manager.document)
    };
    const bodyId = base.derived.exportableBodyIds[0] as BodyId;
    const before = base.derived.bodyRepresentations[bodyId]!.bbox;
    const sourceNominal = displayTessellationForExtents(
      before.max.x - before.min.x,
      before.max.y - before.min.y,
      before.max.z - before.min.z
    ).linearDeflection;
    expect(deflections.at(-1)).toBe(sourceNominal);

    // The face at the far end of the longest axis, pushed out by 6 %.
    const faces = base.derived.bodyRepresentations[bodyId]!.topology!.faces;
    const extents = [
      before.max.x - before.min.x,
      before.max.y - before.min.y,
      before.max.z - before.min.z
    ];
    const axis = extents.indexOf(Math.max(...extents));
    const key = (['x', 'y', 'z'] as const)[axis]!;
    const end = faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.[key] ?? 0) > 0.99
    )!;
    expect(end).toBeDefined();
    const offset = 0.06 * extents[axis]!;
    const plan = planFaceOffset({
      document: base,
      bodyId,
      face: end,
      faceHash: end.hash,
      offset
    });
    expect(plan).not.toBeNull();
    const edited = new CommandManager(base).runTransaction('Offset', [
      plan!.command
    ]);
    deflections.length = 0;
    const derived = await adapter.syncDocument(edited);
    expect(derived.warnings).toEqual([]);

    const after = derived.bodyRepresentations[bodyId]!.bbox;
    const editedNominal = displayTessellationForExtents(
      after.max.x - after.min.x,
      after.max.y - after.min.y,
      after.max.z - after.min.z
    ).linearDeflection;
    // The body grew along its longest axis, so the nominal moved...
    expect(editedNominal).toBeGreaterThan(sourceNominal);
    // ...but the edited body was meshed at the held source value.
    expect(deflections.length).toBeGreaterThan(0);
    expect(deflections.at(-1)).toBe(sourceNominal);
  }, 60_000);
});

describe('held display deflections are pruned with the body', () => {
  it('drops the entry when the body leaves the document', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const manager = new CommandManager(
        createProjectDocument(
          'Deflection prune',
          toUserId('user_deflection_prune')
        )
      );
      manager.execute(
        commandFactories.addPrimitive({
          name: 'Block',
          primitiveKind: 'box',
          dimensions: { width: 50, height: 20, depth: 30 }
        })
      );
      const withBody = manager.document;
      await adapter.syncDocument(withBody);
      const held = (
        adapter as unknown as { heldDisplayDeflections: Map<string, number[]> }
      ).heldDisplayDeflections;
      expect(held.size).toBe(1);
      // A document without that body: the entry goes with it.
      await adapter.syncDocument(
        createProjectDocument(
          'Deflection prune',
          toUserId('user_deflection_prune')
        )
      );
      expect(held.size).toBe(0);
    } finally {
      adapter.dispose();
    }
  }, 60_000);
});

describe('the union gate meshes at the held deflection', () => {
  it('retains a projection measurement reuses after a small operand edit', async () => {
    const calls: { solid: number; linear: number }[] = [];
    const underlying = RemusKernel.prototype.tessellateSolidGroupedBinary;
    vi.spyOn(
      RemusKernel.prototype,
      'tessellateSolidGroupedBinary'
    ).mockImplementation(function (
      this: RemusKernel,
      ...args: Parameters<RemusKernel['tessellateSolidGroupedBinary']>
    ) {
      calls.push({ solid: args[0], linear: args[1] });
      return underlying.apply(this, args);
    });
    const adapter = await createExactKernelAdapter();
    try {
      const manager = new CommandManager(
        createProjectDocument('Union hold', toUserId('user_union_hold'))
      );
      manager.execute(
        commandFactories.addPrimitive({
          name: 'Base',
          primitiveKind: 'box',
          dimensions: { width: 60, height: 10, depth: 40 }
        })
      );
      manager.execute(
        commandFactories.addPrimitive({
          name: 'Post',
          primitiveKind: 'box',
          dimensions: { width: 10, height: 30, depth: 10 }
        })
      );
      const [baseId, postId] = manager.document.bodyOrder as [BodyId, BodyId];
      manager.execute(
        commandFactories.booleanBodies({
          name: 'Union',
          operation: 'union',
          targetBodyIds: [baseId, postId]
        })
      );
      const unionDoc = manager.document;
      const derived0 = await adapter.syncDocument(unionDoc);
      expect(derived0.warnings).toEqual([]);
      const unionBodyId = derived0.exportableBodyIds[0] as BodyId;
      const rep0 = derived0.bodyRepresentations[unionBodyId]!;
      const sourceNominal = displayTessellationForExtents(
        rep0.bbox.max.x - rep0.bbox.min.x,
        rep0.bbox.max.y - rep0.bbox.min.y,
        rep0.bbox.max.z - rep0.bbox.min.z
      ).linearDeflection;

      // Push the base's +X end out by 6 %: the union's extent grows, its
      // nominal deflection moves, the held one does not.
      const faces = rep0.topology!.faces;
      const end = faces.find(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          (face.geometry.normal?.x ?? 0) > 0.99
      )!;
      const plan = planFaceOffset({
        document: { ...unionDoc, derived: derived0 },
        bodyId: unionBodyId,
        face: end,
        faceHash: end.hash,
        offset: 3.6
      });
      expect(plan).not.toBeNull();
      const edited = new CommandManager({
        ...unionDoc,
        derived: derived0
      }).runTransaction('Offset', [plan!.command]);
      calls.length = 0;
      const derived1 = await adapter.syncDocument(edited);
      expect(derived1.warnings).toEqual([]);
      const rep1 = derived1.bodyRepresentations[unionBodyId]!;
      const editedNominal = displayTessellationForExtents(
        rep1.bbox.max.x - rep1.bbox.min.x,
        rep1.bbox.max.y - rep1.bbox.min.y,
        rep1.bbox.max.z - rep1.bbox.min.z
      ).linearDeflection;
      expect(editedNominal).not.toBe(sourceNominal);
      // Every display tessellation of this sync used the held value, and the
      // union result was tessellated once: the gate's projection served
      // measurement instead of being discarded for a deflection mismatch.
      expect(calls.length).toBeGreaterThan(0);
      expect(new Set(calls.map((call) => call.linear))).toEqual(
        new Set([sourceNominal])
      );
      const perSolid = new Map<number, number>();
      for (const call of calls) {
        perSolid.set(call.solid, (perSolid.get(call.solid) ?? 0) + 1);
      }
      expect(Math.max(...perSolid.values())).toBe(1);
    } finally {
      vi.restoreAllMocks();
      adapter.dispose();
    }
  }, 90_000);
});
