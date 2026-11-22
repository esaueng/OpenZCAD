/**
 * Authored fixtures for the direct-edit failure classes already known.
 *
 * These are not captures. Each one builds a native document from
 * `@openzcad/document-core`, syncs once to read real topology, and records the
 * pick the way the app would — so a scenario stays valid as the kernel moves,
 * and a scenario that starts passing shows up as a repaired pin rather than as
 * a quietly stale file.
 */

import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  directEditBody,
  filletEdges,
  chamferEdges,
  listFeaturesInOrder,
  setParameter,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import type {
  BodyId,
  BodyRepresentation,
  DerivedState,
  FaceTopology,
  ParamValue,
  ProjectDocument
} from '@openzcad/shared';

import { directEditRejection } from '../../apps/web/src/lib/directEdit';
import { offsetFacesName } from '../../apps/web/src/lib/faceSetOffset';
import { buildRefusalReproduction } from '../../apps/web/src/lib/refusalReproduction';
import {
  DIRECT_EDIT_FIXTURE_FORMAT,
  DIRECT_EDIT_FIXTURE_FORMAT_VERSION
} from '../../apps/web/src/lib/directEditFixture';
import type {
  DirectEditFixture,
  DirectEditFixtureEdit,
  DirectEditFixtureObservation
} from '../../apps/web/src/lib/directEditFixture';
import { replayFixture } from './replay';
import { faceSelector } from './resolve';

const USER = toUserId('user_direct_edit_corpus');

/** Authored fixtures are not captured at a moment; this is the authoring date. */
const AUTHORED_AT = '2026-09-01T00:00:00.000Z';

const OFFSET_FEATURE_NAME = 'Offset face';

function kernelInfo(adapter: ExactKernelAdapter): DirectEditFixture['kernel'] {
  const exposed = adapter as unknown as {
    packageVersion?: unknown;
    sourceCommit?: unknown;
  };
  return {
    adapter: 'remus',
    packageVersion:
      typeof exposed.packageVersion === 'string'
        ? exposed.packageVersion
        : 'test',
    sourceCommit:
      typeof exposed.sourceCommit === 'string' ? exposed.sourceCommit : 'test'
  };
}

function requireBody(
  derived: DerivedState,
  bodyId: BodyId,
  scenario: string
): BodyRepresentation {
  const body = derived.bodyRepresentations[bodyId];
  if (!body) {
    throw new Error(
      `${scenario}: the rebuild produced no body ${bodyId}. ` +
        `Warnings: ${JSON.stringify(derived.warnings)}`
    );
  }
  return body;
}

/** The planar face whose outward normal is +z and whose centre sits highest. */
function topPlanarFace(body: BodyRepresentation): FaceTopology {
  return capFace(body, 1);
}

function bottomPlanarFace(body: BodyRepresentation): FaceTopology {
  return capFace(body, -1);
}

function capFace(body: BodyRepresentation, sign: 1 | -1): FaceTopology {
  const candidates = (body.topology?.faces ?? []).filter(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      face.geometry.normal !== undefined &&
      Math.abs(face.geometry.normal.z - sign) < 1e-9
  );
  const chosen = candidates.reduce<FaceTopology | null>((best, face) => {
    if (!best) {
      return face;
    }
    const z = face.geometry?.center.z ?? 0;
    const bestZ = best.geometry?.center.z ?? 0;
    return sign === 1 ? (z > bestZ ? face : best) : z < bestZ ? face : best;
  }, null);
  if (!chosen) {
    throw new Error(
      `The body "${body.name}" exposes no planar face with a ${sign > 0 ? '+' : '-'}z normal.`
    );
  }
  return chosen;
}

function selectableEdges(body: BodyRepresentation) {
  return (body.topology?.edges ?? []).filter(
    (edge) => edge.displayRole !== 'seam'
  );
}

