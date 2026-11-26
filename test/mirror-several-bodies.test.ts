import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  listFeaturesInOrder,
  setNodeMetadata,
  transformBody
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DerivedState,
  type ProjectDocument,
  type Vector3
} from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  IN_PLACE_TOOL_SPECS,
  type BodyPick,
  type InPlaceContext,
  type InPlaceSlots,
  type PlanePick
} from '../apps/web/src/lib/inPlace/tools';
import {
  composeMirrorSet,
  mirrorSetRefusal,
  type MirrorSetMember
} from '../apps/web/src/lib/inPlace/mirrorBodies';
import { validatedFeatureRejection } from '../apps/web/src/lib/featureValidation';
import {
  buildModelingOperationSubmission,
  type ModelingOperationFormState
} from '../apps/web/src/lib/modelingOperations';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';

/**
 * M11 slice 5c (owner decision D4): Mirror of several bodies about one plane
 * is one Mirror feature per body, committed as one transaction. Each case
 * goes through the in-place Mirror request, the same composition the
 * workspace commits, and the installed Remus pin, and checks every mirrored
 * body against its closed form: the source's volume (w·h·d) and its bounds
 * reflected in the plane, x' = 2p − x. Fixtures are invented blocks.
 */

const user = toUserId('user_m11_mirror_set');
const tolerance = (volume: number) => Math.max(0.05, 1e-6 * Math.abs(volume));

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

/** Three invented blocks, apart from one another. */
const BLOCKS = [
  { name: 'Left block', size: [10, 10, 10], at: { x: 0, y: 0, z: 0 } },
  { name: 'Right block', size: [6, 8, 4], at: { x: 20, y: 0, z: 0 } },
  { name: 'Back block', size: [4, 4, 12], at: { x: 0, y: 30, z: 0 } }
] as const;

function blocks(): { document: ProjectDocument; bodyIds: BodyId[] } {
  let document = createProjectDocument('Mirror set', user);
  const bodyIds: BodyId[] = [];
  for (const block of BLOCKS) {
    document = addPrimitiveFeature(document, {
      name: block.name,
      primitiveKind: 'box',
      dimensions: {
        width: block.size[0],
        height: block.size[1],
        depth: block.size[2]
      }
    });
    const bodyId = document.bodyOrder.at(-1)!;
    bodyIds.push(bodyId);
    if (block.at.x !== 0 || block.at.y !== 0 || block.at.z !== 0) {
      document = transformBody(document, {
        name: `Place ${block.name}`,
        targetBodyId: bodyId,
        translation: block.at
      }).document;
    }
  }
  return { document, bodyIds };
}

function solid(
  derived: DerivedState,
  id: BodyId,
  label: string
): BodyRepresentation {
  const body = derived.bodyRepresentations[id];
  expect(body, `${label}: body ${id}`).toBeDefined();
  expect(body!.exportableStep, `${label}: exact`).toBe(true);
  expect(
    isClosedConsistentlyOrientedMesh(
      inspectTriangleMeshClosure(body!.mesh.vertices, body!.mesh.indices)
    ),
    `${label}: closed`
  ).toBe(true);
  return body!;
}

const CONTEXT: InPlaceContext = {
  sketchViews: [],
  datumAxes: {},
  datumLabel: () => '',
  linearSnap: null
};

function slots(bodies: BodyPick[], plane: PlanePick): InPlaceSlots {
  return {
    profiles: [],
    axis: null,
    path: [],
    guide: [],
    faces: [],
    bodies,
    plane,
    edges: [],
    refs: [],
    image: null
  };
}

/** A plane x = p, as a flat face or a slid principal plane gives it. */
const planeX = (p: number): PlanePick => ({
  kind: 'face',
  origin: { x: p, y: 0, z: 0 },
  normal: { x: 1, y: 0, z: 0 }
});

/**
 * The in-place Mirror request for `bodies` about `plane`, composed as the
 * workspace commits it: each body through the card's submission builder and
 * the Mirror command, one transaction, each name counting on.
 */
