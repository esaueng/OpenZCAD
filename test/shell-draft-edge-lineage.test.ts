import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  draftBody,
  filletEdges,
  listFeaturesInOrder,
  shellBody,
  updateFeature
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

/**
 * QA 2026-11-14 finding #8: an upstream edit refused with "A selected edge
 * no longer exists" while the edge plainly still did.
 *
 * Shell and Draft published no lineage at all, so every fillet or chamfer
 * picked on a shelled or drafted body was stored as a bare geometry hash. A
 * Box height edit, or a draft angle edit, moves those edges, their hashes
 * stop matching anything, and the plain rebuild — a reload, Undo/Redo, a
 * collaborator — refuses. The carry proposal of #1330 rescues some of these
 * for an edit's own commit, but never a draft angle (a turn, not a resize),
 * and never a plain build.
 *
 * Both operations now publish the faces they can prove and the boundary
 * edges between them (`shellLineage`, `draftLineage`), so these picks are
 * stored by name and every build resolves them. Each edit below is checked
 * against the same part authored fresh at the new size.
 */

const user = toUserId('user_shell_draft_edge_lineage');

type Predicate = (edge: EdgeTopology, faces: FaceTopology[]) => boolean;

function facesOf(body: BodyRepresentation, edge: EdgeTopology) {
  return (edge.adjacentFaceHashes ?? []).flatMap((hash) => {
    const face = body.topology!.faces.find((f) => f.hash === hash);
    return face ? [face] : [];
  });
}

const plane = (face: FaceTopology, axis: 'x' | 'y' | 'z', sign: 1 | -1) =>
  face.geometry?.surfaceType === 'plane' &&
  (face.geometry.normal?.[axis] ?? 0) * sign > 0.999;

const side = (face: FaceTopology) =>
  plane(face, 'x', 1) ||
  plane(face, 'x', -1) ||
  plane(face, 'z', 1) ||
  plane(face, 'z', -1);

/** The pick a viewport selection stores: named only when every edge is. */
function pickEdges(body: BodyRepresentation, predicate: Predicate) {
  const edges = body.topology!.edges.filter(
    (edge) =>
      edge.displayRole !== 'seam' && predicate(edge, facesOf(body, edge))
  );
  return {
    edges,
    edgeHashes: edges.map((edge) => edge.hash),
    ...(edges.every((edge) => edge.reference)
      ? { edgeReferences: edges.map((edge) => edge.reference!) }
      : {})
  };
}

function pickFaces(
  body: BodyRepresentation,
  predicate: (face: FaceTopology) => boolean
) {
  const faces = body.topology!.faces.filter(predicate);
  return {
    faces,
    faceHashes: faces.map((face) => face.hash),
    ...(faces.every((face) => face.reference)
      ? { faceReferences: faces.map((face) => face.reference!) }
      : {})
  };
}

function feature(document: ProjectDocument, name: string) {
  const found = listFeaturesInOrder(document).find((f) => f.name === name);
  expect(found, name).toBeDefined();
  return found!;
}

/** Every published name is unique and its stored hash is the entity's own. */
function expectSoundLineage(body: BodyRepresentation) {
  for (const kind of ['faces', 'edges'] as const) {
    const named = (body.topology![kind] as (FaceTopology | EdgeTopology)[])
      .filter((entity) => entity.reference)
      .map((entity) => ({ entity, reference: entity.reference! }));
    const identities = named.map(({ reference }) =>
      JSON.stringify([reference.producingFeatureId, reference.lineageName])
    );
    expect(new Set(identities).size, `${kind} identities`).toBe(
      identities.length
    );
    for (const { entity, reference } of named) {
      expect(reference.currentHash).toBe(entity.hash);
    }
  }
}