function observation(
  document: ProjectDocument,
  body: BodyRepresentation,
  face: FaceTopology,
  outcome: DirectEditFixtureObservation['outcome'],
  message?: string
): DirectEditFixtureObservation {
  return {
    outcome,
    ...(message === undefined ? {} : { message }),
    lineage: face.reference ? 'semantic' : 'hash-only',
    producingFeatureKind: body.source,
    upstreamFeatureKinds: listFeaturesInOrder(document).map(
      (feature) => feature.featureKind
    ),
    documentVersion: document.version
  };
}

function fixture(
  adapter: ExactKernelAdapter,
  name: string,
  document: ProjectDocument,
  body: BodyRepresentation,
  face: FaceTopology,
  edit: DirectEditFixtureEdit,
  outcome: DirectEditFixtureObservation['outcome'],
  message?: string
): DirectEditFixture {
  return {
    format: DIRECT_EDIT_FIXTURE_FORMAT,
    formatVersion: DIRECT_EDIT_FIXTURE_FORMAT_VERSION,
    name,
    capturedAt: AUTHORED_AT,
    origin: 'authored',
    kernel: kernelInfo(adapter),
    document,
    edit,
    observed: observation(document, body, face, outcome, message)
  };
}

/**
 * The dimension a +z face offset drives.
 *
 * The kernel lays a box's width on x, height on y and DEPTH on z, so the face
 * a user drags upward is governed by `depth` — not by the dimension called
 * "height". The oracle rebuilds with `depth + offset`, so getting this axis
 * wrong would compare against the wrong part entirely.
 */
const PLATE_DEPTH = 24;
const PLATE_WIDTH = 40;
const CYLINDER_HEIGHT = 30;
const BLOCK_DEPTH = 20;
const BLEND_SIZE = 1.5;

/** Box 40 x 24 x 10; `depth` is the z extent the top face rides on. */
function plateDocument(depth = PLATE_DEPTH): {
  document: ProjectDocument;
  bodyId: BodyId;
} {
  const document = addPrimitiveFeature(
    createProjectDocument('Direct edit corpus', USER),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: PLATE_WIDTH, depth, height: 10 }
    }
  );
  const bodyId = document.bodyOrder[0];
  if (!bodyId) {
    throw new Error('The plate primitive produced no body.');
  }
  return { document, bodyId };
}

function cylinderDocument(height = CYLINDER_HEIGHT): {
  document: ProjectDocument;
  bodyId: BodyId;
} {
  const document = addPrimitiveFeature(
    createProjectDocument('Direct edit corpus', USER),
    {
      name: 'Post',
      primitiveKind: 'cylinder',
      dimensions: { radius: 10, height }
    }
  );
  const bodyId = document.bodyOrder[0];
  if (!bodyId) {
    throw new Error('The cylinder primitive produced no body.');
  }
  return { document, bodyId };
}

/**
 * Box A overlapped by box B, unioned. B sits at x 10..30, y 0..10, z 20..40,
 * so the union's highest +z face is B's cap and the overlap slab is 800 mm3.
 */
function unionDocument(
  plateWidth = PLATE_WIDTH,
  blockDepth = BLOCK_DEPTH
): {
  document: ProjectDocument;
  bodyId: BodyId;
  plateFeatureName: string;
} {
  const base = addPrimitiveFeature(
    createProjectDocument('Direct edit corpus', USER),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: plateWidth, depth: PLATE_DEPTH, height: 10 }
    }
  );
  const plateBodyId = base.bodyOrder[0];
  const withBlock = addPrimitiveFeature(base, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20, depth: blockDepth, height: 20 }
  });
  const blockBodyId = withBlock.bodyOrder[1];
  if (!plateBodyId || !blockBodyId) {
    throw new Error('The union scenario produced fewer bodies than expected.');
  }
  const placed = transformBody(withBlock, {
    name: 'Place block',
    targetBodyId: blockBodyId,
    translation: { x: 10, y: 0, z: 20 }
  });
  const united = booleanBodies(placed.document, {
    name: 'Union',
    operation: 'union',
    targetBodyIds: [plateBodyId, blockBodyId]
  });
  return {
    document: united.document,
    bodyId: united.bodyId,
    plateFeatureName: 'Plate'
  };
}

