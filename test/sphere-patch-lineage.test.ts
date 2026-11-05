import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  importStepBody,
  normalizeDocument,
  transformBody,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import { primitiveCylinderRadiusAncestor } from '../apps/web/src/lib/interaction/cylinderPrimitiveAncestry';
import { sphereCylinderUnionInputs } from './support/sphere-cylinder-union';

/**
 * K06 sphere-patch identity. A primitive sphere's two hemispheres share one
 * exact witness, so until now neither carried a name, the seam a boss makes
 * with a sphere could not be named, and a fillet on that seam broke as soon
 * as the boss's Cylinder radius changed. Each hemisphere is now named by the
 * pole its trimmed face holds, carried through transforms and booleans by
 * the same pole, and the seam pieces by their place around the boss wall.
 */
const SPHERE_FACE =
  /^boolean\.face\.operand\.0\.primitive\.sphere\.face\.z-(max|min)$/;
const SEAM_PIECE =
  /^boolean\.edge\.between\.operand\.0\.primitive\.sphere\.face\.z-max\|operand\.1\.primitive\.cylinder\.face\.wall\.piece\.(\d)\.of\.4$/;

function names(body: BodyRepresentation, kind: 'faces' | 'edges') {
  return (body.topology?.[kind] ?? [])
    .map((entry) => entry.reference?.lineageName)
    .filter((name): name is string => name !== undefined)
    .sort();
}

function reopened(document: ProjectDocument): ProjectDocument {
  return normalizeDocument(
    JSON.parse(
      JSON.stringify(withoutDerivedProjection(document))
    ) as ProjectDocument
  );
}