describe('shell and draft edge lineage', { timeout: 300_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => adapter.dispose());

  async function built(document: ProjectDocument, bodyId: BodyId) {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    return derived.bodyRepresentations[bodyId]!;
  }

  /** Box → Shell (open top) → Fillet on the eight vertical edges. */
  async function shelledBox(height: number) {
    let document = addPrimitiveFeature(
      createProjectDocument('Shelled box', user),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 60, height, depth: 40 }
      }
    );
    let bodyId = document.bodyOrder[0]!;
    const opening = pickFaces(await built(document, bodyId), (face) =>
      plane(face, 'y', 1)
    );
    ({ document, bodyId } = shellBody(document, {
      name: 'Shell',
      targetBodyId: bodyId,
      openingFaceHashes: opening.faceHashes,
      ...(opening.faceReferences
        ? { openingFaceReferences: opening.faceReferences }
        : {}),
      thickness: 2
    }));
    const shelled = await built(document, bodyId);
    expectSoundLineage(shelled);
    const vertical = pickEdges(
      shelled,
      (_, faces) => faces.length === 2 && faces.every(side)
    );
    expect(vertical.edges).toHaveLength(8);
    ({ document, bodyId } = filletEdges(document, {
      name: 'Fillet',
      targetBodyId: bodyId,
      edgeHashes: vertical.edgeHashes,
      ...(vertical.edgeReferences
        ? { edgeReferences: vertical.edgeReferences }
        : {}),
      size: 1
    }));
    return { document, bodyId, shelled, vertical };
  }

  it('names a shelled box’s kept faces, rim, inner walls and their edges', async () => {
    const { shelled, vertical } = await shelledBox(30);
    const names = shelled
      .topology!.faces.map((face) => face.reference?.lineageName)
      .filter(Boolean);
    // Five kept outer faces, the rim on the removed top's plane, and the
    // five inner walls: every face of the shelled box.
    expect(names).toHaveLength(shelled.topology!.faces.length);
    expect(
      names.filter((name) => name!.startsWith('shell.face.rim.'))
    ).toHaveLength(1);
    expect(
      names.filter((name) => name!.startsWith('shell.face.inner.'))
    ).toHaveLength(5);
    // The outer and the inner vertical edges are both stored by name.
    expect(vertical.edgeReferences).toHaveLength(8);
    for (const reference of vertical.edgeReferences!) {
      expect(reference.lineageName).toMatch(/^boundary\.edge\./);
    }
  });

  it('keeps a shelled box’s fillet through a height edit, 30 → 40', async () => {
    const model = await shelledBox(30);
    const box = feature(model.document, 'Box');
    const edited = updateFeature(model.document, {
      featureId: box.featureId,
      data: { dimensions: { width: 60, height: 40, depth: 40 } }
    });
    // A plain build: no carry proposal, as after a reload.
    const after = await adapter.syncDocument(edited);
    expect(after.warnings).toEqual([]);
    expect(after.edgeHashRepairs ?? []).toEqual([]);

    const fresh = await shelledBox(40);
    const oracle = await built(fresh.document, fresh.bodyId);
    const result = after.bodyRepresentations[model.bodyId]!;
    expect(result.volume).toBeCloseTo(oracle.volume, 6);
    expect(result.topology!.faces).toHaveLength(oracle.topology!.faces.length);
    expect(result.topology!.edges).toHaveLength(oracle.topology!.edges.length);
  });

  /** Box → Draft its four sides about the bottom → Fillet one top edge. */
  async function draftedBox(angleDeg: number, height = 30) {
    let document = addPrimitiveFeature(
      createProjectDocument('Drafted box', user),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 60, height, depth: 40 }
      }
    );
    let bodyId = document.bodyOrder[0]!;
    const sides = pickFaces(await built(document, bodyId), side);
    expect(sides.faces).toHaveLength(4);
    ({ document, bodyId } = draftBody(document, {
      name: 'Draft',
      targetBodyId: bodyId,
      faceHashes: sides.faceHashes,
      ...(sides.faceReferences ? { faceReferences: sides.faceReferences } : {}),
      pullDirection: { x: 0, y: 1, z: 0 },
      neutralPoint: { x: 0, y: 0, z: 0 },
      angleDeg
    }));
    const drafted = await built(document, bodyId);
    expectSoundLineage(drafted);
    // The top edge on the drafted +x side.
    const edge = pickEdges(
      drafted,
      (_, faces) =>
        faces.some((face) => plane(face, 'y', 1)) &&
        faces.some(
          (face) =>
            face.geometry?.surfaceType === 'plane' &&
            (face.geometry.normal?.x ?? 0) > 0.5
        )
    );
    expect(edge.edges).toHaveLength(1);
    ({ document, bodyId } = filletEdges(document, {
      name: 'Fillet',
      targetBodyId: bodyId,
      edgeHashes: edge.edgeHashes,
      ...(edge.edgeReferences ? { edgeReferences: edge.edgeReferences } : {}),
      size: 3
    }));
    return { document, bodyId, drafted, edge };
  }

  it('names a drafted box’s faces and stores the fillet edge by name', async () => {
    const { drafted, edge } = await draftedBox(2);
    const names = drafted
      .topology!.faces.map((face) => face.reference?.lineageName)
      .filter(Boolean);
    expect(names).toHaveLength(6);
    expect(
      names.filter((name) => name!.startsWith('draft.face.'))
    ).toHaveLength(4);
    expect(edge.edgeReferences?.[0]?.lineageName).toMatch(/^boundary\.edge\./);
  });

  for (const angle of [3, 10, 30]) {
    it(`keeps a drafted box’s fillet through a draft angle edit, 2° → ${angle}°`, async () => {
      const model = await draftedBox(2);
      const draft = feature(model.document, 'Draft');
      const edited = updateFeature(model.document, {
        featureId: draft.featureId,
        data: { ...draft.data, angleDeg: angle } as typeof draft.data
      });
      const after = await adapter.syncDocument(edited);
      expect(after.warnings).toEqual([]);

      const fresh = await draftedBox(angle);
      const oracle = await built(fresh.document, fresh.bodyId);
      const result = after.bodyRepresentations[model.bodyId]!;
      expect(result.volume).toBeCloseTo(oracle.volume, 6);
      expect(result.topology!.faces).toHaveLength(
        oracle.topology!.faces.length
      );
    });
  }

  it('keeps a drafted box’s fillet through a box height edit', async () => {
    const model = await draftedBox(2);
    const box = feature(model.document, 'Box');
    const edited = updateFeature(model.document, {
      featureId: box.featureId,
      data: { dimensions: { width: 60, height: 40, depth: 40 } }
    });
    const after = await adapter.syncDocument(edited);
    expect(after.warnings).toEqual([]);
    const fresh = await draftedBox(2, 40);
    const oracle = await built(fresh.document, fresh.bodyId);
    expect(after.bodyRepresentations[model.bodyId]!.volume).toBeCloseTo(
      oracle.volume,
      6
    );
  });
});
