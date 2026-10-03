import type {
  BodyId,
  BodyRepresentation,
  FaceTopology,
  FeatureId,
  FeatureNode,
  ProjectDocument
} from '@openzcad/shared';
import { faceLabel } from './topologyLabels';

/**
 * Face names that say which feature made the face: "Box 2 · top",
 * "Base plate · front", "Hole · through hole Ø6".
 *
 * "Top face (1)" and "Top face (2)" on a union of two boxes told the user
 * nothing about which box each top belonged to. The face's ADR-011 lineage
 * already records it — the feature that published the reference, and in the
 * lineage name the operand slot a boolean took it from — so the name is
 * derived here, at display time, and nothing is stored. A face without a
 * current reference keeps the direction name the viewport gives it.
 */

/** A boolean feature's face taken from its n-th operand body. */
const OPERAND = /^boolean\.face\.operand\.(\d+)\.(.+)$/;
/** An add/cut extrude's face kept from the body it joined or cut. */
const TARGET = /^boolean\.face\.target\.(.+)$/;
/** An add/cut extrude's face from its own tool solid. */
const TOOL = /^boolean\.face\.tool\.(.+)$/;
/** A fillet's or chamfer's copy of its source box or cylinder's face. */
const CARRIED = /^modifier\.(box|cylinder)\.face\.(?!blend)(.+)$/;

const DIRECTION = /^(Top|Bottom|Front|Back|Left|Right) face$/;

/** Roles in the order a face list shows them; anything else follows. */
const ROLE_ORDER = ['top', 'bottom', 'front', 'back', 'left', 'right'];

/** Features that start a body of their own rather than reshape one. */
function startsBody(feature: FeatureNode): boolean {
  switch (feature.data.featureKind) {
    case 'primitive':
    case 'revolve':
    case 'loft':
    case 'sweep':
    case 'helical-sweep':
    case 'imported-step':
    case 'imported-mesh':
      return true;
    case 'extrude':
      return (
        feature.data.targetBodyId === undefined ||
        feature.data.operation === 'new-body'
      );
    default:
      return false;
  }
}

function edgeModifierTarget(feature: FeatureNode): BodyId | undefined {
  return feature.data.featureKind === 'fillet' ||
    feature.data.featureKind === 'chamfer'
    ? feature.data.targetBodyId
    : undefined;
}

interface FeatureIndex {
  byFeatureId: Map<FeatureId, FeatureNode>;
  byBodyId: Map<BodyId, FeatureNode>;
  /** The stored name of the body each feature made, keyed by its BodyId. */
  bodyNames: Map<BodyId, { featureId: FeatureId; name: string }>;
  /** Each feature's position in history. */
  order: Map<FeatureId, number>;
}

function indexFeatures(document: ProjectDocument): FeatureIndex {
  const byFeatureId = new Map<FeatureId, FeatureNode>();
  const byBodyId = new Map<BodyId, FeatureNode>();
  const bodyNames = new Map<BodyId, { featureId: FeatureId; name: string }>();
  for (const node of Object.values(document.nodes)) {
    if (node.kind === 'feature') {
      byFeatureId.set(node.featureId, node);
      if (node.bodyId) byBodyId.set(node.bodyId, node);
    } else if (node.kind === 'body') {
      bodyNames.set(node.bodyId, {
        featureId: node.featureId,
        name: node.name
      });
    }
  }
  const order = new Map(
    document.featureOrder.map((featureId, position) => [featureId, position])
  );
  return { byFeatureId, byBodyId, bodyNames, order };
}

/**
 * The feature that made a face, following its lineage back through the
 * features that only carried it: a boolean's operand slot, an add/cut
 * extrude's target, a fillet's or chamfer's copy of a box or cylinder face.
 * Null when the reference names a feature the document does not have.
 */
export function faceProducingFeature(
  document: ProjectDocument,
  face: Pick<FaceTopology, 'hash' | 'reference'>,
  index: FeatureIndex = indexFeatures(document)
): FeatureNode | null {
  const reference = face.reference;
  if (!reference || reference.currentHash !== face.hash) return null;
  let feature = index.byFeatureId.get(reference.producingFeatureId);
  let name = reference.lineageName;
  // Bounded: a lineage name only gets shorter, but a malformed document
  // should not be able to spin here.
  for (let step = 0; feature && step < 64; step += 1) {
    const data = feature.data;
    const operand = OPERAND.exec(name);
    if (operand && data.featureKind === 'boolean') {
      const bodyId = data.targetBodyIds[Number(operand[1])];
      feature = bodyId ? index.byBodyId.get(bodyId) : undefined;
      name = operand[2]!;
      continue;
    }
    const target = TARGET.exec(name);
    if (target && data.featureKind === 'extrude' && data.targetBodyId) {
      feature = index.byBodyId.get(data.targetBodyId);
      name = target[1]!;
      continue;
    }
    const tool = TOOL.exec(name);
    if (tool) {
      name = tool[1]!;
      continue;
    }
    const modifierTarget = edgeModifierTarget(feature);
    const carried = CARRIED.exec(name);
    if (modifierTarget && (carried || name.startsWith('primitive.'))) {
      feature = index.byBodyId.get(modifierTarget);
      if (carried) name = `primitive.${carried[1]}.face.${carried[2]}`;
      continue;
    }
    return feature;
  }
  return null;
}

