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