/**
 * A plate of the given depth with EVERY non-seam edge blended at 1.5 mm. The
 * oracle rebuilds through exactly this path, so the comparison is against the
 * part a user would have modelled, not against closed-form arithmetic.
 */
async function blendedPlate(
  adapter: ExactKernelAdapter,
  kind: 'fillet' | 'chamfer',
  depth: number,
  scenario: string
): Promise<{
  document: ProjectDocument;
  bodyId: BodyId;
  body: BodyRepresentation;
}> {
  const { document, bodyId } = plateDocument(depth);
  const base = await adapter.syncDocument(document);
  const edges = selectableEdges(requireBody(base, bodyId, scenario));
  const modify = kind === 'fillet' ? filletEdges : chamferEdges;
  const modified = modify(document, {
    name: kind === 'fillet' ? 'Blend all edges' : 'Break all edges',
    targetBodyId: bodyId,
    edgeHashes: edges.map((edge) => edge.hash),
    edgeReferences: edges.flatMap((edge) =>
      edge.reference ? [edge.reference] : []
    ),
    size: BLEND_SIZE
  });
  const derived = await adapter.syncDocument(modified.document);
  return {
    document: modified.document,
    bodyId: modified.bodyId,
    body: requireBody(derived, modified.bodyId, scenario)
  };
}

async function filletedPlateFixture(
  adapter: ExactKernelAdapter,
  name: string,
  kind: 'fillet' | 'chamfer',
  offset: number,
  outcome: DirectEditFixtureObservation['outcome'],
  message?: string
): Promise<DirectEditFixture> {
  const { document, bodyId, body } = await blendedPlate(
    adapter,
    kind,
    PLATE_DEPTH,
    name
  );
  const face = topPlanarFace(body);
  return fixture(
    adapter,
    name,
    document,
    body,
    face,
    {
      op: 'offset-face',
      targetBodyId: bodyId,
      face: faceSelector(face),
      value: offset
    },
    outcome,
    message
  );
}

/** The same blended plate rebuilt with its driving depth moved by `offset`. */
async function blendedPlateOracle(
  adapter: ExactKernelAdapter,
  kind: 'fillet' | 'chamfer',
  offset: number,
  scenario: string
): Promise<number> {
  const { body } = await blendedPlate(
    adapter,
    kind,
    PLATE_DEPTH + offset,
    `${scenario} oracle`
  );
  return body.volume;
}

async function capOffsetFixture(
  adapter: ExactKernelAdapter,
  name: string,
  end: 'top' | 'bottom',
  outcome: DirectEditFixtureObservation['outcome'],
  message?: string
): Promise<DirectEditFixture> {
  const { document, bodyId } = cylinderDocument();
  const derived = await adapter.syncDocument(document);
  const body = requireBody(derived, bodyId, name);
  const face = end === 'top' ? topPlanarFace(body) : bottomPlanarFace(body);
  // Either cap shortens the post by the same 5 mm, so both share one oracle.
  return fixture(
    adapter,
    name,
    document,
    body,
    face,
    {
      op: 'offset-face',
      targetBodyId: bodyId,
      face: faceSelector(face),
      value: -5
    },
    outcome,
    message
  );
}

async function shortenedPostVolume(
  adapter: ExactKernelAdapter,
  scenario: string
): Promise<number> {
  const { document, bodyId } = cylinderDocument(CYLINDER_HEIGHT - 5);
  const derived = await adapter.syncDocument(document);
  return requireBody(derived, bodyId, `${scenario} oracle`).volume;
}

/** The faces of an `offset-faces` set, in the edit's order. */
function offsetFacesEdit(
  bodyId: BodyId,
  faces: readonly FaceTopology[],
  offset: number
): DirectEditFixtureEdit {
  const [first, ...rest] = faces.map((face) => faceSelector(face));
  return {
    op: 'offset-faces',
    targetBodyId: bodyId,
    face: first!,
    additionalFaces: rest,
    value: offset
  };
}

