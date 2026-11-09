import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  chamferEdges,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type EdgeTopology,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { topologyReferenceRepairCommand } from '../apps/web/src/lib/topologyReferenceRepairs';

/**
 * Resize Body through later fillets and chamfers whose picks have no name.
 *
 * The production report: Box 30 × 18 × 24 → Cylinder r6 h31.25 → Union →
 * Fillet → Fillet 2 → Fillet 3 → Chamfer, then a drag of the box's right
 * face from 30 to 22.5 mm. The live preview looked right and release refused
 * with "Selection changed": a later modifier's edges had been stored as bare
 * geometry hashes (the doubly blended body publishes no name for them), the
 * width edit moved those edges, and their hashes stopped matching anything.
 * The rebuild now carries such a selection across an edit that leaves its
 * input's structure unchanged (`exact-edge-selection-transport.ts`) and the
 * app persists the new hashes; a structural change still refuses, typed.
 */

const user = toUserId('user_upstream_resize_carried_edges');

type Predicate = (
  edge: EdgeTopology,
  faces: FaceTopology[],
  body: BodyRepresentation
) => boolean;

function adjacentFaces(body: BodyRepresentation, edge: EdgeTopology) {
  return (edge.adjacentFaceHashes ?? []).flatMap((hash) => {
    const face = body.topology!.faces.find((f) => f.hash === hash);
    return face ? [face] : [];
  });
}

function isPlane(face: FaceTopology, axis: 'x' | 'y' | 'z', sign: 1 | -1) {
  return (
    face.geometry?.surfaceType === 'plane' &&
    (face.geometry.normal?.[axis] ?? 0) * sign > 0.999
  );
}

function isCylinderWall(face: FaceTopology) {
  return (
    face.geometry?.surfaceType === 'cylinder' &&
    face.geometry.featureType !== 'blend'
  );
}

/** The pick a viewport selection stores: named only when every edge is. */
function pick(body: BodyRepresentation, predicate: Predicate) {
  const edges = body.topology!.edges.filter(
    (edge) =>
      edge.displayRole !== 'seam' &&
      predicate(edge, adjacentFaces(body, edge), body)
  );
  return {
    count: edges.length,
    edgeHashes: edges.map((edge) => edge.hash),
    ...(edges.every((edge) => edge.reference)
      ? { edgeReferences: edges.map((edge) => edge.reference!) }
      : {})
  };
}

const atBottom = (faces: FaceTopology[]) =>
  faces.some(
    (face) => isPlane(face, 'z', -1) && Math.abs(face.geometry!.center.z) < 1e-6
  );

interface Model {
  document: ProjectDocument;
  bodyId: BodyId;
  body: BodyRepresentation;
}