/**
 * What a feature is called in a face name. A feature that started a body is
 * named by that body ("Box 2"), because two features are both called "Box"
 * in history; one that reshapes a body (a hole, a fillet, a boss) by its own
 * name. A body still carrying the old "<feature> Body" name reads as its
 * feature, so an existing document says "Box · top", not "Box Body · top".
 */
export function featureFaceOwnerName(
  document: ProjectDocument,
  feature: FeatureNode,
  index: FeatureIndex = indexFeatures(document)
): string {
  if (!startsBody(feature) || !feature.bodyId) return feature.name;
  const body = index.bodyNames.get(feature.bodyId);
  if (
    !body ||
    body.featureId !== feature.featureId ||
    body.name === `${feature.name} Body`
  ) {
    return feature.name;
  }
  return body.name;
}

/** "top" for an axis-aligned plane, otherwise the viewport's own face name. */
function faceRole(body: BodyRepresentation, face: FaceTopology): string {
  const label = faceLabel(body, face.hash, face.topologyId);
  const direction = DIRECTION.exec(label);
  if (direction) return direction[1]!.toLowerCase();
  return `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

export interface ProducedFaceName {
  /** "Box 2 · top". */
  name: string;
  /** "Box 2". */
  owner: string;
  /** "top", "through hole Ø6". */
  role: string;
  /** Position of the producing feature in history, for a stable list order. */
  featureIndex: number;
  /** Where the role sorts in a face list: the six box directions first. */
  roleRank: number;
}

/** Names a body's faces, as {@link producedFaceNames} does for a document. */
export type FaceNamer = (
  body: BodyRepresentation,
  faces: readonly FaceTopology[]
) => (ProducedFaceName | null)[];

/**
 * The namer a face list uses for one document. The app renders the list on
 * every frame of a drag, so the document is indexed once and each body's
 * names are kept until its topology changes.
 */
export function faceNamerFor(document: ProjectDocument): FaceNamer {
  let index: FeatureIndex | null = null;
  const named = new WeakMap<
    readonly FaceTopology[],
    (ProducedFaceName | null)[]
  >();
  return (body, faces) => {
    const cached = named.get(faces);
    if (cached) return cached;
    index ??= indexFeatures(document);
    const names = nameFaces(document, body, faces, index);
    named.set(faces, names);
    return names;
  };
}

/**
 * Names faces of one body after the features that made them. One index of
 * the document serves the whole list; a face without a usable reference maps
 * to null, and the caller keeps its own name for it.
 */
export function producedFaceNames(
  document: ProjectDocument,
  body: BodyRepresentation,
  faces: readonly FaceTopology[]
): (ProducedFaceName | null)[] {
  return nameFaces(document, body, faces, indexFeatures(document));
}

function nameFaces(
  document: ProjectDocument,
  body: BodyRepresentation,
  faces: readonly FaceTopology[],
  index: FeatureIndex
): (ProducedFaceName | null)[] {
  return faces.map((face) => {
    const feature = faceProducingFeature(document, face, index);
    if (!feature) return null;
    const owner = featureFaceOwnerName(document, feature, index);
    const role = faceRole(body, face);
    return {
      name: `${owner} · ${role}`,
      owner,
      role,
      featureIndex: index.order.get(feature.featureId) ?? index.order.size,
      roleRank: faceRoleRank(role)
    };
  });
}

/** One face's feature name, or null when its lineage cannot say. */
export function producedFaceName(
  document: ProjectDocument,
  body: BodyRepresentation,
  face: FaceTopology
): string | null {
  return producedFaceNames(document, body, [face])[0]?.name ?? null;
}

/** Rank of a role in a face list: the six box directions first. */
function faceRoleRank(role: string): number {
  const rank = ROLE_ORDER.indexOf(role);
  return rank < 0 ? ROLE_ORDER.length : rank;
}
