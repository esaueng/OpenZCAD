import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId, type FeatureId } from '@openzcad/shared';
import { buildDocumentHistory } from './exact-build-loop';
import {
  isCoplanarCapRefusal,
  piercedBodyTool,
  pierceGateHolds,
  pierceTravel,
  retryCoplanarRefusal
} from './exact-pierce-tool';
import { KernelRefusal, type KernelRefusalCategory } from './kernel-refusal';
import { RemusKernel } from './remus-runtime';

function refusal(
  category: KernelRefusalCategory,
  kernelCode: string
): KernelRefusal {
  return new KernelRefusal({
    family: 'boolean',
    category,
    kernelCode,
    kernelMessage: kernelCode,
    message: `Subtract refused: ${kernelCode}`,
    reason: kernelCode
  });
}

/**
 * The gate that decides whether a refused on-face tool may be rebuilt with
 * pierce travel. The end-to-end text cases live in
 * `test/text-kernel-build.test.ts`; these pin the cases where the travel
 * WOULD change the result and so must never be taken.
 */
const SLAB = { width: 62, height: 50, depth: 10 } as const;

function scene(input: {
  planeOffset: number;
  distance: number;
  centerX?: number;
}) {
  const kernel = new RemusKernel();
  const withSlab = addPrimitiveFeature(
    createProjectDocument('Pierce gate', toUserId('user_pierce_gate')),
    { name: 'Slab', primitiveKind: 'box', dimensions: { ...SLAB } }
  );
  const slabId = withSlab.bodyOrder.at(-1)!;
  const created = addSketchFeature(withSlab, {
    name: 'Pocket',
    planeRef: { type: 'canonical', plane: 'XY', offset: input.planeOffset },
    objects: [
      {
        objectKind: 'rectangle',
        centerX: input.centerX ?? 20,
        centerY: 20,
        width: 12,
        height: 6
      }
    ]
  });
  const extruded = extrudeSketch(created.document, {
    name: 'Tool',
    sketchId: created.sketchId,
    distance: input.distance
  });
  const result = buildDocumentHistory(kernel, extruded.document);
  const slab = result.shapes.get(slabId)!;
  const tool = result.shapes.get(extruded.bodyId)!;
  const plane = result.sketchBases.get(created.sketchId)!;
  return {
    kernel,
    document: extruded.document,
    result,
    slab,
    tool,
    plane,
    travel: pierceTravel(SLAB.width)
  };
}

const UP = { x: 0, y: 0, z: 1 };
const DOWN = { x: 0, y: 0, z: -1 };

