import type {
  BodyId,
  BodyRepresentation,
  FaceTopologyReferenceV5,
  FeatureId,
  FeatureNode,
  ProjectDocument,
  TopologySelection
} from '@openzcad/shared';
import { listFeaturesInOrder } from '@openzcad/document-core';
import { featureHistory, featureResultBodyIds } from './featureHistory';

/**
 * What the viewport shows for a feature picked in History.
 *
 * A feature whose own body is still on screen selects that body. A feature
 * a later one consumed (a Boss unioned into the bracket) used to select
 * every body downstream of it, so the whole part lit up and the callout
 * named the part rather than the feature. Now the faces that came from the
 * feature light up instead, traced back through the lineage every face
 * carries (see {@link faceLineageTrace}), and when none survived (a later
 * cut took them all) the consumed body is drawn as a ghost where it was.
 * Only when neither exists does the old downstream selection remain, so a
 * row never selects nothing.
 */
export type HistoryFeatureFocus =
  | { kind: 'bodies'; bodyIds: BodyId[] }
  | {
      kind: 'focus';
      faces: TopologySelection[];
      ghostBodyIds: BodyId[];
    };

export function historyFeatureFocus(
  document: ProjectDocument,
  feature: FeatureNode,
  isVisible: (bodyId: BodyId) => boolean
): HistoryFeatureFocus {
  const representations = document.derived.bodyRepresentations;
  const own = featureResultBodyIds(feature);
  const direct = own.filter(isVisible);
  if (direct.length > 0) {
    return { kind: 'bodies', bodyIds: direct };
  }
  const descendants = [
    ...new Set(
      featureHistory(document)
        .downstream(feature.featureId)
        .flatMap(featureResultBodyIds)
        .filter(isVisible)
    )
  ];
  const trace = lineageTracer(document);
  const faces = descendants.flatMap((bodyId) =>
    (representations[bodyId]?.topology?.faces ?? [])
      .filter((face) => {
        const path = face.reference ? trace(face.reference) : null;
        return (
          path !== null &&
          (path.origin === feature.featureId ||
            own.some((ownBody) => path.bodies.includes(ownBody)))
        );
      })
      .map((face): TopologySelection => ({
        bodyId,
        kind: 'face',
        topologyId: face.topologyId,
        hash: face.hash,
        ...(face.reference ? { reference: face.reference } : {})
      }))
  );
  if (faces.length > 0) {
    return { kind: 'focus', faces, ghostBodyIds: [] };
  }
  const ghostBodyIds = own.filter((bodyId) => {
    const body = representations[bodyId];
    return Boolean(body?.consumed && body.mesh.indices.length > 0);
  });
  if (ghostBodyIds.length > 0) {
    return { kind: 'focus', faces: [], ghostBodyIds };
  }
  return { kind: 'bodies', bodyIds: descendants };
}

/** The consumed bodies a focus draws as ghosts, resolved for the viewer. */
export function ghostBodiesFor(
  document: ProjectDocument,
  focus: HistoryFeatureFocus | null
): BodyRepresentation[] {
  if (!focus || focus.kind !== 'focus') {
    return [];
  }
  return focus.ghostBodyIds.flatMap((bodyId) => {
    const body = document.derived.bodyRepresentations[bodyId];
    return body ? [body] : [];
  });
}

/** Where a face came from, read back through its lineage name. */
export interface FaceLineageTrace {
  /** The feature that made the face's surface, when the name says. */
  origin: FeatureId | null;
  /** Every body the face passed through on its way to the final part. */
  bodies: BodyId[];
}

const BOOLEAN_SLOT =
  /^boolean\.face\.(?:operand\.(\d+)|(target)|(tool))\.(.+)$/;

/** Feature kinds whose own construction a lineage head names. */
const HEAD_KINDS: Partial<Record<string, readonly string[]>> = {
  primitive: ['primitive'],
  sweep: ['extrude', 'revolve', 'sweep', 'loft', 'helical-sweep']
};

function inputBodyOf(feature: FeatureNode): BodyId | undefined {
  return (feature.data as { targetBodyId?: BodyId }).targetBodyId;
}

/**
 * Reads a face's lineage back to the feature that made it.
 *
 * `producingFeatureId` names the LAST feature that republished the face — on
 * a finished part usually its final boolean — and the lineage name records
 * the path from there: `boolean.face.operand.1.primitive.cylinder.face.wall`
 * is "operand 1 of this boolean, which was a primitive cylinder's wall".
 * Each boolean slot names an input body (an operand in `targetBodyIds`
 * order; an add/cut extrude's `target` body, or its own swept `tool`), and
 * the creator of that body decodes the rest. A feature that carries faces
 * through unchanged (a fillet leaving a face alone) is passed through to its
 * input body. An unknown head stops at the feature reached.
 */
export function faceLineageTrace(
  document: ProjectDocument,
  reference: FaceTopologyReferenceV5
): FaceLineageTrace | null {
  return lineageTracer(document)(reference);
}

function lineageTracer(document: ProjectDocument) {
  const features = listFeaturesInOrder(document);
  const byId = new Map(
    features.map((feature) => [feature.featureId, feature] as const)
  );
  const creators = new Map<BodyId, FeatureNode>();
  for (const feature of features) {
    if (feature.bodyId) creators.set(feature.bodyId, feature);
    if (feature.data.featureKind === 'split') {
      creators.set(feature.data.secondBodyId, feature);
    }
  }
  return (reference: FaceTopologyReferenceV5): FaceLineageTrace | null => {
    let current = byId.get(reference.producingFeatureId);
    if (!current) return null;
    let rest = reference.lineageName;
    const bodies: BodyId[] = [];
    const enter = (bodyId: BodyId | undefined) => {
      if (!bodyId || bodies.includes(bodyId)) return undefined;
      bodies.push(bodyId);
      return creators.get(bodyId);
    };
    for (let depth = 0; depth < 64 && current; depth += 1) {
      const kind: string = current.data.featureKind;
      const slot = BOOLEAN_SLOT.exec(rest);
      if (slot) {
        const [, operand, target, tool, tail] = slot;
        const data = current.data as {
          targetBodyIds?: readonly BodyId[];
          targetBodyId?: BodyId;
        };
        if (tool && kind === 'extrude') {
          // An add/cut extrude's own sweep: its faces are the extrude's.
          return { origin: current.featureId, bodies };
        }
        const next =
          operand !== undefined && kind === 'boolean'
            ? data.targetBodyIds?.[Number(operand)]
            : target && kind === 'extrude'
              ? data.targetBodyId
              : undefined;
        if (next === undefined) {
          // Not the boolean that named the slot: a feature that carried the
          // name through unchanged. Look behind it.
          current = enter(inputBodyOf(current));
          continue;
        }
        rest = tail!;
        current = enter(next);
        continue;
      }
      const head = rest.split('.', 1)[0] ?? '';
      const owners = HEAD_KINDS[head];
      if (!owners || owners.includes(kind)) {
        return { origin: current.featureId, bodies };
      }
      current = enter(inputBodyOf(current));
    }
    return { origin: null, bodies };
  };
}