/** A face-set fixture: semantic only when every face in it carries a reference. */
function offsetFacesFixture(
  adapter: ExactKernelAdapter,
  name: string,
  document: ProjectDocument,
  bodyId: BodyId,
  body: BodyRepresentation,
  faces: readonly FaceTopology[],
  offset: number,
  outcome: DirectEditFixtureObservation['outcome']
): DirectEditFixture {
  const built = fixture(
    adapter,
    name,
    document,
    body,
    faces[0]!,
    offsetFacesEdit(bodyId, faces, offset),
    outcome
  );
  built.observed.lineage = faces.every((face) => face.reference)
    ? 'semantic'
    : 'hash-only';
  return built;
}

/**
 * The plate's top and bottom: parallel, but facing opposite ways, so the
 * kernel refuses to offset them together by one signed distance.
 */
async function opposedCapsOfPlate(
  adapter: ExactKernelAdapter,
  scenario: string
) {
  const { document, bodyId } = plateDocument();
  const derived = await adapter.syncDocument(document);
  const body = requireBody(derived, bodyId, scenario);
  return {
    document,
    bodyId,
    body,
    faces: [topPlanarFace(body), bottomPlanarFace(body)]
  };
}

/**
 * The union's two plate-top faces either side of the block: coplanar, both
 * +z, at the plate's depth — the set the workspace's Offset takes.
 */
function plateTopsOfUnion(body: BodyRepresentation): FaceTopology[] {
  const tops = (body.topology?.faces ?? []).filter(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      face.geometry.normal !== undefined &&
      Math.abs(face.geometry.normal.z - 1) < 1e-9 &&
      Math.abs(face.geometry.center.z - PLATE_DEPTH) < 1e-6
  );
  if (tops.length !== 2) {
    throw new Error(
      `The union "${body.name}" exposes ${tops.length} plate-top faces, not 2.`
    );
  }
  return tops.sort(
    (a, b) => (a.geometry?.center.x ?? 0) - (b.geometry?.center.x ?? 0)
  );
}

/** The opposed caps committed to history as one `offset-faces` feature. */
function opposedCapsFeature(
  document: ProjectDocument,
  bodyId: BodyId,
  faces: readonly FaceTopology[],
  offset: ParamValue
): ProjectDocument {
  const [first, ...rest] = faces.map((face) => {
    const geometry = face.geometry!;
    return {
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      sourceSurfaceType: 'plane' as const,
      sourceArea: geometry.area,
      sourceCenter: geometry.center,
      sourceNormal: geometry.normal!
    };
  });
  return directEditBody(document, {
    name: offsetFacesName(faces.length),
    targetBodyId: bodyId,
    operation: {
      kind: 'offset-faces',
      ...first!,
      offset,
      additionalFaces: rest
    }
  }).document;
}

/**
 * "Save reproduction" of the opposed caps refused as one `offset-faces`
 * feature: the file carries that feature in its document and records every
 * face of the set with the distance; replay is the rebuild of that feature.
 */
async function opposedCapsReproduction(
  adapter: ExactKernelAdapter,
  name: string,
  offset: ParamValue
): Promise<DirectEditFixture> {
  const plate = await opposedCapsOfPlate(adapter, name);
  const document =
    typeof offset === 'string'
      ? setParameter(plate.document, { name: offset, expression: '2' })
      : plate.document;
  const refused = opposedCapsFeature(
    document,
    plate.bodyId,
    plate.faces,
    offset
  );
  const feature = listFeaturesInOrder(refused).at(-1)!;
  const derived = await adapter.syncDocument(refused);
  const warning = derived.featureWarnings?.find(
    (entry) => entry.featureId === feature.featureId
  );
  if (!warning) {
    throw new Error(
      `${name}: the opposed caps built without a feature warning. ` +
        `Warnings: ${JSON.stringify(derived.warnings)}`
    );
  }
  const reproduction = buildRefusalReproduction({
    document: { ...refused, derived },
    warning,
    kernel: kernelInfo(adapter),
    capturedAt: AUTHORED_AT
  });
  return { ...reproduction, name, origin: 'authored' };
}

