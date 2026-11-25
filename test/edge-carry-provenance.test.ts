import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  chamferEdges,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  setParameter
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type EdgeTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { carriedSelectionCommands } from '../apps/web/src/lib/topologyReferenceRepairs';

/**
 * A carried hash-only pick must stay on the upstream feature it was picked
 * on (`exact-edge-selection-transport.ts`, condition 6).
 *
 * The part: a 30 × 18 × 5 plate and two 4 × 4 bosses A and B rising from
 * z = 1 to z = 1 + h, all united. A is centred at x = a, B at x = b. With
 * a = 28 boss A is flush with the plate's right side (x = 30), and a
 * hash-only chamfer breaks A's outer top edge (x = 30, z = h + 1).
 *
 * Swapping the bosses (a = 8, b = 28) while raising them leaves the united
 * solid with the same structure, the same fixed plate edges and the same
 * plane offsets per direction, with only the top plane moved: every role
 * check passes, and the edge in the picked edge's role is now boss B's. The
 * matcher used to carry the chamfer there, and the app stored it, so the
 * reopened part silently chamfered the wrong boss.
 */

const user = toUserId('user_edge_carry_provenance');

interface Part {
  document: ProjectDocument;
  bodyId: BodyId;
}

function bossPart(): Part {
  let document = addPrimitiveFeature(
    createProjectDocument('Carry provenance', user),
    {
      name: 'Base',
      primitiveKind: 'box',
      dimensions: { width: 30, depth: 5, height: 18 }
    }
  );
  const baseId = document.bodyOrder[0]!;
  document = setParameter(document, { name: 'a', expression: '28' });
  document = setParameter(document, { name: 'b', expression: '8' });
  document = setParameter(document, { name: 'h', expression: '9' });
  for (const [name, centerX] of [
    ['Boss A', 'a'],
    ['Boss B', 'b']
  ] as const) {
    const sketch = addSketchFeature(document, {
      name,
      planeRef: { type: 'canonical', plane: 'XY', offset: 1 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX,
          centerY: 9
        }
      ]
    });
    document = extrudeSketch(sketch.document, {
      name,
      sketchId: sketch.sketchId,
      distance: 'h',
      profiles: [
        {
          all: true,
          sourceEntityIds: findSketch(sketch.document, sketch.sketchId)!
            .objectIds
        }
      ]
    }).document;
  }
  const joined = booleanBodies(document, {
    name: 'Join',
    operation: 'union',
    targetBodyIds: [baseId, ...document.bodyOrder.slice(-2)]
  });
  return { document: joined.document, bodyId: joined.bodyId };
}

/** The straight top edges of a boss at x, spanning y 7–11 at height z. */
function topEdges(edges: readonly EdgeTopology[], x: number, z: number) {
  return edges.filter((edge) => {
    const points = Array.from(edge.points as ArrayLike<number>);
    return points.every((value, index) =>
      index % 3 === 0
        ? Math.abs(value - x) < 1e-6
        : index % 3 === 1
          ? value >= 7 - 1e-6 && value <= 11 + 1e-6
          : Math.abs(value - z) < 1e-6
    );
  });
}