describe(
  'upstream resize through unnamed modifier picks',
  {
    timeout: 240_000
  },
  () => {
    let adapter: ExactKernelAdapter;
    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    }, 120_000);
    afterAll(() => adapter.dispose());

    async function modify(
      model: { document: ProjectDocument; bodyId: BodyId },
      kind: 'fillet' | 'chamfer',
      name: string,
      size: number,
      expected: number,
      predicate: Predicate
    ) {
      const derived = await adapter.syncDocument(model.document);
      expect(derived.warnings).toEqual([]);
      const selection = pick(
        derived.bodyRepresentations[model.bodyId]!,
        predicate
      );
      expect(selection.count, `${name} edge count`).toBe(expected);
      return (kind === 'fillet' ? filletEdges : chamferEdges)(model.document, {
        name,
        targetBodyId: model.bodyId,
        edgeHashes: selection.edgeHashes,
        ...(selection.edgeReferences
          ? { edgeReferences: selection.edgeReferences }
          : {}),
        size
      });
    }

    async function settled(model: {
      document: ProjectDocument;
      bodyId: BodyId;
    }): Promise<Model> {
      const derived = await adapter.syncDocument(model.document);
      expect(derived.warnings).toEqual([]);
      return {
        document: { ...model.document, derived },
        bodyId: model.bodyId,
        body: derived.bodyRepresentations[model.bodyId]!
      };
    }

    /** The reported part, its later picks chosen the way a viewport stores them. */
    async function reportedPart(): Promise<Model> {
      const box = addPrimitiveFeature(
        createProjectDocument('Carried edges', user),
        {
          name: 'Box 1',
          primitiveKind: 'box',
          dimensions: { width: 30, height: 18, depth: 24 }
        }
      );
      const cylinder = addPrimitiveFeature(box, {
        name: 'Cylinder 1',
        primitiveKind: 'cylinder',
        dimensions: { radius: 6, height: 31.25 }
      });
      let model: { document: ProjectDocument; bodyId: BodyId } = booleanBodies(
        cylinder,
        {
          name: 'Union 1',
          operation: 'union',
          targetBodyIds: [box.bodyOrder[0]!, cylinder.bodyOrder[1]!]
        }
      );
      // Rounds the right face's four edges and the back top edge.
      model = await modify(model, 'fillet', 'Fillet', 3, 5, (edge) =>
        /^boolean\.edge\.operand\.0\.primitive\.box\.edge\.(?:[zy]\.x-max\.|x\.y-max\.z-max$)/.test(
          edge.reference?.lineageName ?? ''
        )
      );
      // The cylinder's top rim: four arcs, none of them named.
      model = await modify(
        model,
        'fillet',
        'Fillet 2',
        2,
        4,
        (_, faces) =>
          faces.some(isCylinderWall) &&
          faces.some(
            (face) =>
              isPlane(face, 'z', 1) &&
              Math.abs(face.geometry!.center.z - 31.25) < 1e-6
          )
      );
      // Where the cylinder meets the box's left, front and top faces.
      model = await modify(
        model,
        'fillet',
        'Fillet 3',
        2,
        3,
        (_, faces) =>
          faces.some(isCylinderWall) &&
          faces.some(
            (face) =>
              isPlane(face, 'x', -1) ||
              isPlane(face, 'y', -1) ||
              (isPlane(face, 'z', 1) &&
                Math.abs(face.geometry!.center.z - 24) < 1e-6)
          )
      );
      // The sharp bottom edges left; the merged bottom face is unnamed.
      model = await modify(
        model,
        'chamfer',
        'Chamfer',
        0.7,
        6,
        (_, faces) =>
          atBottom(faces) &&
          faces.every((face) => face.geometry?.featureType !== 'blend') &&
          faces.some(
            (face) =>
              isCylinderWall(face) ||
              isPlane(face, 'x', -1) ||
              isPlane(face, 'y', -1) ||
              isPlane(face, 'y', 1)
          )
      );
      return settled(model);
    }

    function feature(document: ProjectDocument, name: string) {
      const found = listFeaturesInOrder(document).find((f) => f.name === name);
      expect(found, name).toBeDefined();
      return found!;
    }

    function boxSide(body: BodyRepresentation, side: string): FaceTopology {
      const face = body.topology!.faces.find((f) =>
        f.reference?.lineageName.endsWith(`box.face.${side}`)
      );
      expect(face, side).toBeDefined();
      return face!;
    }

    /** Plan, preview, commit and persist one resize; returns the commit. */
    async function resize(
      model: Model,
      face: FaceTopology,
      offset: number,
      expectedValue: number
    ) {
      const plan = planFaceOffset({
        document: model.document,
        bodyId: model.bodyId,
        face,
        faceHash: face.hash,
        offset
      });
      expect(plan?.kind).toBe('primitive-dimension');
      if (plan?.kind !== 'primitive-dimension') throw new Error('no plan');
      expect(plan.value).toBeCloseTo(expectedValue, 9);
      const candidate = plan.command.apply(model.document);
      // The drag's exact preview and the release's commit run the same
      // resolution, so they give the same answer.
      const preview = await adapter.previewGeometry(candidate, {
        deferTopology: true
      });
      const commit = await adapter.syncDocument(candidate);
      expect(preview.warnings).toEqual([]);
      expect(commit.warnings).toEqual([]);
      expect(
        commit.featureWarnings?.filter((w) => w.kind !== 'advisory') ?? []
      ).toEqual([]);
      return { candidate, commit };
    }

    /** What the app writes after the commit, rebuilt cold as after a reload. */
    async function persistedAndReopened(
      candidate: ProjectDocument,
      commit: ProjectDocument['derived'],
      carried = true
    ) {
      const repair = topologyReferenceRepairCommand(
        { ...candidate, derived: commit },
        commit
      );
      // Only an edit that moved an unnamed pick has anything to persist.
      expect(repair !== null).toBe(carried);
      const persisted = repair ? repair.apply(candidate) : candidate;
      const fresh = await createExactKernelAdapter();
      try {
        const reopened = await fresh.syncDocument(persisted);
        expect(reopened.warnings).toEqual([]);
        // The stored hashes resolve directly now: nothing left to carry.
        expect(reopened.edgeHashRepairs ?? []).toEqual([]);
        return { persisted, reopened };
      } finally {
        fresh.dispose();
      }
    }

    it('resizes the reported part 30 → 22.5 mm from its right face', async () => {
      const model = await reportedPart();
      // The precondition of the report: later picks stored by hash alone.
      expect(feature(model.document, 'Chamfer').data).not.toHaveProperty(
        'edgeReferences'
      );
      expect(feature(model.document, 'Fillet 2').data).not.toHaveProperty(
        'edgeReferences'
      );
      const right = boxSide(model.body, 'x-max');
      const { candidate, commit } = await resize(model, right, -7.5, 22.5);
      const resized = commit.bodyRepresentations[model.bodyId]!;
      expect(resized.bbox.max.x).toBeCloseTo(22.5, 6);
      expect(resized.bbox.min).toEqual(model.body.bbox.min);
      expect(resized.topology!.faces).toHaveLength(
        model.body.topology!.faces.length
      );
      const chamfer = feature(model.document, 'Chamfer');
      expect(
        commit.edgeHashRepairs?.map((repair) => repair.featureId)
      ).toContain(chamfer.featureId);

      const { persisted, reopened } = await persistedAndReopened(
        candidate,
        commit
      );
      expect(reopened.bodyRepresentations[model.bodyId]!.volume).toBeCloseTo(
        resized.volume,
        6
      );
      const stored = feature(persisted, 'Chamfer').data;
      if (stored.featureKind !== 'chamfer') throw new Error('not a chamfer');
      const original = chamfer.data;
      if (original.featureKind !== 'chamfer') throw new Error('not a chamfer');
      expect(stored.edgeHashes).toHaveLength(original.edgeHashes.length);
      expect(stored.edgeHashes).not.toEqual(original.edgeHashes);

      // Undo restores the stored document as it was, which still builds.
      const undone = await adapter.syncDocument(model.document);
      expect(undone.warnings).toEqual([]);
      expect(undone.edgeHashRepairs ?? []).toEqual([]);
    });

    it.each([
      ['x-max', 6, 36, true],
      ['y-max', -6, 12, true],
      ['y-max', 4.5, 22.5, true],
      // Height moves no unnamed pick: the bottom chamfer and the cylinder's
      // rim stay where they were, and their hashes still resolve.
      ['z-max', -4, 20, false]
    ] as const)(
      'resizes the %s side by %s mm through every later modifier',
      async (side, offset, expected, carried) => {
        const model = await reportedPart();
        const { candidate, commit } = await resize(
          model,
          boxSide(model.body, side),
          offset,
          expected
        );
        await persistedAndReopened(candidate, commit, carried);
      }
    );

    it('carries a plain box chamfer saved by hash alone', async () => {
      const box = addPrimitiveFeature(
        createProjectDocument('Plain box', user),
        {
          name: 'Block',
          primitiveKind: 'box',
          dimensions: { width: 30, height: 18, depth: 24 }
        }
      );
      const base = await adapter.syncDocument(box);
      const body = base.bodyRepresentations[box.bodyOrder[0]!]!;
      const bottom = body.topology!.edges.filter((edge) =>
        atBottom(adjacentFaces(body, edge))
      );
      expect(bottom).toHaveLength(4);
      // A document saved before edges had names: hashes only.
      const chamfered = chamferEdges(box, {
        name: 'Break bottom',
        targetBodyId: box.bodyOrder[0]!,
        edgeHashes: bottom.map((edge) => edge.hash),
        size: 1
      });
      const model = await settled(chamfered);
      const { candidate, commit } = await resize(
        model,
        boxSide(model.body, 'x-max'),
        -7.5,
        22.5
      );
      expect(commit.bodyRepresentations[model.bodyId]!.bbox.max.x).toBeCloseTo(
        22.5,
        6
      );
      await persistedAndReopened(candidate, commit);
    });

    it('carries a cylinder height edit past a hash-only rim chamfer', async () => {
      const cylinder = addPrimitiveFeature(
        createProjectDocument('Chamfered cylinder', user),
        {
          name: 'Post',
          primitiveKind: 'cylinder',
          dimensions: { radius: 6, height: 20 }
        }
      );
      const base = await adapter.syncDocument(cylinder);
      const body = base.bodyRepresentations[cylinder.bodyOrder[0]!]!;
      const rims = body.topology!.edges.filter(
        (edge) => edge.displayRole !== 'seam'
      );
      expect(rims.length).toBeGreaterThan(0);
      const chamfered = chamferEdges(cylinder, {
        name: 'Break rims',
        targetBodyId: cylinder.bodyOrder[0]!,
        edgeHashes: rims.map((edge) => edge.hash),
        size: 1
      });
      const model = await settled(chamfered);
      const top = model.body
        .topology!.faces.filter((face) => isPlane(face, 'z', 1))
        .sort((a, b) => b.geometry!.center.z - a.geometry!.center.z)[0]!;
      const plan = planFaceOffset({
        document: model.document,
        bodyId: model.bodyId,
        face: top,
        faceHash: top.hash,
        offset: -6
      });
      expect(plan?.kind).toBe('primitive-dimension');
      const candidate = plan!.command.apply(model.document);
      const commit = await adapter.syncDocument(candidate);
      expect(commit.warnings).toEqual([]);
      expect(commit.bodyRepresentations[model.bodyId]!.bbox.max.z).toBeCloseTo(
        14,
        6
      );
      await persistedAndReopened(candidate, commit);
    });

    it('still refuses, typed, when the edit removes a selected edge', async () => {
      const box = addPrimitiveFeature(
        createProjectDocument('Swallowed', user),
        {
          name: 'Box 1',
          primitiveKind: 'box',
          dimensions: { width: 30, height: 18, depth: 24 }
        }
      );
      const cylinder = addPrimitiveFeature(box, {
        name: 'Cylinder 1',
        primitiveKind: 'cylinder',
        dimensions: { radius: 6, height: 31.25 }
      });
      const joined = booleanBodies(cylinder, {
        name: 'Union 1',
        operation: 'union',
        targetBodyIds: [box.bodyOrder[0]!, cylinder.bodyOrder[1]!]
      });
      // The front bottom edge, on the merged (unnamed) bottom face.
      const chamfered = await modify(
        joined,
        'chamfer',
        'Chamfer',
        0.7,
        1,
        (_, faces) => atBottom(faces) && faces.some((f) => isPlane(f, 'y', -1))
      );
      const model = await settled(chamfered);
      // At 4 mm wide the cylinder (r6, on the box's corner) swallows the
      // box's whole front face, and that edge with it.
      const plan = planFaceOffset({
        document: model.document,
        bodyId: model.bodyId,
        face: boxSide(model.body, 'x-max'),
        faceHash: boxSide(model.body, 'x-max').hash,
        offset: -26
      });
      expect(plan?.kind).toBe('primitive-dimension');
      const commit = await adapter.syncDocument(
        plan!.command.apply(model.document)
      );
      const refusal = commit.featureWarnings?.find(
        (warning) => warning.featureName === 'Chamfer'
      );
      expect(refusal?.kind).toBe('build-failed');
      expect(refusal?.kernelRefusal).toMatchObject({
        family: 'reference',
        code: 'reference_missing'
      });
      expect(commit.edgeHashRepairs ?? []).toEqual([]);
    });
  }
);
