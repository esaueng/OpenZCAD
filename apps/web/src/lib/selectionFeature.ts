import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type BodyId,
  type BodyRepresentation,
  type FeatureNode,
  type ProjectDocument,
  type TopologySelection
} from '@openzcad/shared';
import { editableFilletFeature } from './interaction/filletFaceEdit';
import {
  primitiveBoxFaceAncestor,
  primitiveCylinderCapAncestor,
  primitiveCylinderRadiusAncestor
} from './interaction/cylinderPrimitiveAncestry';

export function bodyFeature(
  document: ProjectDocument,
  bodyId: BodyId
): FeatureNode | null {
  return (
    listFeaturesInOrder(document)
      .reverse()
      .find(
        (feature) =>
          !isFeatureSuppressed(feature) &&
          (feature.bodyId === bodyId ||
            ((feature.data.featureKind === 'transform' ||
              feature.data.featureKind === 'direct-edit') &&
              feature.data.targetBodyId === bodyId))
      ) ?? null
  );
}

export function resolveSelectionTopology(
  body: BodyRepresentation | undefined,
  selection: TopologySelection
): TopologySelection | null {
  if (!body || body.bodyId !== selection.bodyId) return null;
  if (selection.kind === 'body') return selection;
  if (selection.reference && selection.reference.kind !== selection.kind)
    return null;
  const entries =
    selection.kind === 'face'
      ? (body.topology?.faces ?? [])
      : (body.topology?.edges ?? []);
  const reference = selection.reference;
  const matches = entries.filter((entry) =>
    reference
      ? entry.reference?.kind === reference.kind &&
        entry.reference.producingFeatureId === reference.producingFeatureId &&
        entry.reference.lineageName === reference.lineageName
      : selection.topologyId !== undefined
        ? entry.topologyId === selection.topologyId &&
          (selection.hash === undefined || entry.hash === selection.hash)
        : selection.hash !== undefined && entry.hash === selection.hash
  );
  if (matches.length !== 1) return null;
  const entry = matches[0]!;
  if (
    entry.reference &&
    entries.filter(
      (candidate) =>
        candidate.reference?.producingFeatureId ===
          entry.reference!.producingFeatureId &&
        candidate.reference.lineageName === entry.reference!.lineageName
    ).length !== 1
  )
    return null;
  return {
    bodyId: body.bodyId,
    kind: selection.kind,
    topologyId: entry.topologyId,
    hash: entry.hash,
    ...(entry.reference ? { reference: entry.reference } : {})
  };
}

/** A viewport identity may name its publisher without proving edit ownership. */
export function selectionFeature(
  document: ProjectDocument,
  body: BodyRepresentation | undefined,
  selection: TopologySelection
): FeatureNode | null {
  const resolved = resolveSelectionTopology(body, selection);
  if (!resolved || !body) return null;
  if (resolved.kind === 'body') return bodyFeature(document, body.bodyId);
  const entries =
    resolved.kind === 'face'
      ? (body.topology?.faces ?? [])
      : (body.topology?.edges ?? []);
  const entry = entries.find(
    (candidate) => candidate.topologyId === resolved.topologyId
  )!;
  const faces = body.topology?.faces ?? [];
  if (selection.kind === 'face') {
    const face = faces.find((candidate) => candidate === entry);
    if (!face) return null;
    if (face.geometry?.featureType === 'blend') {
      const feature = editableFilletFeature(document, face, faces);
      return feature && !isFeatureSuppressed(feature) ? feature : null;
    }
    const ancestor =
      primitiveBoxFaceAncestor(document, body.bodyId, face.reference, face.hash)
        ?.primitive ??
      primitiveCylinderCapAncestor(
        document,
        body.bodyId,
        face.reference,
        face.hash
      )?.primitive;
    if (ancestor) return ancestor;
    if (face.reference?.lineageName === 'modifier.cylinder.face.wall') {
      return primitiveCylinderRadiusAncestor(document, body.bodyId);
    }
  } else {
    const edge = body.topology?.edges.find((candidate) => candidate === entry);
    if (!edge || edge.displayRole === 'seam') return null;
    const adjacent = (edge.adjacentFaceHashes ?? []).map((hash) =>
      faces.filter((face) => face.hash === hash)
    );
    if (adjacent.some((candidates) => candidates.length !== 1)) return null;
    const blends = adjacent
      .flat()
      .filter((face) => face.geometry?.featureType === 'blend');
    if (blends.length > 0) {
      const owners = blends.map((face) =>
        editableFilletFeature(document, face, faces)
      );
      const owner = owners[0];
      return owner &&
        !isFeatureSuppressed(owner) &&
        owners.every((candidate) => candidate?.featureId === owner.featureId)
        ? owner
        : null;
    }
  }
  const identity = entry.reference;
  if (
    !identity ||
    entries.filter(
      (candidate) =>
        candidate.reference?.producingFeatureId ===
          identity.producingFeatureId &&
        candidate.reference.lineageName === identity.lineageName
    ).length !== 1
  )
    return null;
  const feature = listFeaturesInOrder(document).find(
    (candidate) =>
      candidate.featureId === identity.producingFeatureId &&
      !isFeatureSuppressed(candidate)
  );
  if (!feature) return null;
  // Modifier and boolean role names can be republished under a later feature.
  // Only these construction roles directly prove the editable source feature.
  const kind = feature.data.featureKind;
  return (kind === 'primitive' &&
    identity.lineageName.startsWith('primitive.')) ||
    ((kind === 'extrude' || kind === 'revolve' || kind === 'sweep') &&
      identity.lineageName.startsWith('sweep.'))
    ? feature
    : null;
}

export function selectionSetFeature(
  document: ProjectDocument,
  bodies: Record<string, BodyRepresentation>,
  selections: readonly TopologySelection[]
): FeatureNode | null {
  if (
    selections.length === 0 ||
    selections.some((selection) => selection.bodyId !== selections[0]!.bodyId)
  )
    return null;
  const owners = selections.map((selection) =>
    selectionFeature(document, bodies[selection.bodyId], selection)
  );
  const first = owners[0];
  return first && owners.every((owner) => owner?.featureId === first.featureId)
    ? first
    : null;
}
