import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  splitRefusal,
  warningForFeature
} from '../apps/web/src/lib/featureValidation';
import type { BooleanOperation } from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { sphereCylinderUnionInputs } from './support/sphere-cylinder-union';

/**
 * 2026-11-05 report: dragging the diameter of a boss that grows out of a
 * sphere refused with "The exact kernel could not build this result."
 *
 * The kernel re-limits a resized wall only against planes, cylinders and
 * axial cones, so the boss (sphere neighbour) and the blind bore cut from the
 * same sphere (partial reversed wall) both refuse before any geometry is
 * built. Until the kernel follows those neighbours, the refusal must say what
 * blocks it and point at the route that works — editing the source Cylinder,
 * which `test/combination-matrix.test.ts` qualifies for both cells. The raw
 * kernel text stays behind "View details".
 */
const GENERIC = 'The exact kernel could not build this result.';

const CASES: ReadonlyArray<
  [BooleanOperation, 'boss' | 'hole', string, RegExp, Record<string, string>]
> = [
  [
    'union',
    'boss',
    "This face meets a curved surface that resizing and moving faces can't follow yet. Change the size on the original shape in History instead.",
    /move-face does not support face .*\(sphere\)/,
    { reason: 'unsupported_neighbor', neighborSurfaceType: 'sphere' }
  ],
  [
    'subtract',
    'hole',
    "This hole's wall doesn't end in full circles, which resizing can't follow yet. Change the size on the original shape in History instead.",
    /partial-cylinder resize/,
    { reason: 'partial_reversed_wall' }
  ]
];

describe('resizing a cylinder wall that meets a sphere', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => {
    adapter.dispose();
  });

  async function refuseResize(
    operation: BooleanOperation,
    concavity: 'boss' | 'hole',
    radius: number
  ) {
    const { document, sphere, cylinder } = sphereCylinderUnionInputs();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Combine',
        operation,
        targetBodyIds: [sphere, cylinder]
      })
    );
    const bodyId = manager.document.bodyOrder.at(-1)!;
    const base = await adapter.syncDocument(manager.document);
    expect(base.warnings).toEqual([]);
    const wall = base.bodyRepresentations[bodyId]?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'cylinder' &&
        Math.abs((face.geometry.radius ?? 0) - 6) < 1e-6
    );
    expect(wall?.reference?.lineageName).toMatch(/primitive\.cylinder/);
    const candidate = manager.runTransaction('Resize', [
      commandFactories.directEditBody({
        name: 'Resize Cylinder',
        targetBodyId: bodyId,
        operation: {
          kind: 'resize-cylindrical-face',
          faceHash: wall!.hash,
          ...(wall!.reference ? { faceReference: wall!.reference } : {}),
          sourceRadius: 6,
          sourceAxisStart: wall!.geometry!.axisStart!,
          sourceAxisEnd: wall!.geometry!.axisEnd!,
          concavity,
          radius
        }
      })
    ]);
    const refused = await adapter.syncDocument(candidate);
    const warning = refused.featureWarnings?.find(
      (entry) => entry.featureName === 'Resize Cylinder'
    );
    expect(warning?.kind).toBe('build-failed');
    const text = warningForFeature('Resize Cylinder', refused.warnings);
    expect(text).not.toBeNull();
    return { warning: warning!, text: text! };
  }

  it.each(CASES)(
    'names the blocking geometry after a %s instead of the generic sentence',
    async (operation, concavity, sentence, detail, cause) => {
      const { warning, text } = await refuseResize(operation, concavity, 7);
      // The kernel typed the refusal (Remus #1550), and the record reaches
      // the feature warning with its cause rather than as prose alone.
      expect(warning.kernelRefusal).toEqual({
        family: 'direct-edit',
        operation: 'resize-cylindrical-face',
        category: 'unsupported',
        code: 'unsupported_move_face',
        ...cause
      });
      const plain = splitRefusal(text, warning.kernelRefusal);
      expect(plain.message).not.toBe(GENERIC);
      expect(plain.message).toBe(sentence);
      expect(plain.detail).toMatch(detail);
    },
    120_000
  );

  /**
   * A change inside the small-change band used to be retried through four
   * waypoint radii before the refusal surfaced. An `unsupported` refusal is
   * about the geometry, not the size, so the ladder must not run: one typed
   * resize call, and no legacy waypoint resizes.
   */
  it.each(CASES)(
    'refuses a small change after a %s without the waypoint ladder',
    async (operation, concavity, _sentence, _detail, cause) => {
      const typed = vi.spyOn(
        RemusKernel.prototype,
        'resizeCylindricalFaceDetailed'
      );
      const legacy = vi.spyOn(RemusKernel.prototype, 'resizeCylindricalFace');
      try {
        // 6 -> 6.3 is a 5% change, inside the 15% band that used to detour.
        const { warning } = await refuseResize(operation, concavity, 6.3);
        expect(warning.kernelRefusal).toMatchObject({
          category: 'unsupported',
          ...cause
        });
        expect(typed).toHaveBeenCalledTimes(1);
        expect(legacy).not.toHaveBeenCalled();
      } finally {
        typed.mockRestore();
        legacy.mockRestore();
      }
    },
    120_000
  );
});
