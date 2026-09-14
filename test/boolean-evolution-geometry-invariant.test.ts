import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import type { BodyId, ProjectDocument } from '@openzcad/shared';

/**
 * The invariant this file exists to pin: adopting the kernel's boolean
 * entity-evolution payload changes PROVENANCE ONLY.
 *
 * On this pin `cutWithEntityEvolution` / `fuseWithEntityEvolution` /
 * `intersectWithEntityEvolution` are a different boolean implementation from
 * the plain entry points, and routing production geometry through them broke
 * five things at once: cuts and intersections that worked stopped building,
 * booleans the kernel's exact-only policy refuses started shipping a body,
 * a named refusal became a raw internal assertion, and a union's face count
 * moved. Each case below is one of those, asserted against what the plain
 * pipeline does.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

const user = toUserId('user_boolean_geometry');

interface Operand {
  readonly name: string;
  readonly primitive:
    | { kind: 'box'; width: number; height: number; depth: number }
    | { kind: 'cylinder'; radius: number; height: number }
    | { kind: 'sphere'; radius: number };
  readonly at?: { x: number; y: number; z: number };
}

function operandDocument(
  title: string,
  operands: readonly Operand[],
  operation: 'union' | 'subtract' | 'intersect'
): { document: ProjectDocument; bodyId: BodyId } {
  let document = createProjectDocument(title, user);
  const bodyIds: BodyId[] = [];
  for (const operand of operands) {
    document = addPrimitiveFeature(document, {
      name: operand.name,
      primitiveKind: operand.primitive.kind,
      dimensions:
        operand.primitive.kind === 'box'
          ? {
              width: operand.primitive.width,
              height: operand.primitive.height,
              depth: operand.primitive.depth
            }
          : operand.primitive.kind === 'cylinder'
            ? {
                radius: operand.primitive.radius,
                height: operand.primitive.height
              }
            : { radius: operand.primitive.radius }
    });
    const bodyId = document.bodyOrder.at(-1)!;
    if (operand.at) {
      document = transformBody(document, {
        name: `Place ${operand.name}`,
        targetBodyId: bodyId,
        translation: operand.at
      }).document;
    }
    bodyIds.push(bodyId);
  }
  const combined = booleanBodies(document, {
    name: 'Combine',
    operation,
    targetBodyIds: bodyIds
  });
  return { document: combined.document, bodyId: combined.bodyId };
}

describe('boolean geometry is the plain pipeline, not the evolution one', () => {
  it(
    'cuts a sphere out of a cylinder, which the evolution cut cannot do',
    async () => {
      // `cutWithEntityEvolution` throws `assembly failed: closed hole shell is
      // not contained by any growth region` on exactly this input.
      const { document, bodyId } = operandDocument(
        'Cylinder less sphere',
        [
          { name: 'Cylinder', primitive: { kind: 'cylinder', radius: 10, height: 20 } },
          {
            name: 'Sphere',
            primitive: { kind: 'sphere', radius: 8 },
            at: { x: 0, y: 0, z: 10 }
          }
        ],
        'subtract'
      );
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId];
      expect(body, 'the cut body').toBeDefined();
      expect(body!.faceCount).toBe(5);
      expect(body!.volume).toBeCloseTo(4137.839039, 4);
    },
    120_000
  );

  it(
    'intersects a sphere with a box, which the evolution intersect cannot do',
    async () => {
      // `intersectWithEntityEvolution` throws `assembly failed: no outer shell
      // found (all shells classified as holes)` on exactly this input.
      const { document, bodyId } = operandDocument(
        'Sphere meets box',
        [
          { name: 'Sphere', primitive: { kind: 'sphere', radius: 10 } },
          {
            name: 'Box',
            primitive: { kind: 'box', width: 10, height: 10, depth: 10 },
            at: { x: 0, y: 0, z: 5 }
          }
        ],
        'intersect'
      );
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId];
      expect(body, 'the intersection body').toBeDefined();
      expect(body!.faceCount).toBe(4);
      expect(body!.volume).toBeCloseTo(163.596637, 4);
    },
    120_000
  );

  it(
    'keeps the exact-only refusal where the evolution entry point would ship a body',
    async () => {
      // Measured on the pin: the plain intersect refuses this by the exact-only
      // policy, while `intersectWithEntityEvolution` returns a two-face body of
      // 1946.740248 mm^3. Shipping that body is the fail-closed violation this
      // case exists to prevent.
      const { document, bodyId } = operandDocument(
        'Cylinder meets sphere',
        [
          { name: 'Cylinder', primitive: { kind: 'cylinder', radius: 10, height: 20 } },
          {
            name: 'Sphere',
            primitive: { kind: 'sphere', radius: 8 },
            at: { x: 0, y: 0, z: 5 }
          }
        ],
        'intersect'
      );
      const derived = await adapter.syncDocument(document);
      expect(derived.bodyRepresentations[bodyId]).toBeUndefined();
      expect(derived.warnings.join('\n')).toMatch(/exact-only policy/);
    },
    120_000
  );

  it(
    'keeps the exact-only refusal for a union the evolution fuse would answer with one operand',
    async () => {
      // `fuseWithEntityEvolution` answers this with the sphere alone —
      // 4188.790205 mm^3, the cylinder gone.
      const { document, bodyId } = operandDocument(
        'Cylinder and ball',
        [
          { name: 'Cylinder', primitive: { kind: 'cylinder', radius: 10, height: 20 } },
          {
            name: 'Sphere',
            primitive: { kind: 'sphere', radius: 8 },
            at: { x: 0, y: 0, z: 20 }
          }
        ],
        'union'
      );
      const derived = await adapter.syncDocument(document);
      expect(derived.bodyRepresentations[bodyId]).toBeUndefined();
      expect(derived.warnings.join('\n')).toMatch(/exact-only policy/);
    },
    120_000
  );

  it(
    'refuses a curved-curved union by the named policy, not by an internal assertion',
    async () => {
      // The canonical curved-curved case: two spheres offset by a quarter of
      // their diameter. The plain fuse refuses; `fuseWithEntityEvolution`
      // answers with a four-face body of 5726.7768 mm^3.
      const { document, bodyId } = operandDocument(
        'Two balls',
        [
          { name: 'Left', primitive: { kind: 'sphere', radius: 10 } },
          {
            name: 'Right',
            primitive: { kind: 'sphere', radius: 10 },
            at: { x: 5, y: 0, z: 0 }
          }
        ],
        'union'
      );
      const derived = await adapter.syncDocument(document);
      expect(derived.bodyRepresentations[bodyId]).toBeUndefined();
      const warnings = derived.warnings.join('\n');
      expect(warnings).toMatch(/exact-only policy/);
      // The evolution cut surfaces `copied face Id(...) does not contain
      // exactly one reverse use of edge Id(...)`; an internal face/edge id
      // assertion is never the sentence a user is shown.
      expect(warnings).not.toMatch(/reverse use of edge/);
      expect(warnings).not.toMatch(/assembly failed/);
    },
    120_000
  );

  it(
    'refuses the corner sphere cut by the named policy, not by an internal assertion',
    async () => {
      // The plain cut refuses this by the exact-only policy. The evolution cut
      // throws `algo: assembly failed: copied face Id(49) does not contain
      // exactly one reverse use of edge Id(276)` — an internal assertion that
      // must never reach a warning.
      const { document, bodyId } = operandDocument(
        'Box with a corner ball',
        [
          {
            name: 'Box',
            primitive: { kind: 'box', width: 20, height: 20, depth: 20 }
          },
          {
            name: 'Sphere',
            primitive: { kind: 'sphere', radius: 8 },
            at: { x: 10, y: 10, z: 20 }
          }
        ],
        'subtract'
      );
      const derived = await adapter.syncDocument(document);
      expect(derived.bodyRepresentations[bodyId]).toBeUndefined();
      const warnings = derived.warnings.join('\n');
      expect(warnings).toMatch(/exact-only policy/);
      expect(warnings).not.toMatch(/reverse use of edge/);
      expect(warnings).not.toMatch(/assembly failed/);
    },
    120_000
  );

  it(
    'keeps the plain fuse topology on a stepped cylinder union',
    async () => {
      // The evolution fuse returns five faces for this union where the plain
      // fuse returns six. Whichever is the nicer body, the stored face hashes
      // of every such union move if the shipped topology changes, so the
      // shipped one stays the plain one.
      const { document, bodyId } = operandDocument(
        'Stepped shaft',
        [
          { name: 'Base', primitive: { kind: 'cylinder', radius: 20, height: 5 } },
          {
            name: 'Post',
            primitive: { kind: 'cylinder', radius: 5, height: 20 },
            at: { x: 0, y: 0, z: 5 }
          }
        ],
        'union'
      );
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId];
      expect(body, 'the union body').toBeDefined();
      expect(body!.faceCount).toBe(6);
      expect(body!.volume).toBeCloseTo(7853.981634, 4);
    },
    120_000
  );

  it(
    'keeps the plain intersect value where the evolution intersect moves it',
    async () => {
      // Plain: 523.545492 mm^3. Evolution: 523.528813 mm^3 — a silent
      // geometric change on a path advertised as changing provenance only.
      const { document, bodyId } = operandDocument(
        'Ball corner',
        [
          { name: 'Sphere', primitive: { kind: 'sphere', radius: 10 } },
          {
            name: 'Box',
            primitive: { kind: 'box', width: 10, height: 10, depth: 10 }
          }
        ],
        'intersect'
      );
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId];
      expect(body, 'the intersection body').toBeDefined();
      expect(body!.faceCount).toBe(4);
      expect(body!.volume).toBeCloseTo(523.545492, 4);
    },
    120_000
  );
});