export interface AuthoredScenario {
  name: string;
  build(adapter: ExactKernelAdapter): Promise<DirectEditFixture>;
  /**
   * The volume the edited body SHOULD have: the same part rebuilt from its
   * feature history with the driving dimension moved by the offset, measured
   * through `adapter.syncDocument`.
   *
   * Never closed-form arithmetic. A hand-derived number would only restate
   * what the corpus already believes; rebuilding the part asks the kernel the
   * same question a second way, which is what makes a disagreement evidence.
   */
  expectedVolumeAfter?(adapter: ExactKernelAdapter): Promise<number>;
}

export const AUTHORED_SCENARIOS: AuthoredScenario[] = [
  {
    // Control: a planar offset on a primitive face with full v5 lineage. If
    // this refuses, nothing else in the corpus means anything.
    name: 'box-top-offset-control',
    async build(adapter) {
      const { document, bodyId } = plateDocument();
      const derived = await adapter.syncDocument(document);
      const body = requireBody(derived, bodyId, 'box-top-offset-control');
      const face = topPlanarFace(body);
      return fixture(
        adapter,
        'box-top-offset-control',
        document,
        body,
        face,
        {
          op: 'offset-face',
          targetBodyId: bodyId,
          face: faceSelector(face),
          value: 5
        },
        'committed'
      );
    },
    async expectedVolumeAfter(adapter) {
      const { document, bodyId } = plateDocument(PLATE_DEPTH + 5);
      const derived = await adapter.syncDocument(document);
      return requireBody(derived, bodyId, 'box-top-offset-control oracle')
        .volume;
    }
  },
  {
    // Blend-adjacent offset: the moved face is bordered on all four sides by
    // fillet surfaces the offset has to re-intersect.
    name: 'box-all-edges-filleted-top-offset',
    build: (adapter) =>
      filletedPlateFixture(
        adapter,
        'box-all-edges-filleted-top-offset',
        'fillet',
        5,
        'committed'
      ),
    expectedVolumeAfter: (adapter) =>
      blendedPlateOracle(
        adapter,
        'fillet',
        5,
        'box-all-edges-filleted-top-offset'
      )
  },
  {
    // Same class through the chamfer path: planar neighbours rather than
    // rolling-ball surfaces, which the offset extends differently.
    name: 'box-all-edges-chamfered-top-offset',
    build: (adapter) =>
      filletedPlateFixture(
        adapter,
        'box-all-edges-chamfered-top-offset',
        'chamfer',
        5,
        'committed'
      ),
    expectedVolumeAfter: (adapter) =>
      blendedPlateOracle(
        adapter,
        'chamfer',
        5,
        'box-all-edges-chamfered-top-offset'
      )
  },
  {
    // Inward past the blend band: the negative offset moves the cap below the
    // top of the side fillets, so the neighbours must be re-trimmed, not just
    // extended.
    name: 'box-filleted-top-offset-inward-past-blend',
    build: (adapter) =>
      filletedPlateFixture(
        adapter,
        'box-filleted-top-offset-inward-past-blend',
        'fillet',
        -3,
        'committed'
      ),
    expectedVolumeAfter: (adapter) =>
      blendedPlateOracle(
        adapter,
        'fillet',
        -3,
        'box-filleted-top-offset-inward-past-blend'
      )
  },
  {
    // Known kernel defect class: shortening a cylinder through its +z cap.
    // The app routes a primitive cylinder to a height edit; this is the raw op.
    name: 'cylinder-top-cap-negative-offset',
    build: (adapter) =>
      capOffsetFixture(
        adapter,
        'cylinder-top-cap-negative-offset',
        'top',
        'committed'
      ),
    expectedVolumeAfter: (adapter) =>
      shortenedPostVolume(adapter, 'cylinder-top-cap-negative-offset')
  },
  {
    // Sign control for the case above: the same body from the other end.
    name: 'cylinder-bottom-cap-negative-offset',
    build: (adapter) =>
      capOffsetFixture(
        adapter,
        'cylinder-bottom-cap-negative-offset',
        'bottom',
        'committed'
      ),
    expectedVolumeAfter: (adapter) =>
      shortenedPostVolume(adapter, 'cylinder-bottom-cap-negative-offset')
  },
  {
    // Lineage class: a boolean result's faces descend from two operands, so a
    // pick on the union may carry no v5 reference at all.
    name: 'union-two-boxes-offset-result-face',
    async build(adapter) {
      const name = 'union-two-boxes-offset-result-face';
      const { document, bodyId } = unionDocument();
      const derived = await adapter.syncDocument(document);
      const body = requireBody(derived, bodyId, name);
      const face = topPlanarFace(body);
      return fixture(
        adapter,
        name,
        document,
        body,
        face,
        {
          op: 'offset-face',
          targetBodyId: bodyId,
          face: faceSelector(face),
          value: 5
        },
        'committed'
      );
    },
    async expectedVolumeAfter(adapter) {
      const scenario = 'union-two-boxes-offset-result-face oracle';
      // The picked cap belongs to block B, so B's depth is what the offset drives.
      const taller = unionDocument(PLATE_WIDTH, BLOCK_DEPTH + 5);
      const derived = await adapter.syncDocument(taller.document);
      return requireBody(derived, taller.bodyId, scenario).volume;
    }
  },
  {
    // M07 control: the union's two coplanar plate tops raised together as
    // one `offset-faces` edit, the set the workspace's Offset builds.
    name: 'union-plate-tops-offset-faces',
    async build(adapter) {
      const name = 'union-plate-tops-offset-faces';
      const { document, bodyId } = unionDocument();
      const derived = await adapter.syncDocument(document);
      const body = requireBody(derived, bodyId, name);
      return offsetFacesFixture(
        adapter,
        name,
        document,
        bodyId,
        body,
        plateTopsOfUnion(body),
        2,
        'committed'
      );
    }
  },
  {
    // M07: a face set the kernel refuses, recorded as the interaction log
    // records it. It must replay as the whole set, never as its first face
    // alone, which would commit.
    name: 'plate-opposed-caps-offset-faces-refused',
    async build(adapter) {
      const name = 'plate-opposed-caps-offset-faces-refused';
      const { document, bodyId, body, faces } = await opposedCapsOfPlate(
        adapter,
        name
      );
      return offsetFacesFixture(
        adapter,
        name,
        document,
        bodyId,
        body,
        faces,
        2,
        'refused'
      );
    }
  },
  {
    // M07: the same refusal through "Save reproduction". The file carries
    // the refused `offset-faces` feature in its document and records every
    // face of the set with the distance; replay is the rebuild of that
    // feature, judged on the kernel's own refusal record.
    name: 'plate-opposed-caps-offset-faces-reproduction',
    build: (adapter) =>
      opposedCapsReproduction(
        adapter,
        'plate-opposed-caps-offset-faces-reproduction',
        2
      )
  },
  {
    // The same, with the distance a typed expression: the document keeps
    // `travel`, the header records 0, and the replay still refuses.
    name: 'plate-opposed-caps-offset-faces-expression-reproduction',
    build: (adapter) =>
      opposedCapsReproduction(
        adapter,
        'plate-opposed-caps-offset-faces-expression-reproduction',
        'travel'
      )
  }
];