describe('coplanar-cap pierce gate', () => {
  it('pierces a cut on the face into the air above it, never into the body', () => {
    const { kernel, slab, tool, plane, travel } = scene({
      planeOffset: SLAB.depth,
      distance: -2
    });
    const gate = (mode: 'cut' | 'add', direction = UP) =>
      pierceGateHolds(kernel, {
        partnerSolids: slab.solids,
        toolSolids: tool.solids,
        plane,
        direction,
        mode,
        travel
      });
    expect(gate('cut')).toBe(true);
    // The same travel read as an add would put material in the air.
    expect(gate('add')).toBe(false);
    // Pierced downward, the travel would remove slab material under the cap.
    expect(gate('cut', DOWN)).toBe(false);
  });

  it('pierces a boss on the face into the body, never into the air', () => {
    const { kernel, slab, tool, plane, travel } = scene({
      planeOffset: SLAB.depth,
      distance: 2
    });
    const gate = (mode: 'cut' | 'add') =>
      pierceGateHolds(kernel, {
        partnerSolids: slab.solids,
        toolSolids: tool.solids,
        plane,
        direction: DOWN,
        mode,
        travel
      });
    expect(gate('add')).toBe(true);
    expect(gate('cut')).toBe(false);
  });

  it('does not fire when the sketch plane is not on a face', () => {
    // Sunk half a millimetre: no slab face in the plane, and no refusal to
    // work around — the plain tool is what the user asked for.
    const { kernel, slab, tool, plane, travel } = scene({
      planeOffset: SLAB.depth - 0.5,
      distance: -1.5
    });
    expect(
      pierceGateHolds(kernel, {
        partnerSolids: slab.solids,
        toolSolids: tool.solids,
        plane,
        direction: UP,
        mode: 'cut',
        travel
      })
    ).toBe(false);
  });

  it('does not fire when the footprint runs off the face', () => {
    // Centred on the slab's x = 62 edge: half the cap hangs over air, where
    // a cut's tool side is not material, so the face does not carry the
    // whole footprint and the gate cannot vouch for the travel.
    const { kernel, slab, tool, plane, travel } = scene({
      planeOffset: SLAB.depth,
      distance: -2,
      centerX: SLAB.width
    });
    expect(
      pierceGateHolds(kernel, {
        partnerSolids: slab.solids,
        toolSolids: tool.solids,
        plane,
        direction: UP,
        mode: 'cut',
        travel
      })
    ).toBe(false);
  });

  it('only rebuilds a body that is still exactly the extrude it came from', () => {
    const { kernel, document, result, slab, tool } = scene({
      planeOffset: SLAB.depth,
      distance: -2
    });
    const ctx = { kernel, document, scope: {}, result };
    expect(tool.sweepSource?.solids).toEqual(tool.solids);
    const pierced = piercedBodyTool(ctx, tool, slab.solids, 'cut');
    expect(pierced).not.toBeNull();
    // The twin is the same footprint, 0.01 taller, reaching above the face.
    const plain = kernel.boundingBox(tool.solids[0]!);
    const twin = kernel.boundingBox(pierced!.solids[0]!);
    expect(twin[2]).toBeCloseTo(plain[2]!, 9);
    expect(twin[5]! - plain[5]!).toBeCloseTo(pierceTravel(SLAB.width), 9);

    // Same record, different handles: something moved or replaced the body.
    const moved = {
      ...tool,
      solids: [kernel.copySolid(tool.solids[0]!)]
    };
    expect(piercedBodyTool(ctx, moved, slab.solids, 'cut')).toBeNull();
    // No record at all: not an extrude's output.
    expect(
      piercedBodyTool(ctx, { solids: tool.solids }, slab.solids, 'cut')
    ).toBeNull();
    // A record naming a feature the document no longer has.
    expect(
      piercedBodyTool(
        ctx,
        {
          ...tool,
          sweepSource: {
            featureId: 'feature_gone' as FeatureId,
            solids: tool.solids
          }
        },
        slab.solids,
        'cut'
      )
    ).toBeNull();
  });

  it('retries only the exact-only refusal, and never hides the original', () => {
    const coplanar = refusal('quality_refused', 'exact_only_unattainable');
    expect(isCoplanarCapRefusal(coplanar)).toBe(true);
    // However deeply a builder wrapped it.
    expect(
      isCoplanarCapRefusal(new Error('Feature failed', { cause: coplanar }))
    ).toBe(true);
    expect(isCoplanarCapRefusal(new Error('exact geometry failed'))).toBe(
      false
    );
    expect(isCoplanarCapRefusal(undefined)).toBe(false);

    expect(
      retryCoplanarRefusal(
        coplanar,
        () => 'pierced',
        (tool) => `${tool} ok`
      )
    ).toBe('pierced ok');
    // Not the coplanar refusal: no pierce is even attempted.
    const other = new Error('plain failure');
    expect(() =>
      retryCoplanarRefusal(
        other,
        () => {
          throw new Error('must not pierce');
        },
        () => 'unreachable'
      )
    ).toThrow(other);
    // Gate declined, pierce failed, or retry refused: the user's own refusal.
    expect(() =>
      retryCoplanarRefusal(
        coplanar,
        () => null,
        () => 'unreachable'
      )
    ).toThrow(coplanar);
    expect(() =>
      retryCoplanarRefusal(
        coplanar,
        () => {
          throw new Error('tessellation failed');
        },
        () => 'unreachable'
      )
    ).toThrow(coplanar);
    expect(() =>
      retryCoplanarRefusal(
        coplanar,
        () => 'pierced',
        () => {
          throw refusal('quality_refused', 'exact_only_unattainable');
        }
      )
    ).toThrow(coplanar);
    // A rebuild superseded mid-retry stops as a cancellation, not a refusal.
    const cancelled = refusal('cancelled', 'cancelled');
    expect(() =>
      retryCoplanarRefusal(
        coplanar,
        () => 'pierced',
        () => {
          throw cancelled;
        }
      )
    ).toThrow(cancelled);
  });

  it('travels 0.01 model units at ordinary model scale', () => {
    expect(pierceTravel(62)).toBeCloseTo(0.01, 12);
  });
});
