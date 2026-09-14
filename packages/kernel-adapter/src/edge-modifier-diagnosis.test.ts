import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import { toUserId, type BodyId } from '@openzcad/shared';
import { createExactKernelAdapter } from './exact';
import { RemusKernel } from './remus-runtime';
import {
  acceptedEdgeModifierProbe,
  applyEdgeModifier,
  blendCliffLimit,
  edgeModifierFailureMessage,
  EDGE_MODIFIER_PROBE_RATIOS
} from './exact-edge-modifiers';

/**
 * A kernel whose `fillet` returns what its `chamfer` returns: a real, valid,
 * in-envelope solid that is bevelled rather than rounded. This is what Remus
 * used to do when no blend engine could round a selection, and it is the one
 * failure the acceptance rules above the surfaces cannot see.
 */
function bevellingKernel(kernel: RemusKernel): RemusKernel {
  return new Proxy(kernel, {
    get(target, property) {
      if (property === 'fillet') {
        return (solid: number, edges: Uint32Array, size: number) =>
          target.chamfer(solid, edges, size);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    }
  });
}

/** Records every size `fillet` is called at, to count kernel round-trips. */
function countingKernel(kernel: RemusKernel, sizes: number[]): RemusKernel {
  return new Proxy(kernel, {
    get(target, property) {
      if (property === 'fillet') {
        return (solid: number, edges: Uint32Array, size: number) => {
          sizes.push(size);
          return target.fillet(solid, edges, size);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    }
  });
}

const user = toUserId('user_blend');

/**
 * A blend refusal has to name a cause the user can act on, and the causes are
 * not guessable from the selection: every edge of a plain box meets another at
 * a corner and they all round together, so "these edges touch" cannot be what
 * makes a selection refuse. Only the kernel knows which vertex its blend
 * engines gave up on, so these tests pin that its account survives to the
 * message instead of being replaced by an inference.
 */
describe('edge modifier failure diagnosis', { timeout: 60_000 }, () => {
  it('rounds every edge of a plain box, corners and all', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      let doc = addPrimitiveFeature(createProjectDocument('Box', user), {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      });
      const bodyId = doc.bodyOrder[0] as BodyId;
      const built = await adapter.syncDocument(doc);
      const edges = built.bodyRepresentations[bodyId]?.topology?.edges ?? [];
      expect(edges.length).toBe(12);

      doc = filletEdges(doc, {
        name: 'Round all',
        targetBodyId: bodyId,
        edgeHashes: edges.map((edge) => edge.hash),
        size: 2
      }).document;
      const derived = await adapter.syncDocument(doc);
      expect(derived.warnings).toEqual([]);
    } finally {
      adapter.dispose();
    }
  });

  it('names the blendable subset when a corner defeats the whole selection', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      let doc = addPrimitiveFeature(createProjectDocument('Notched', user), {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      });
      const boxId = doc.bodyOrder[0] as BodyId;
      doc = addPrimitiveFeature(doc, {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 14, height: 28 }
      });
      const cylId = doc.bodyOrder[1] as BodyId;
      const cut = booleanBodies(doc, {
        name: 'Notch',
        operation: 'subtract',
        targetBodyIds: [boxId, cylId]
      });
      doc = cut.document;
      const built = await adapter.syncDocument(doc);
      const edges =
        built.bodyRepresentations[cut.bodyId]?.topology?.edges ?? [];
      expect(edges.length).toBeGreaterThan(12);

      doc = filletEdges(doc, {
        name: 'Round all',
        targetBodyId: cut.bodyId,
        edgeHashes: edges.map((edge) => edge.hash),
        size: 2
      }).document;
      const derived = await adapter.syncDocument(doc);
      const failure = derived.warnings.join(' ');

      // The remedy is a count the kernel measured, not a property of the
      // selection: deselect the few it refused and the rest still round.
      expect(failure).toMatch(/cannot be blended where two rounds would meet/);
      expect(failure).toMatch(/round on their own/);
      expect(failure).toMatch(/deselect those \d+/);

      // The claim a plain box disproves must not come back.
      expect(failure).not.toMatch(
        /Edges that meet at a shared corner cannot be/
      );
      expect(failure).not.toMatch(/at any radius/);
    } finally {
      adapter.dispose();
    }
  });

  /**
   * Remus B23 made fillet one cascade — the walking engine, then a guarded
   * rolling-ball rebuild — and a radius the rolling ball cannot fit now comes
   * back as a typed `cliff-encountered` refusal carrying the ceiling the
   * kernel measured from the support faces. Before B23 the same request could
   * come back as a flat planar bevel, which passes closure, validity, bounds
   * and volume alike.
   */
  it('refuses an unfittable radius with the ceiling the kernel measured', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(30, 18, 24);
    const edge = Array.from(kernel.getSolidEdges(box))[0]!;

    let reported: string | null = null;
    const refused = applyEdgeModifier(
      kernel,
      box,
      [edge],
      'fillet',
      30,
      (message) => {
        reported = message;
      }
    );
    expect(refused).toBeNull();
    expect(reported).toMatch(/^cliff-encountered:/);

    // The limit is read out of the kernel's own sentence, never re-derived:
    // this edge is 30 long, and half of that is not the answer.
    const limit = blendCliffLimit(reported);
    expect(limit).toBe(18);
    expect(kernel.edgeLength(edge)).toBe(30);

    // The ceiling is a bound, not a radius to repeat back: the kernel refuses
    // 18 itself, and the r17.999 it does build is a body 2x the height of its
    // input, which the bounds guard rejects. So the message may quote it as a
    // limit but must quote a probed size as the thing that works.
    expect(() =>
      kernel.fillet(box, Uint32Array.from([edge]), limit!)
    ).toThrow();
    expect(
      applyEdgeModifier(kernel, box, [edge], 'fillet', limit! - 1e-3)
    ).toBeNull();
    expect(
      acceptedEdgeModifierProbe(kernel, box, [edge], 'fillet', 30, limit)
    ).toBe(9);

    const message = edgeModifierFailureMessage(
      kernel,
      box,
      [edge],
      'fillet',
      30,
      false,
      reported
    );
    expect(message).toContain(
      'Fillet could not be created on 1 selected edge with radius 30.'
    );
    expect(message).toContain('Try a smaller radius: radius 9 builds here.');
    // The ceiling aimed the ladder but must not be quoted: it is not a size
    // that works, and on other bodies it is not even a bound — see the plate
    // test below.
    expect(message).not.toContain('18');
    // The structural claims must not be reached: this edge rounds fine.
    expect(message).not.toMatch(/Closed rim edges|partial revolve/);
  });

  /**
   * The kernel's `available radius` is measured against whichever support
   * face its cascade stopped on FIRST, so it moves with the requested size
   * and is not an upper bound on what works. A 50x50x2 plate is the case
   * that proves it: r60 is refused with `available radius 50` and r30 on the
   * same edge with `available radius 2`, while r2 itself still refuses. So
   * the message may quote only a size the ladder actually built.
   */
  it('never quotes a ceiling the kernel has not proved', () => {
    const kernel = new RemusKernel();
    const plate = kernel.makeBox(50, 50, 2);
    const edge = Array.from(kernel.getSolidEdges(plate))[0]!;

    const refusalAt = (radius: number): string | null => {
      let reported: string | null = null;
      applyEdgeModifier(kernel, plate, [edge], 'fillet', radius, (message) => {
        reported = message;
      });
      return reported;
    };

    const atSixty = refusalAt(60);
    expect(blendCliffLimit(atSixty)).toBe(50);
    // Not monotone, and not a bound: the same edge reports a 25x smaller
    // ceiling one size down, and even that ceiling refuses.
    expect(blendCliffLimit(refusalAt(30))).toBe(2);
    expect(applyEdgeModifier(kernel, plate, [edge], 'fillet', 40)).toBeNull();
    expect(applyEdgeModifier(kernel, plate, [edge], 'fillet', 5)).toBeNull();
    expect(applyEdgeModifier(kernel, plate, [edge], 'fillet', 2)).toBeNull();

    const message = edgeModifierFailureMessage(
      kernel,
      plate,
      [edge],
      'fillet',
      60,
      false,
      atSixty
    );
    expect(message).toContain(
      'Fillet could not be created on 1 selected edge with radius 60.'
    );
    expect(message).not.toContain('50');
    expect(message).not.toContain('support face');

    // Whatever size the sentence does name, the same selection must build at
    // it. This is the property the ceiling failed.
    const quoted = /radius ([0-9.eE+-]+) builds here/.exec(message);
    expect(quoted).not.toBeNull();
    expect(
      applyEdgeModifier(kernel, plate, [edge], 'fillet', Number(quoted![1]))
    ).not.toBeNull();
  });

  /**
   * What the ceiling is for: aiming the ladder. These counts are the saving
   * the branch claims, pinned so the claim cannot drift — including the case
   * where there is no saving at all, because an uncorroborated ceiling seeds
   * a ladder that still has to walk all the way down.
   */
  it('spends fewer kernel round-trips only where the ceiling is close', () => {
    const kernel = new RemusKernel();
    const calls: number[] = [];
    const counting = countingKernel(kernel, calls);

    const ladderCalls = (
      target: number,
      edge: number,
      size: number,
      seeded: boolean
    ): number[] => {
      let reported: string | null = null;
      applyEdgeModifier(kernel, target, [edge], 'fillet', size, (message) => {
        reported = message;
      });
      calls.length = 0;
      if (seeded) {
        acceptedEdgeModifierProbe(
          counting,
          target,
          [edge],
          'fillet',
          size,
          blendCliffLimit(reported)
        );
      } else {
        // The pre-branch ladder: fractions of the REFUSED size, stopping at
        // the first one accepted.
        EDGE_MODIFIER_PROBE_RATIOS.some(
          (ratio) =>
            applyEdgeModifier(
              counting,
              target,
              [edge],
              'fillet',
              size * ratio
            ) !== null
        );
      }
      return [...calls];
    };

    const box = kernel.makeBox(30, 18, 24);
    const boxEdge = Array.from(kernel.getSolidEdges(box))[0]!;
    expect(ladderCalls(box, boxEdge, 30, false)).toEqual([15, 3.75]);
    expect(ladderCalls(box, boxEdge, 30, true)).toEqual([9]);

    const plate = kernel.makeBox(50, 50, 2);
    const plateEdge = Array.from(kernel.getSolidEdges(plate))[0]!;
    expect(ladderCalls(plate, plateEdge, 30, false)).toHaveLength(3);
    expect(ladderCalls(plate, plateEdge, 30, true)).toEqual([1]);
    // The ceiling reported at r60 is 50, far above what builds, so the
    // seeded ladder spends the same three round-trips as the blind one.
    expect(ladderCalls(plate, plateEdge, 60, false)).toHaveLength(3);
    expect(ladderCalls(plate, plateEdge, 60, true)).toHaveLength(3);
  });

  /**
   * The acceptance rules are the single definition of "the edit worked", and
   * the size probe runs through them too, so a bevel accepted here would both
   * ship a chamfer under a fillet's name and certify "try a smaller radius" as
   * advice that silently produces the wrong shape.
   */
  it('refuses a bevel offered as a fillet, and will not probe one', () => {
    const kernel = new RemusKernel();
    const bevelling = bevellingKernel(kernel);
    const box = kernel.makeBox(30, 18, 24);
    const edge = Array.from(kernel.getSolidEdges(box))[0]!;

    // The same solid is a perfectly good chamfer, so nothing above the
    // surfaces can tell it apart.
    expect(applyEdgeModifier(kernel, box, [edge], 'chamfer', 2)).not.toBeNull();
    expect(applyEdgeModifier(kernel, box, [edge], 'fillet', 2)).not.toBeNull();

    let reported: string | null = null;
    expect(
      applyEdgeModifier(bevelling, box, [edge], 'fillet', 2, (message) => {
        reported = message;
      })
    ).toBeNull();
    expect(reported).toContain('bevelled rather than rounded');

    // Every rung of the ladder is bevelled too, so none of them may be read
    // as evidence that a smaller radius works.
    expect(
      acceptedEdgeModifierProbe(bevelling, box, [edge], 'fillet', 30)
    ).toBeNull();
    expect(
      acceptedEdgeModifierProbe(kernel, box, [edge], 'fillet', 30)
    ).not.toBeNull();
  });
});
