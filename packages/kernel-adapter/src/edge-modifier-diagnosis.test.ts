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
  edgeModifierFailureMessage
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
    expect(message).toContain('Try a smaller radius');
    expect(message).toContain(
      "the kernel's blend runs off its support face at radius 18, and radius 9 builds here"
    );
    // The structural claims must not be reached: this edge rounds fine.
    expect(message).not.toMatch(/Closed rim edges|partial revolve/);
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
