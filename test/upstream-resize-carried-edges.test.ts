import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  booleanBodies,
  chamferEdges,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder,
  mirrorBody,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type EdgeTopology,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import {
  buildDemoDocument,
  DEMO_DEFINITIONS
} from '../apps/web/src/lib/demos';
import {
  carriedSelectionCommands,
  withCarriedSelections
} from '../apps/web/src/lib/topologyReferenceRepairs';

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

    /**
     * An edit's validation build, as the app runs it: it may propose
     * carrying a hash-only pick the edit stranded. Every other sync here is
     * a plain build, which never carries.
     */
    const validate = (document: ProjectDocument) =>
      adapter.syncDocument(document, undefined, undefined, undefined, {
        proposeCarry: true
      });

    /** What decides a build's outcome, for comparing two builds of one document. */
    function outcome(derived: ProjectDocument['derived']) {
      return {
        warnings: derived.warnings,
        featureWarnings: derived.featureWarnings,
        bodies: Object.entries(derived.bodyRepresentations).map(
          ([id, body]) => [id, Math.round(body.volume * 1e6) / 1e6]
        )
      };
    }

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

    /**
     * The reported part, its later picks chosen the way a viewport stores
     * them. Built at other dimensions it is the fresh-pick reference a
     * carried selection must match edge for edge.
     */
    async function reportedPart(
      dimensions = { width: 30, height: 18, depth: 24 }
    ): Promise<Model> {
      const box = addPrimitiveFeature(
        createProjectDocument('Carried edges', user),
        {
          name: 'Box 1',
          primitiveKind: 'box',
          dimensions
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
                Math.abs(face.geometry!.center.z - dimensions.depth) < 1e-6)
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
        deferTopology: true,
        proposeCarry: true
      });
      const commit = await validate(candidate);
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
      // What the commit stores with the edit (`withCarriedSelections`).
      const carry = carriedSelectionCommands(candidate, commit);
      expect(carry.unpersisted).toEqual([]);
      // Only an edit that moved an unnamed pick has anything to persist.
      expect(carry.commands.length > 0).toBe(carried);
      const persisted = carry.commands.reduce(
        (document, command) => command.apply(document),
        candidate
      );
      // A cold reload: a new adapter holds no memory of earlier builds.
      const fresh = await createExactKernelAdapter();
      try {
        if (carried) {
          // The edit without its stored hashes refuses on a cold adapter,
          // and a plain build on this session's adapter, which has seen the
          // old size, gives exactly the same answer: a carry is a proposal
          // of the edit's validation, never an input of a plain build.
          const stale = await fresh.syncDocument(candidate);
          expect(
            stale.featureWarnings?.some(
              (warning) =>
                warning.kind === 'build-failed' &&
                warning.kernelRefusal?.code === 'reference_missing'
            )
          ).toBe(true);
          expect(outcome(await adapter.syncDocument(candidate))).toEqual(
            outcome(stale)
          );
          fresh.dispose();
        }
        const cold = carried ? await createExactKernelAdapter() : fresh;
        try {
          const reopened = await cold.syncDocument(persisted);
          expect(reopened.warnings).toEqual([]);
          // The stored hashes resolve directly now: nothing left to carry.
          expect(reopened.edgeHashRepairs ?? []).toEqual([]);
          return { persisted, reopened };
        } finally {
          cold.dispose();
        }
      } finally {
        fresh.dispose();
      }
    }

    /** Hash-only modifiers: the picks a carry rewrites. */
    const HASH_ONLY = ['Fillet 2', 'Fillet 3', 'Chamfer'] as const;

    function storedHashes(document: ProjectDocument, name: string) {
      const data = feature(document, name).data;
      if (data.featureKind !== 'fillet' && data.featureKind !== 'chamfer') {
        throw new Error(`${name} is not an edge modifier`);
      }
      return {
        named: data.edgeReferences !== undefined,
        hashes: [...data.edgeHashes].sort((a, b) => a - b)
      };
    }

    /**
     * Edge identity, not just a plausible shape: the persisted picks are the
     * hashes a fresh pick on the part built directly at the new size stores,
     * and the two solids agree in volume and face/edge census.
     */
    function expectSameAsFreshPick(
      persisted: ProjectDocument,
      reopened: ProjectDocument['derived'],
      bodyId: BodyId,
      reference: Model,
      names: readonly string[]
    ) {
      for (const name of names) {
        const carried = storedHashes(persisted, name);
        const fresh = storedHashes(reference.document, name);
        if (fresh.named) continue;
        expect(carried.named, name).toBe(false);
        expect(carried.hashes, `${name} edges`).toEqual(fresh.hashes);
      }
      const body = reopened.bodyRepresentations[bodyId]!;
      expect(body.volume).toBeCloseTo(reference.body.volume, 6);
      expect(body.topology!.faces).toHaveLength(
        reference.body.topology!.faces.length
      );
      expect(body.topology!.edges).toHaveLength(
        reference.body.topology!.edges.length
      );
      expect(body.bbox).toEqual(reference.body.bbox);
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
      expectSameAsFreshPick(
        persisted,
        reopened,
        model.bodyId,
        await reportedPart({ width: 22.5, height: 18, depth: 24 }),
        HASH_ONLY
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
      ['x-max', 6, 36, true, { width: 36, height: 18, depth: 24 }],
      ['y-max', -6, 12, true, { width: 30, height: 12, depth: 24 }],
      ['y-max', 4.5, 22.5, true, { width: 30, height: 22.5, depth: 24 }],
      // Height moves no unnamed pick: the bottom chamfer and the cylinder's
      // rim stay where they were, and their hashes still resolve.
      ['z-max', -4, 20, false, { width: 30, height: 18, depth: 20 }]
    ] as const)(
      'resizes the %s side by %s mm through every later modifier',
      async (side, offset, expected, carried, dimensions) => {
        const model = await reportedPart();
        const { candidate, commit } = await resize(
          model,
          boxSide(model.body, side),
          offset,
          expected
        );
        const { persisted, reopened } = await persistedAndReopened(
          candidate,
          commit,
          carried
        );
        expectSameAsFreshPick(
          persisted,
          reopened,
          model.bodyId,
          await reportedPart(dimensions),
          HASH_ONLY
        );
      }
    );

    /** A box whose bottom edges a document saved before names chamfered. */
    async function hashOnlyBottomChamfer(dimensions: {
      width: number;
      height: number;
      depth: number;
    }) {
      const box = addPrimitiveFeature(
        createProjectDocument('Plain box', user),
        { name: 'Block', primitiveKind: 'box', dimensions }
      );
      const base = await adapter.syncDocument(box);
      const body = base.bodyRepresentations[box.bodyOrder[0]!]!;
      const bottom = body.topology!.edges.filter((edge) =>
        atBottom(adjacentFaces(body, edge))
      );
      expect(bottom).toHaveLength(4);
      // A document saved before edges had names: hashes only.
      return settled(
        chamferEdges(box, {
          name: 'Break bottom',
          targetBodyId: box.bodyOrder[0]!,
          edgeHashes: bottom.map((edge) => edge.hash),
          size: 1
        })
      );
    }

    it('carries a plain box chamfer saved by hash alone', async () => {
      const model = await hashOnlyBottomChamfer({
        width: 30,
        height: 18,
        depth: 24
      });
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
      const { persisted, reopened } = await persistedAndReopened(
        candidate,
        commit
      );
      expectSameAsFreshPick(
        persisted,
        reopened,
        model.bodyId,
        await hashOnlyBottomChamfer({ width: 22.5, height: 18, depth: 24 }),
        ['Break bottom']
      );
    });

    async function hashOnlyRimChamfer(height: number) {
      const cylinder = addPrimitiveFeature(
        createProjectDocument('Chamfered cylinder', user),
        {
          name: 'Post',
          primitiveKind: 'cylinder',
          dimensions: { radius: 6, height }
        }
      );
      const base = await adapter.syncDocument(cylinder);
      const body = base.bodyRepresentations[cylinder.bodyOrder[0]!]!;
      const rims = body.topology!.edges.filter(
        (edge) => edge.displayRole !== 'seam'
      );
      expect(rims).toHaveLength(2);
      return settled(
        chamferEdges(cylinder, {
          name: 'Break rims',
          targetBodyId: cylinder.bodyOrder[0]!,
          edgeHashes: rims.map((edge) => edge.hash),
          size: 1
        })
      );
    }

    it('carries a cylinder height edit past a hash-only rim chamfer', async () => {
      const model = await hashOnlyRimChamfer(20);
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
      const commit = await validate(candidate);
      expect(commit.warnings).toEqual([]);
      expect(commit.bodyRepresentations[model.bodyId]!.bbox.max.z).toBeCloseTo(
        14,
        6
      );
      const { persisted, reopened } = await persistedAndReopened(
        candidate,
        commit
      );
      expectSameAsFreshPick(
        persisted,
        reopened,
        model.bodyId,
        await hashOnlyRimChamfer(14),
        ['Break rims']
      );
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
      const commit = await validate(plan!.command.apply(model.document));
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
    /** The edit refused the named modifier as a lost reference, carrying nothing. */
    function expectRefused(
      derived: ProjectDocument['derived'],
      name: string
    ) {
      const refusal = derived.featureWarnings?.find(
        (warning) => warning.featureName === name
      );
      expect(refusal?.kind, `${name} refusal`).toBe('build-failed');
      expect(refusal?.kernelRefusal).toMatchObject({
        family: 'reference',
        code: 'reference_missing'
      });
      expect(derived.edgeHashRepairs ?? []).toEqual([]);
    }

    /** The long front (−Y) bottom edge, saved by hash alone. */
    function frontBottomChamfer(
      document: ProjectDocument,
      derived: ProjectDocument['derived'],
      bodyId: BodyId,
      length: number
    ) {
      const body = derived.bodyRepresentations[bodyId]!;
      const front = body.topology!.edges.filter((edge) => {
        const faces = adjacentFaces(body, edge);
        return (
          faces.some((face) => isPlane(face, 'z', -1)) &&
          faces.some((face) => isPlane(face, 'y', -1))
        );
      });
      expect(front).toHaveLength(1);
      expect(front[0]!.length).toBeCloseTo(length, 6);
      return chamferEdges(document, {
        name: 'Front break',
        targetBodyId: bodyId,
        edgeHashes: [front[0]!.hash],
        size: 1
      });
    }

    /**
     * Box 30 × 18 × 24 ∪ a cylinder standing on the middle of its footprint
     * and rising through its top: the bottoms are coplanar, so the merged
     * bottom face is one face.
     */
    function boxWithCentredPost(
      dimensions = { width: 30, height: 18, depth: 24 },
      at = { x: dimensions.width / 2, y: dimensions.height / 2 }
    ) {
      const box = addPrimitiveFeature(
        createProjectDocument('Turned part', user),
        { name: 'Box 1', primitiveKind: 'box', dimensions }
      );
      const post = addPrimitiveFeature(box, {
        name: 'Post',
        primitiveKind: 'cylinder',
        dimensions: { radius: 6, height: dimensions.depth + 7.25 }
      });
      const placed = transformBody(post, {
        name: 'Place post',
        targetBodyId: post.bodyOrder[1]!,
        translation: { ...at, z: 0 }
      }).document;
      return booleanBodies(placed, {
        name: 'Union 1',
        operation: 'union',
        targetBodyIds: [placed.bodyOrder[0]!, placed.bodyOrder[1]!]
      });
    }

    it.each([
      ['about the origin', undefined],
      // The post's rim stays where it was, so the frame looks fixed by its
      // anchors alone; the x and y planes moving together refuses it.
      ['about the post', { x: 15, y: 9, z: 0 }]
    ] as const)(
      'refuses to carry a hash-only pick through a 90° turn %s',
      async (_, pivot) => {
        const joined = boxWithCentredPost();
        const turned = transformBody(joined.document, {
          name: 'Turn',
          targetBodyId: joined.bodyId,
          translation: { x: 0, y: 0, z: 0 },
          rotationDeg: { x: 0, y: 0, z: 0 },
          ...(pivot ? { pivot } : {})
        }).document;
        const base = await adapter.syncDocument(turned);
        expect(base.warnings).toEqual([]);
        const model = await settled({
          document: frontBottomChamfer(turned, base, joined.bodyId, 30)
            .document,
          bodyId: joined.bodyId
        });
        // The same labels in the same multiset after a quarter turn: the
        // old short 18 mm edge now sits at −Y and would read as the pick.
        const turn = feature(model.document, 'Turn');
        if (turn.data.featureKind !== 'transform') throw new Error('no turn');
        const edited = updateFeature(model.document, {
          featureId: turn.featureId,
          data: {
            transform: {
              ...turn.data.transform,
              rotationDeg: { x: 0, y: 0, z: 90 }
            }
          }
        });
        const preview = await adapter.previewGeometry(edited, {
          deferTopology: true,
          proposeCarry: true
        });
        expect(preview.warnings.length).toBeGreaterThan(0);
        expectRefused(await validate(edited), 'Front break');
      }
    );

    it('refuses to carry a hash-only pick on a mirror copy whose plane turns', async () => {
      const joined = boxWithCentredPost();
      const mirrored = mirrorBody(joined.document, {
        name: 'Mirror',
        targetBodyId: joined.bodyId,
        plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
      });
      const base = await adapter.syncDocument(mirrored.document);
      expect(base.warnings).toEqual([]);
      const model = await settled({
        document: frontBottomChamfer(
          mirrored.document,
          base,
          mirrored.bodyId,
          30
        ).document,
        bodyId: mirrored.bodyId
      });
      const mirror = feature(model.document, 'Mirror');
      const edited = updateFeature(model.document, {
        featureId: mirror.featureId,
        data: {
          plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } }
        }
      });
      expectRefused(await validate(edited), 'Front break');
    });

    it('stores the carry with the edit while an unrelated feature is broken', async () => {
      // A second, unrelated body whose own chamfer names an edge that was
      // never there: fail-soft replay drops it on every build.
      async function withBrokenNeighbour(width: number) {
        const model = await hashOnlyBottomChamfer({
          width,
          height: 18,
          depth: 24
        });
        const spare = addPrimitiveFeature(model.document, {
          name: 'Spare',
          primitiveKind: 'box',
          dimensions: { width: 5, height: 5, depth: 5 }
        });
        const broken = chamferEdges(spare, {
          name: 'Broken',
          targetBodyId: spare.bodyOrder.at(-1)!,
          edgeHashes: [123456789],
          size: 1
        }).document;
        const derived = await adapter.syncDocument(broken);
        expectRefusedOnly(derived, 'Broken');
        return {
          document: { ...broken, derived },
          bodyId: model.bodyId,
          body: derived.bodyRepresentations[model.bodyId]!
        };
      }

      function expectRefusedOnly(
        derived: ProjectDocument['derived'],
        name: string
      ) {
        expect(
          derived.featureWarnings
            ?.filter((warning) => warning.kind !== 'advisory')
            .map((warning) => [warning.featureName, warning.kind])
        ).toEqual([[name, 'build-failed']]);
      }

      const model = await withBrokenNeighbour(30);
      const plan = planFaceOffset({
        document: model.document,
        bodyId: model.bodyId,
        face: boxSide(model.body, 'x-max'),
        faceHash: boxSide(model.body, 'x-max').hash,
        offset: -7.5
      });
      expect(plan?.kind).toBe('primitive-dimension');
      const candidate = plan!.command.apply(model.document);
      const commit = await validate(candidate);
      expectRefusedOnly(commit, 'Broken');
      expect(
        commit.edgeHashRepairs?.map((repair) => repair.featureId)
      ).toEqual([feature(model.document, 'Break bottom').featureId]);

      // What `executeCommand` commits: the edit and the carried hashes, in
      // one revision, although the model is partially built.
      const result = withCarriedSelections(
        model.document,
        [plan!.command],
        commit
      );
      if ('refusal' in result) throw new Error(result.refusal);
      expect(result.commands).toHaveLength(2);
      const committed = result.commands.reduce(
        (document, command) => command.apply(document),
        model.document
      );
      const cold = await createExactKernelAdapter();
      try {
        const reopened = await cold.syncDocument(committed);
        expectRefusedOnly(reopened, 'Broken');
        expect(reopened.edgeHashRepairs ?? []).toEqual([]);
        const reference = await withBrokenNeighbour(22.5);
        expect(storedHashes(committed, 'Break bottom').hashes).toEqual(
          storedHashes(reference.document, 'Break bottom').hashes
        );
        expect(
          reopened.bodyRepresentations[model.bodyId]!.volume
        ).toBeCloseTo(reference.body.volume, 6);
      } finally {
        cold.dispose();
      }
    });

    it('does not carry downstream of a suppressed step, where it could not be stored', async () => {
      // Block → Spare (suppressed) → a hash-only chamfer on Block. Nothing a
      // build learns after a suppressed step is written back, so a carry
      // there would build geometry the saved document cannot rebuild.
      const block = addPrimitiveFeature(
        createProjectDocument('Suppressed neighbour', user),
        {
          name: 'Block',
          primitiveKind: 'box',
          dimensions: { width: 30, height: 18, depth: 24 }
        }
      );
      const spare = addPrimitiveFeature(block, {
        name: 'Spare',
        primitiveKind: 'box',
        dimensions: { width: 5, height: 5, depth: 5 }
      });
      const base = await adapter.syncDocument(spare);
      const body = base.bodyRepresentations[block.bodyOrder[0]!]!;
      const chamfered = chamferEdges(spare, {
        name: 'Break bottom',
        targetBodyId: block.bodyOrder[0]!,
        edgeHashes: body
          .topology!.edges.filter((edge) => atBottom(adjacentFaces(body, edge)))
          .map((edge) => edge.hash),
        size: 1
      }).document;
      const spareNode = feature(chamfered, 'Spare');
      const suppressed: ProjectDocument = {
        ...chamfered,
        nodes: {
          ...chamfered.nodes,
          [spareNode.id]: {
            ...spareNode,
            metadata: {
              ...spareNode.metadata,
              [FEATURE_SUPPRESSED_METADATA_KEY]: true
            }
          }
        }
      };
      const settledBuild = await adapter.syncDocument(suppressed);
      expect(
        settledBuild.featureWarnings?.map((warning) => warning.kind)
      ).toEqual(['suppressed']);
      const blockFeature = feature(suppressed, 'Block');
      const edited = updateFeature(suppressed, {
        featureId: blockFeature.featureId,
        data: { dimensions: { width: 22.5, height: 18, depth: 24 } }
      });
      expectRefused(await validate(edited), 'Break bottom');
    });

    it('carries the Heat Sink corner fillets to the corners a fresh pick takes', async () => {
      // The e2e edit (feature-history.spec.ts): the base extrude's Distance
      // set to `base_t + 1`. The fins stay seated at `base_t - 0.5`, so the
      // base thickens under them and every corner keeps its place.
      const sink = await buildDemoDocument(
        DEMO_DEFINITIONS.find((demo) => demo.key === 'heatsink')!,
        user,
        (candidate) => adapter.syncDocument(candidate)
      );
      const fillet = feature(sink, 'Base corner fillets');
      if (fillet.data.featureKind !== 'fillet') throw new Error('no fillet');
      expect(fillet.data.edgeReferences).toBeUndefined();
      const bodyId = fillet.bodyId!;
      // Opened as the app opens it: built once under its own project id.
      expect((await adapter.syncDocument(sink)).warnings).toEqual([]);
      const extrude = feature(sink, 'Extrude base');
      const thicker = updateFeature(sink, {
        featureId: extrude.featureId,
        data: { distance: 'base_t + 1' }
      });
      const commit = await validate(thicker);
      expect(commit.warnings).toEqual([]);
      expect(commit.edgeHashRepairs?.map((r) => r.featureId)).toEqual([
        fillet.featureId
      ]);
      const carried = commit.bodyRepresentations[bodyId]!;

      // Fresh pick at the new thickness: the four vertical base corners, by
      // the demo's own rule, on the union the fillet reads.
      const suppressed: ProjectDocument = {
        ...thicker,
        nodes: {
          ...thicker.nodes,
          [fillet.id]: {
            ...fillet,
            metadata: {
              ...fillet.metadata,
              [FEATURE_SUPPRESSED_METADATA_KEY]: true
            }
          }
        }
      };
      const cold = await createExactKernelAdapter();
      try {
        const union = (await cold.syncDocument(suppressed))
          .bodyRepresentations[fillet.data.targetBodyId]!;
        const near = (value: number, target: number) =>
          Math.abs(value - target) < 0.01;
        const corners = union.topology!.edges.filter((edge) => {
          const xs: number[] = [];
          const ys: number[] = [];
          const zs: number[] = [];
          for (let i = 0; i < edge.points.length; i += 3) {
            xs.push(edge.points[i]!);
            ys.push(edge.points[i + 1]!);
            zs.push(edge.points[i + 2]!);
          }
          return (
            xs.every((x) => near(x, xs[0]!)) &&
            ys.every((y) => near(y, ys[0]!)) &&
            (near(xs[0]!, 0) || near(xs[0]!, 90)) &&
            (near(ys[0]!, 0) || near(ys[0]!, 60)) &&
            Math.min(...zs) > -0.1 &&
            Math.max(...zs) < 7.1 &&
            Math.max(...zs) - Math.min(...zs) > 4
          );
        });
        expect(corners).toHaveLength(4);
        const fresh = corners.map((edge) => edge.hash).sort((a, b) => a - b);
        const result = withCarriedSelections(
          sink,
          [
            {
              ...commandFactories.updateFeature({
                featureId: extrude.featureId,
                data: { distance: 'base_t + 1' }
              })
            }
          ],
          commit
        );
        if ('refusal' in result) throw new Error(result.refusal);
        const committed = result.commands.reduce(
          (document, command) => command.apply(document),
          sink
        );
        expect(storedHashes(committed, 'Base corner fillets').hashes).toEqual(
          fresh
        );
        const reference = (
          await cold.syncDocument(
            updateFeature(thicker, {
              featureId: fillet.featureId,
              data: { edgeHashes: fresh }
            })
          )
        ).bodyRepresentations[bodyId]!;
        expect(carried.volume).toBeCloseTo(reference.volume, 6);
        expect(carried.topology!.faces).toHaveLength(
          reference.topology!.faces.length
        );
        expect(carried.topology!.edges).toHaveLength(
          reference.topology!.edges.length
        );
        // Four 2.5 mm corner rounds over the 7 mm base: (4 - π) r² · 7
        // less than the unrounded union.
        expect(union.volume - carried.volume).toBeCloseTo(
          (4 - Math.PI) * 2.5 ** 2 * 7,
          4
        );
      } finally {
        cold.dispose();
      }

      // A base thicker than the fins are tall swallows them. The corners the
      // fillet saved belong to a different shape now, so it cannot follow:
      // the downstream failure the e2e explains and opens for repair.
      const swallowed = await validate(
        updateFeature(sink, {
          featureId: extrude.featureId,
          data: { distance: 'base_t + fin_h' }
        })
      );
      expectRefused(swallowed, 'Base corner fillets');
      expect(
        swallowed.featureWarnings
          ?.filter((warning) => warning.kind === 'build-failed')
          .map((warning) => warning.featureName)
      ).toEqual(['Base corner fillets']);
    });

    describe('a disk with an off-centre boss', () => {
      /**
       * Disk r20 h10 at the origin ∪ a boss standing on it, then a Turn
       * about z, then a hash-only fillet on one vertical boss edge (the kernel cannot chamfer it where it meets the disk). The
       * disk's rims keep their hashes under any turn about its own axis, and
       * a turned boss can sit exactly where a moved one would.
       */
      async function diskWithBoss(options: {
        boss: { width: number; height: number };
        at: { x: number; y: number };
        edge: { x: number; y: number };
      }) {
        const disk = addPrimitiveFeature(
          createProjectDocument('Disk with boss', user),
          {
            name: 'Disk',
            primitiveKind: 'cylinder',
            dimensions: { radius: 20, height: 10 }
          }
        );
        const boss = addPrimitiveFeature(disk, {
          name: 'Boss',
          primitiveKind: 'box',
          dimensions: { ...options.boss, depth: 6 }
        });
        const placed = transformBody(boss, {
          name: 'Place boss',
          targetBodyId: boss.bodyOrder[1]!,
          translation: { ...options.at, z: 10 }
        }).document;
        const joined = booleanBodies(placed, {
          name: 'Union 1',
          operation: 'union',
          targetBodyIds: [placed.bodyOrder[0]!, placed.bodyOrder[1]!]
        });
        const turned = transformBody(joined.document, {
          name: 'Turn',
          targetBodyId: joined.bodyId,
          translation: { x: 0, y: 0, z: 0 },
          rotationDeg: { x: 0, y: 0, z: 0 }
        }).document;
        const base = await adapter.syncDocument(turned);
        expect(base.warnings).toEqual([]);
        const body = base.bodyRepresentations[joined.bodyId]!;
        const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
        const edges = body.topology!.edges.filter((edge) => {
          for (let i = 0; i < edge.points.length; i += 3) {
            if (
              !near(edge.points[i]!, options.edge.x) ||
              !near(edge.points[i + 1]!, options.edge.y)
            )
              return false;
          }
          return true;
        });
        expect(edges).toHaveLength(1);
        // Imported or legacy picks are hashes alone.
        return settled({
          document: filletEdges(turned, {
            name: 'Boss break',
            targetBodyId: joined.bodyId,
            edgeHashes: [edges[0]!.hash],
            size: 0.5
          }).document,
          bodyId: joined.bodyId
        });
      }

      function turnedTo(model: Model, degrees: number) {
        const turn = feature(model.document, 'Turn');
        if (turn.data.featureKind !== 'transform') throw new Error('no turn');
        return updateFeature(model.document, {
          featureId: turn.featureId,
          data: {
            transform: {
              ...turn.data.transform,
              rotationDeg: { x: 0, y: 0, z: degrees }
            }
          }
        });
      }

      it('refuses to carry through a 180° turn that looks like a move', async () => {
        // The boss goes from x∈[3,7] to x∈[−7,−3]: only the x planes move,
        // and the rims stay put. The turned edge is at (−7, −2); the edge
        // where the old one sat is at (−3, 2). Only the edit tells them apart.
        const model = await diskWithBoss({
          boss: { width: 4, height: 4 },
          at: { x: 3, y: -2 },
          edge: { x: 7, y: 2 }
        });
        expectRefused(await validate(turnedTo(model, 180)), 'Boss break');
      });

      it('refuses to carry through a 90° turn of a boss centred off-axis', async () => {
        // The boss at x∈[3,7], y∈[3,7] turns to x∈[−7,−3], y∈[3,7]: the y
        // planes stay, the x planes move along one line, the rims anchor.
        const model = await diskWithBoss({
          boss: { width: 4, height: 4 },
          at: { x: 3, y: 3 },
          edge: { x: 7, y: 7 }
        });
        expectRefused(await validate(turnedTo(model, 90)), 'Boss break');
      });

      it('carries a boss width edit to the edge a fresh pick takes', async () => {
        const model = await diskWithBoss({
          boss: { width: 4, height: 4 },
          at: { x: 3, y: -2 },
          edge: { x: 7, y: 2 }
        });
        const boss = feature(model.document, 'Boss');
        const candidate = updateFeature(model.document, {
          featureId: boss.featureId,
          data: { dimensions: { width: 5, height: 4, depth: 6 } }
        });
        const commit = await validate(candidate);
        expect(commit.warnings).toEqual([]);
        const { persisted, reopened } = await persistedAndReopened(
          candidate,
          commit
        );
        expectSameAsFreshPick(
          persisted,
          reopened,
          model.bodyId,
          await diskWithBoss({
            boss: { width: 5, height: 4 },
            at: { x: 3, y: -2 },
            edge: { x: 8, y: 2 }
          }),
          ['Boss break']
        );
      });
    });

    describe('a part with equal sides', () => {
      const square = { width: 20, height: 20, depth: 24 };

      async function squarePart(dimensions = square, turn = true) {
        // The post stays where the square part centres it.
        const joined = boxWithCentredPost(dimensions, { x: 10, y: 10 });
        const turned = turn
          ? transformBody(joined.document, {
              name: 'Turn',
              targetBodyId: joined.bodyId,
              translation: { x: 0, y: 0, z: 0 },
              rotationDeg: { x: 0, y: 0, z: 0 }
            }).document
          : joined.document;
        const base = await adapter.syncDocument(turned);
        expect(base.warnings).toEqual([]);
        return settled({
          document: frontBottomChamfer(
            turned,
            base,
            joined.bodyId,
            dimensions.width
          ).document,
          bodyId: joined.bodyId
        });
      }

      function turnedBy(model: Model, degrees: number, pivot?: { x: number; y: number; z: number }) {
        const turn = feature(model.document, 'Turn');
        if (turn.data.featureKind !== 'transform') throw new Error('no turn');
        return updateFeature(model.document, {
          featureId: turn.featureId,
          data: {
            transform: {
              ...turn.data.transform,
              rotationDeg: { x: 0, y: 0, z: degrees },
              ...(pivot ? { pivot } : {})
            }
          }
        });
      }

      it('refuses a quarter turn about the origin', async () => {
        const model = await squarePart();
        expectRefused(
          await validate(turnedBy(model, 90)),
          'Front break'
        );
      });

      it('leaves a turn onto itself to the stored hash, carrying nothing', async () => {
        // A quarter turn about the centre maps the part onto itself, so the
        // stored hash still names the edge at −Y, as it always has.
        const model = await squarePart();
        const derived = await validate(
          turnedBy(model, 90, { x: 10, y: 10, z: 0 })
        );
        expect(derived.warnings).toEqual([]);
        expect(derived.edgeHashRepairs ?? []).toEqual([]);
        expect(derived.bodyRepresentations[model.bodyId]!.volume).toBeCloseTo(
          model.body.volume,
          6
        );
      });

      it('carries a resize to the edge a fresh pick takes', async () => {
        // The post is placed by a transform, so this edits the Box's width
        // the way its dimension field does: 20 → 26, the post staying put.
        const model = await squarePart(square, false);
        const box = feature(model.document, 'Box 1');
        const candidate = updateFeature(model.document, {
          featureId: box.featureId,
          data: { dimensions: { ...square, width: 26 } }
        });
        const commit = await validate(candidate);
        expect(commit.warnings).toEqual([]);
        const { persisted, reopened } = await persistedAndReopened(
          candidate,
          commit
        );
        expectSameAsFreshPick(
          persisted,
          reopened,
          model.bodyId,
          await squarePart({ width: 26, height: 20, depth: 24 }, false),
          ['Front break']
        );
      });
    });
  }
);