export interface ReplayCheckResult {
  /** Refusal on the pre-existing direct edit after the upstream change. */
  rejection: string | null;
  volume: number;
  expectedVolume: number;
  warnings: string[];
}

export interface AuthoredReplayCheck {
  name: string;
  /** The failure class this check probes. */
  description: string;
  run(adapter: ExactKernelAdapter): Promise<ReplayCheckResult>;
}

/**
 * Scenarios whose question is not "does this edit commit" but "does an edit
 * that already committed still contribute after something upstream moves".
 * A refusal here is a lineage failure, not an operation failure, so it is
 * measured separately from the replay corpus.
 */
export const AUTHORED_REPLAY_CHECKS: AuthoredReplayCheck[] = [
  {
    name: 'union-plate-tops-offset-faces-rounded-distance',
    description:
      'A face set replayed from the log moves by the distance the app built, ' +
      'rounded to 0.001 mm, not by the raw value recorded.',
    async run(adapter) {
      const scenario = 'union-plate-tops-offset-faces-rounded-distance';
      const { document, bodyId } = unionDocument();
      const derived = await adapter.syncDocument(document);
      const body = requireBody(derived, bodyId, scenario);
      const tops = plateTopsOfUnion(body);
      const result = await replayFixture(
        adapter,
        offsetFacesFixture(
          adapter,
          scenario,
          document,
          bodyId,
          body,
          tops,
          1.2344,
          'committed'
        )
      );
      const area = tops.reduce(
        (sum, face) => sum + (face.geometry?.area ?? 0),
        0
      );
      return {
        rejection: result.outcome === 'refused' ? (result.message ?? '') : null,
        volume: result.volumeAfter ?? Number.NaN,
        expectedVolume: body.volume + 1.234 * area,
        warnings: result.warnings
      };
    }
  },
  {
    name: 'union-offset-then-upstream-width-change',
    description:
      'An offset on a boolean result face, after the first operand is widened.',
    async run(adapter) {
      const scenario = 'union-offset-then-upstream-width-change';
      const { document, bodyId, plateFeatureName } = unionDocument();
      const derived = await adapter.syncDocument(document);
      const body = requireBody(derived, bodyId, scenario);
      const face = topPlanarFace(body);
      const geometry = face.geometry;
      if (!geometry?.normal) {
        throw new Error(
          `${scenario}: the union's cap face has no exact normal.`
        );
      }

      const edited = directEditBody(document, {
        name: OFFSET_FEATURE_NAME,
        targetBodyId: bodyId,
        operation: {
          kind: 'offset-face',
          faceHash: face.hash,
          ...(face.reference ? { faceReference: face.reference } : {}),
          sourceSurfaceType: 'plane',
          sourceArea: geometry.area,
          sourceCenter: geometry.center,
          sourceNormal: geometry.normal,
          offset: 5
        }
      }).document;

      // The edit has to build before the upstream change, or the check below
      // would be measuring the wrong failure.
      const built = await adapter.syncDocument(edited);
      const builtBody = requireBody(built, bodyId, scenario);
      if (
        Math.abs(builtBody.volume - (body.volume + 5 * geometry.area)) > 1e-6
      ) {
        throw new Error(
          `${scenario}: the offset did not contribute before the upstream edit ` +
            `(${builtBody.volume} vs ${body.volume + 5 * geometry.area}).`
        );
      }

      const plate = listFeaturesInOrder(edited).find(
        (feature) => feature.name === plateFeatureName
      );
      if (!plate) {
        throw new Error(`${scenario}: the plate primitive is missing.`);
      }
      const widened = updateFeature(edited, {
        featureId: plate.featureId,
        data: { dimensions: { width: 50 } }
      });
      const after = await adapter.syncDocument(widened);

      // The same widened union WITHOUT the edit, measured rather than derived,
      // so the expectation cannot drift with the boolean's own arithmetic.
      const reference = unionDocument(50);
      const referenceDerived = await adapter.syncDocument(reference.document);
      const referenceBody = requireBody(
        referenceDerived,
        reference.bodyId,
        scenario
      );

      const resultBody = after.bodyRepresentations[bodyId];
      return {
        rejection: directEditRejection({
          label: OFFSET_FEATURE_NAME,
          warnings: after.warnings,
          featureWarnings: after.featureWarnings,
          bodyPresent: resultBody !== undefined,
          documentMoved: false
        }),
        volume: resultBody?.volume ?? Number.NaN,
        expectedVolume: referenceBody.volume + 5 * geometry.area,
        warnings: after.warnings
      };
    }
  }
];