describe('sphere patch lineage', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => {
    adapter.dispose();
  });

  it('names both hemispheres of a placed and of a rotated sphere', async () => {
    let document = addPrimitiveFeature(
      createProjectDocument('Sphere', toUserId('user_sphere_patch')),
      { name: 'Ball', primitiveKind: 'sphere', dimensions: { radius: 10 } }
    );
    const ball = document.bodyOrder[0]!;
    const plain = await adapter.syncDocument(document);
    const plainBody = plain.bodyRepresentations[ball]!;
    expect(names(plainBody, 'faces')).toEqual([
      'primitive.sphere.face.z-max',
      'primitive.sphere.face.z-min'
    ]);
    // ADR-011 is unchanged: the two patches still share one hash.
    expect(
      new Set(plainBody.topology!.faces.map((face) => face.hash)).size
    ).toBe(1);

    document = transformBody(document, {
      name: 'Tip over',
      targetBodyId: ball,
      translation: { x: 4, y: -2, z: 1 },
      rotationDeg: { x: 90, y: 0, z: 30 }
    }).document;
    const moved = await adapter.syncDocument(document);
    const movedId = document.bodyOrder.at(-1)!;
    expect(names(moved.bodyRepresentations[movedId]!, 'faces')).toEqual([
      'primitive.sphere.face.z-max',
      'primitive.sphere.face.z-min'
    ]);
  }, 120_000);

  it('names the union seam pieces and keeps them through undo and reopen', async () => {
    const { document, sphere, cylinder } = sphereCylinderUnionInputs();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Union',
        operation: 'union',
        targetBodyIds: [sphere, cylinder]
      })
    );
    const bodyId = manager.document.bodyOrder.at(-1)!;
    const sync = (doc: ProjectDocument, using = adapter) =>
      using.syncDocument(doc, undefined, undefined, undefined, {
        lineageDemand: [bodyId]
      });
    const joined = (await sync(manager.document)).bodyRepresentations[bodyId]!;
    const sphereFaces = names(joined, 'faces').filter((name) =>
      SPHERE_FACE.test(name)
    );
    expect(sphereFaces).toEqual([
      'boolean.face.operand.0.primitive.sphere.face.z-max',
      'boolean.face.operand.0.primitive.sphere.face.z-min'
    ]);
    const seamEdges = joined.topology!.edges.filter((edge) =>
      SEAM_PIECE.test(edge.reference?.lineageName ?? '')
    );
    expect(
      seamEdges
        .map((edge) => SEAM_PIECE.exec(edge.reference!.lineageName)![1])
        .sort()
    ).toEqual(['0', '1', '2', '3']);
    // Every piece is a real wall/sphere seam, not some other edge.
    const surface = new Map(
      joined.topology!.faces.map((face) => [
        face.hash,
        face.geometry?.surfaceType
      ])
    );
    for (const edge of seamEdges) {
      expect(
        (edge.adjacentFaceHashes ?? []).map((hash) => surface.get(hash)).sort()
      ).toEqual(['cylinder', 'sphere']);
    }

    manager.undo();
    await sync(manager.document);
    manager.redo();
    const redone = (await sync(manager.document)).bodyRepresentations[bodyId]!;
    expect(names(redone, 'faces')).toEqual(names(joined, 'faces'));
    expect(names(redone, 'edges')).toEqual(names(joined, 'edges'));

    const fresh = await createExactKernelAdapter();
    try {
      const rebuilt = (await sync(reopened(manager.document), fresh))
        .bodyRepresentations[bodyId]!;
      expect(names(rebuilt, 'faces')).toEqual(names(joined, 'faces'));
      expect(names(rebuilt, 'edges')).toEqual(names(joined, 'edges'));
    } finally {
      fresh.dispose();
    }
  }, 240_000);

  it('keeps a lineage-picked seam fillet resolving across a Cylinder radius change', async () => {
    const { document, sphere, cylinder } = sphereCylinderUnionInputs();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Union',
        operation: 'union',
        targetBodyIds: [sphere, cylinder]
      })
    );
    const unionId = manager.document.bodyOrder.at(-1)!;
    const joined = await adapter.syncDocument(
      manager.document,
      undefined,
      undefined,
      undefined,
      { lineageDemand: [unionId] }
    );
    const seams = joined.bodyRepresentations[unionId]!.topology!.edges.filter(
      (edge) => SEAM_PIECE.test(edge.reference?.lineageName ?? '')
    );
    expect(seams).toHaveLength(4);

    const resize = async (rounded: ProjectDocument, bodyId: BodyId) => {
      const editor = new CommandManager(rounded);
      const source = Object.values(editor.document.nodes).find(
        (node): node is FeatureNode =>
          node.kind === 'feature' && node.name === 'Cylinder'
      )!;
      if (source.data.featureKind !== 'primitive') throw new Error('primitive');
      editor.execute(
        commandFactories.updateFeature(
          {
            featureId: source.featureId,
            data: { dimensions: { ...source.data.dimensions, radius: 7 } }
          },
          'Resize Cylinder'
        )
      );
      const derived = await adapter.syncDocument(editor.document);
      return { derived, body: derived.bodyRepresentations[bodyId] };
    };

    const picked = filletEdges(manager.document, {
      name: 'Fillet',
      targetBodyId: unionId,
      edgeHashes: seams.map((edge) => edge.hash),
      edgeReferences: seams.map((edge) => edge.reference!),
      size: 2
    });
    const before = await adapter.syncDocument(picked.document);
    const roundedBefore = before.bodyRepresentations[picked.bodyId]!;
    expect(
      roundedBefore.topology!.faces.some(
        (face) => face.geometry?.surfaceType === 'bspline'
      )
    ).toBe(true);
    // Every pick now carries a name, so a diameter drag on the filleted
    // boss may cross the union to its source Cylinder.
    const wall = roundedBefore.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    expect(
      primitiveCylinderRadiusAncestor(
        picked.document,
        picked.bodyId,
        wall.reference,
        wall.hash
      )?.name
    ).toBe('Cylinder');

    const { derived: after, body: roundedAfter } = await resize(
      picked.document,
      picked.bodyId
    );
    // The only warning is the display-mesh advisory the fillet already had;
    // no "selected edge no longer exists".
    expect(after.warnings).toEqual(before.warnings);
    expect(after.warnings.join('\n')).not.toMatch(/no longer exists/);
    expect(roundedAfter?.exportableStep).toBe(true);
    expect(
      roundedAfter!.topology!.faces.some(
        (face) => face.geometry?.surfaceType === 'bspline'
      )
    ).toBe(true);
    // A wider boss adds material outside the sphere.
    expect(roundedAfter!.volume).toBeGreaterThan(roundedBefore.volume);

    // Control: the same seams picked by hash alone still break, which is
    // what the names are for.
    const hashOnly = filletEdges(manager.document, {
      name: 'Fillet',
      targetBodyId: unionId,
      edgeHashes: seams.map((edge) => edge.hash),
      size: 2
    });
    const { derived: broken } = await resize(
      hashOnly.document,
      hashOnly.bodyId
    );
    expect(broken.warnings.join('\n')).toMatch(/no longer exists/);
  }, 300_000);

  it('does not name the hemispheres of an imported STEP sphere', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Sphere', toUserId('user_sphere_patch')),
      { name: 'Ball', primitiveKind: 'sphere', dimensions: { radius: 10 } }
    );
    const step = await adapter.exportStep(document, [document.bodyOrder[0]!]);
    const imported = importStepBody(
      createProjectDocument('Imported', toUserId('user_sphere_patch')),
      {
        name: 'Ball',
        artifactId: 'artifact_sphere_patch',
        sourceName: 'ball.step',
        stepText: step
      }
    ).document;
    const derived = await adapter.syncDocument(imported);
    const body = derived.bodyRepresentations[imported.bodyOrder[0]!]!;
    const sphereFaces = body.topology!.faces.filter(
      (face) => face.geometry?.surfaceType === 'sphere'
    );
    expect(sphereFaces.length).toBeGreaterThan(0);
    // An import has no feature contract; twin witnesses publish nothing.
    if (sphereFaces.length > 1) {
      expect(sphereFaces.every((face) => face.reference === undefined)).toBe(
        true
      );
    }
    expect(
      names(body, 'faces').some((name) => name.includes('primitive.sphere'))
    ).toBe(false);
  }, 120_000);
});