function mirrorSet(
  document: ProjectDocument,
  derived: DerivedState,
  bodyIds: BodyId[],
  plane: PlanePick
) {
  const picks = bodyIds.map((bodyId): BodyPick => {
    const { min, max } = derived.bodyRepresentations[bodyId]!.bbox;
    return { bodyId, min, max };
  });
  const request = IN_PLACE_TOOL_SPECS.mirror.request(
    slots(picks, plane),
    { offset: 0 },
    {},
    CONTEXT
  );
  const states: ModelingOperationFormState[] =
    request?.tool === 'modeling-each'
      ? request.states
      : request?.tool === 'modeling'
        ? [request.state]
        : [];
  expect(states).toHaveLength(bodyIds.length);
  return composeMirrorSet(document, 'Mirror', bodyIds, (index, name) => {
    const state = states[index]!;
    const submission = buildModelingOperationSubmission({
      ...state,
      value: { ...state.value, name }
    } as ModelingOperationFormState);
    if (submission.operation !== 'mirror') throw new Error('not a mirror');
    return commandFactories.mirrorBody(submission.input);
  });
}

const reflectX = (box: { min: Vector3; max: Vector3 }, p: number) => ({
  min: { x: 2 * p - box.max.x, y: box.min.y, z: box.min.z },
  max: { x: 2 * p - box.min.x, y: box.max.y, z: box.max.z }
});

function expectBox(
  actual: { min: Vector3; max: Vector3 },
  expected: { min: Vector3; max: Vector3 },
  label: string
) {
  for (const end of ['min', 'max'] as const) {
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(actual[end][axis], `${label} ${end}.${axis}`).toBeCloseTo(
        expected[end][axis],
        6
      );
    }
  }
}

/** Each member's body matches its source reflected in x = p. */
function expectMirrored(
  derived: DerivedState,
  source: DerivedState,
  members: readonly MirrorSetMember[],
  p: number
) {
  for (const [index, member] of members.entries()) {
    const block = BLOCKS[index]!;
    const volume = block.size[0] * block.size[1] * block.size[2];
    const copy = solid(derived, member.resultBodyId, member.featureName);
    expect(
      Math.abs(copy.volume - volume),
      `${member.featureName}: ${copy.volume} vs ${volume}`
    ).toBeLessThanOrEqual(tolerance(volume));
    expectBox(
      copy.bbox,
      reflectX(source.bodyRepresentations[member.sourceBodyId]!.bbox, p),
      member.featureName
    );
    // The source is left as it was, live.
    const original = solid(derived, member.sourceBodyId, `${block.name} kept`);
    expect(original.consumed ?? false).toBe(false);
    expect(original.volume).toBeCloseTo(volume, 6);
  }
}