describe(
  'carrying a hash-only pick keeps its upstream feature',
  { timeout: 120_000 },
  () => {
    let adapter: ExactKernelAdapter;
    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    }, 60_000);
    afterAll(() => adapter.dispose());

    /** An edit's validation build: the only build that may propose a carry. */
    const validate = (document: ProjectDocument) =>
      adapter.syncDocument(document, undefined, undefined, undefined, {
        proposeCarry: true
      });

    /** Chamfers one edge, picked by hash alone, and settles the part. */
    async function chamfered(part: Part, x: number, z: number) {
      const derived = await adapter.syncDocument(part.document);
      expect(derived.featureWarnings ?? []).toEqual([]);
      const picked = topEdges(
        derived.bodyRepresentations[part.bodyId]!.topology!.edges,
        x,
        z
      );
      expect(picked).toHaveLength(1);
      // The union publishes no name for this edge, so the pick is its hash.
      expect(picked[0]!.reference).toBeUndefined();
      const chamfer = chamferEdges(part.document, {
        name: 'Break',
        targetBodyId: part.bodyId,
        edgeHashes: [picked[0]!.hash],
        size: 0.4
      });
      const settled = await adapter.syncDocument(chamfer.document);
      expect(settled.featureWarnings ?? []).toEqual([]);
      return {
        document: { ...chamfer.document, derived: settled },
        bodyId: chamfer.bodyId
      };
    }

    /** The hashes a fresh build of `part` gives the top edges at x, z. */
    async function freshEdge(part: Part, x: number, z: number) {
      const fresh = await createExactKernelAdapter();
      try {
        const derived = await fresh.syncDocument(part.document);
        return topEdges(
          derived.bodyRepresentations[part.bodyId]!.topology!.edges,
          x,
          z
        ).map((edge) => edge.hash);
      } finally {
        fresh.dispose();
      }
    }

    it('refuses to carry a pick onto the boss that swapped into its role', async () => {
      const part = bossPart();
      const model = await chamfered(part, 30, 10);
      // Swap the bosses and raise them by 1 mm.
      const swapped = setParameter(
        setParameter(
          setParameter(model.document, { name: 'a', expression: '8' }),
          {
            name: 'b',
            expression: '28'
          }
        ),
        { name: 'h', expression: '10' }
      );
      // The role-matching edge (boss B's, at x = 30) and boss A's own edge,
      // now inboard at x = 10, both exist on the edited part.
      const reference = {
        document: setParameter(
          setParameter(
            setParameter(part.document, { name: 'a', expression: '8' }),
            {
              name: 'b',
              expression: '28'
            }
          ),
          { name: 'h', expression: '10' }
        ),
        bodyId: part.bodyId
      };
      expect(await freshEdge(reference, 30, 11)).toHaveLength(1);
      expect(await freshEdge(reference, 10, 11)).toHaveLength(1);

      const result = await validate(swapped);
      // Nothing is proposed: the chamfer refuses, typed, for the card's re-pick.
      expect(result.edgeHashRepairs ?? []).toEqual([]);
      const warning = result.featureWarnings?.find(
        (entry) => entry.kind === 'build-failed'
      );
      expect(warning?.kernelRefusal).toMatchObject({
        family: 'reference',
        code: 'reference_missing',
        reason: 'carry_provenance_changed'
      });
      const carry = carriedSelectionCommands(swapped, result);
      expect(carry.commands).toEqual([]);
      expect(carry.unpersisted).toEqual([]);
    });

    it('still carries the pick when its own boss only grows', async () => {
      const part = bossPart();
      const model = await chamfered(part, 30, 10);
      // The same part, the same pick, an edit that swaps nothing.
      const raised = setParameter(model.document, {
        name: 'h',
        expression: '10'
      });
      const result = await validate(raised);
      expect(result.featureWarnings ?? []).toEqual([]);
      const expected = await freshEdge(
        {
          document: setParameter(part.document, {
            name: 'h',
            expression: '10'
          }),
          bodyId: part.bodyId
        },
        30,
        11
      );
      expect(expected).toHaveLength(1);
      expect(result.edgeHashRepairs).toHaveLength(1);
      expect(result.edgeHashRepairs![0]!.to).toEqual(expected);

      // Stored, it rebuilds cold on boss A's raised edge.
      const carry = carriedSelectionCommands(raised, result);
      expect(carry.unpersisted).toEqual([]);
      expect(carry.commands).toHaveLength(1);
      const stored = carry.commands[0]!.apply(raised);
      const cold = await createExactKernelAdapter();
      try {
        const reopened = await cold.syncDocument(stored);
        expect(reopened.featureWarnings ?? []).toEqual([]);
        expect(reopened.edgeHashRepairs ?? []).toEqual([]);
      } finally {
        cold.dispose();
      }
    });

    it('refuses when two edges play the picked edge’s role', async () => {
      // Both bosses inboard (A at x 18–22, B at x 6–10): their top edges facing
      // +x read the same, so the pick cannot name one of them later.
      const part = bossPart();
      const inboard = {
        ...part,
        document: setParameter(part.document, { name: 'a', expression: '20' })
      };
      const model = await chamfered(inboard, 22, 10);
      const raised = setParameter(model.document, {
        name: 'h',
        expression: '10'
      });
      const result = await validate(raised);
      expect(result.edgeHashRepairs ?? []).toEqual([]);
      expect(
        result.featureWarnings?.find((entry) => entry.kind === 'build-failed')
          ?.kernelRefusal
      ).toMatchObject({
        code: 'reference_missing',
        reason: 'carry_ambiguous'
      });
    });
  }
);