describe('M11: Mirror of several bodies, one feature each, one transaction', () => {
  it('mirrors N bodies about one plane to their closed forms, and one Undo, Redo and reload keep the ids', async () => {
    const { document, bodyIds } = blocks();
    const source = await adapter.syncDocument(document);
    const P = 40;
    const { command, members } = mirrorSet(
      document,
      source,
      bodyIds,
      planeX(P)
    );
    expect(members.map((member) => member.featureName)).toEqual([
      'Mirror',
      'Mirror 2',
      'Mirror 3'
    ]);
    expect(members.map((member) => member.sourceBodyId)).toEqual(bodyIds);

    const manager = new CommandManager(document);
    manager.execute(command);
    const committed = manager.document;
    const mirrors = () =>
      listFeaturesInOrder(manager.document).filter(
        (feature) => feature.data.featureKind === 'mirror'
      );
    // One Mirror feature per body, each its own History row.
    expect(
      mirrors().map((feature) => ({
        featureId: feature.featureId,
        bodyId: feature.bodyId,
        name: feature.name,
        target: (feature.data as { targetBodyId: BodyId }).targetBodyId
      }))
    ).toEqual(
      members.map((member) => ({
        featureId: member.featureId,
        bodyId: member.resultBodyId,
        name: member.featureName,
        target: member.sourceBodyId
      }))
    );

    const derived = await adapter.syncDocument(committed);
    expect(derived.warnings).toEqual([]);
    expect(mirrorSetRefusal(members, derived, () => undefined)).toBeNull();
    expectMirrored(derived, source, members, P);

    // One Undo takes every copy back; one Redo restores them, same ids.
    manager.undo();
    expect(mirrors()).toEqual([]);
    expect(manager.document.bodyOrder).toEqual(document.bodyOrder);
    manager.redo();
    expect(mirrors().map((feature) => feature.featureId)).toEqual(
      members.map((member) => member.featureId)
    );
    expect(manager.document.bodyOrder).toEqual(committed.bodyOrder);

    // Reopened from storage: the same features build the same bodies.
    const reopened = assertStorableDocument(
      JSON.parse(JSON.stringify(manager.document))
    );
    expect(
      listFeaturesInOrder(reopened)
        .filter((feature) => feature.data.featureKind === 'mirror')
        .map((feature) => [feature.featureId, feature.bodyId])
    ).toEqual(members.map((member) => [member.featureId, member.resultBodyId]));
    expectMirrored(await adapter.syncDocument(reopened), source, members, P);
  }, 120_000);

  it('a plane on a face of one picked body mirrors every body, that body’s copy meeting it on the face', async () => {
    const { document, bodyIds } = blocks();
    const source = await adapter.syncDocument(document);
    // The Left block's +X end face, as a click on it gives the plane.
    const left = source.bodyRepresentations[bodyIds[0]!]!.bbox;
    const face = source.bodyRepresentations[bodyIds[0]!]!.topology!.faces.find(
      (candidate) =>
        candidate.geometry?.surfaceType === 'plane' &&
        (candidate.geometry.normal?.x ?? 0) > 0.999
    );
    expect(face, 'the Left block’s +X face').toBeDefined();
    const at = face!.geometry!.centroid ?? face!.geometry!.center;
    const P = at.x;
    expect(P).toBeCloseTo(left.max.x, 9);
    const picked = bodyIds.slice(0, 2);
    const { command, members } = mirrorSet(document, source, picked, planeX(P));
    const manager = new CommandManager(document);
    manager.execute(command);
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    expectMirrored(derived, source, members, P);
    // The face's own body is mirrored onto the far side of that face: the
    // copy starts where the block ends, sharing the face and nothing more.
    const copy = derived.bodyRepresentations[members[0]!.resultBodyId]!.bbox;
    expect(copy.min.x).toBeCloseTo(left.max.x, 6);
    expect(copy.max.x).toBeCloseTo(2 * left.max.x - left.min.x, 6);
  }, 120_000);

  it('one body that cannot be mirrored refuses the whole set, by its name', async () => {
    const { document: built, bodyIds } = blocks();
    const source = await adapter.syncDocument(built);
    // The Back block's own feature is switched off: there is no shape to
    // reflect, as for any body a later edit takes away.
    const back = listFeaturesInOrder(built).find(
      (feature) => feature.bodyId === bodyIds[2]
    )!;
    const document = setNodeMetadata(built, {
      nodeId: back.id,
      metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
    });
    const { command, members } = mirrorSet(
      document,
      source,
      bodyIds,
      planeX(40)
    );
    const names = Object.fromEntries(
      BLOCKS.map((block, index) => [bodyIds[index]!, block.name])
    );
    // Nothing refuses it before the rebuild: the set is judged on its build.
    command.validate(document);
    const candidate = command.apply(document);
    const derived = await adapter.syncDocument(candidate);
    expect(mirrorSetRefusal(members, derived, (bodyId) => names[bodyId])).toBe(
      'Back block cannot be mirrored: Mirror target is unavailable. Remove it from the picks, or pick another plane.'
    );
    // The others did build: only the named body holds the set.
    expect(
      mirrorSetRefusal(members.slice(0, 2), derived, (id) => names[id])
    ).toBeNull();
    // Done's commit gate judges every body's Mirror as a target of its own,
    // so the transaction is refused whole: no partial set lands.
    const rejected = members.map((member) =>
      validatedFeatureRejection({
        featureName: member.featureName,
        featureId: member.featureId,
        warnings: derived.warnings,
        ...(derived.featureWarnings
          ? { featureWarnings: derived.featureWarnings }
          : {}),
        bodyPresent: Boolean(derived.bodyRepresentations[member.resultBodyId]),
        documentMoved: false
      })
    );
    expect(rejected.map((rejection) => rejection !== null)).toEqual([
      false,
      false,
      true
    ]);
  }, 120_000);
});
