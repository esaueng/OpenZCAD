import {
  boundaryProvenanceObjectIds,
  isBoundaryProvenance,
  MAX_SKETCH_POLYGON_SIDES,
  parseSketchBoundaryToken,
  type BoundaryProvenance,
  type EntityId,
  type ProjectDocument,
  type SketchId,
  type SketchNode,
  type SketchObjectData,
  type SketchProfileReference
} from '@openzcad/shared';
import { findSketch, getParameterScope, resolveParamValue } from './index';

export function assertSketchPromotionMemberUpdate(
  document: ProjectDocument,
  sketch: SketchNode,
  objectId: EntityId,
  data: SketchObjectData
): void {
  const promotion = sketch.promotions?.find((p) =>
    [...p.edgeIds, p.centerSpokeId, ...p.helperIds].includes(objectId)
  );
  if (!promotion) return;
  if (
    data.objectKind !== 'line' ||
    ((objectId === promotion.centerSpokeId ||
      promotion.helperIds.includes(objectId)) &&
      !data.construction)
  )
    throw new Error(
      'This converted member owns a saved line or center alias. Its kind and construction-helper role cannot change.'
    );
  const original = document.nodes[objectId];
  if (
    original?.kind === 'sketch-object' &&
    !original.data.construction &&
    data.construction
  )
    assertSketchBoundaryDeletion(document, sketch, objectId);
}

/** Only model profile carriers are walked; history witnesses are not live dependencies. */
export function sketchProfileReferences(
  document: ProjectDocument,
  sketchId: SketchId
): SketchProfileReference[] {
  const found: SketchProfileReference[] = [];
  const visit = (value: unknown, context?: string) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, context);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const owner =
      typeof record.sketchId === 'string' ? record.sketchId : context;
    if (owner === sketchId && ('sourceArea' in record || record.all === true)) {
      found.push(record as unknown as SketchProfileReference);
      return;
    }
    for (const item of Object.values(record)) visit(item, owner);
  };
  for (const node of Object.values(document.nodes))
    if (node.kind === 'feature') visit(node.data);
  return found;
}

function boundaries(
  document: ProjectDocument,
  sketchId: SketchId
): BoundaryProvenance[] {
  return sketchProfileReferences(document, sketchId).flatMap((reference) =>
    reference.all !== true &&
    isBoundaryProvenance(reference.sourceBoundaryLoops)
      ? [reference.sourceBoundaryLoops]
      : []
  );
}

/** Topology-aware saves never silently follow a new polygon side count or kind. */
export function assertSketchBoundaryTopologyPreserved(
  before: ProjectDocument,
  after: ProjectDocument
): void {
  for (const node of Object.values(before.nodes)) {
    if (node.kind !== 'sketch') continue;
    const tokens = boundaries(before, node.sketchId).flatMap((loops) =>
      [loops.outer, ...loops.holes].flat()
    );
    if (!tokens.length) continue;
    const describe = (
      document: ProjectDocument,
      objectId: EntityId
    ): string => {
      const sketch = findSketch(document, node.sketchId);
      const object = sketch?.objectIds.includes(objectId)
        ? document.nodes[objectId]
        : undefined;
      const promotion = sketch?.promotions?.find(
        (p) => p.sourceObjectId === objectId
      );
      if (!object && promotion)
        return `${promotion.topology.kind}/${promotion.topology.count}`;
      if (object?.kind !== 'sketch-object' || object.data.construction)
        return 'missing';
      const data = object.data;
      if (data.objectKind === 'rectangle') return 'rectangle/4';
      if (data.objectKind !== 'polygon') return data.objectKind;
      try {
        const count = resolveParamValue(
          data.sides,
          getParameterScope(document).scope,
          'polygon sides',
          document.units
        );
        return Number.isInteger(count) &&
          count >= 3 &&
          count <= MAX_SKETCH_POLYGON_SIDES
          ? `regular-polygon/${count}`
          : 'unresolved';
      } catch {
        return 'unresolved';
      }
    };
    const checked = new Set<string>();
    for (const raw of tokens) {
      const token = parseSketchBoundaryToken(raw);
      if (token?.kind !== 'composite' || checked.has(token.objectId)) continue;
      checked.add(token.objectId);
      const previous = describe(before, token.objectId),
        candidate = describe(after, token.objectId);
      if (
        candidate !== previous &&
        candidate !== `${token.topology.kind}/${token.topology.count}`
      )
        throw new Error(
          'This topology change would invalidate a saved boundary reference. Remove or repair the reference, or convert to editable edges first.'
        );
    }
  }
}

/** Generated members may dissolve only when no downstream selection consumes their aliases. */
export function assertSketchBoundaryDeletion(
  document: ProjectDocument,
  sketch: SketchNode,
  objectId: EntityId
): void {
  const promotion = sketch.promotions?.find((p) =>
    [...p.edgeIds, p.centerSpokeId, ...p.helperIds].includes(objectId)
  );
  const owned = promotion
    ? new Set([
        promotion.sourceObjectId,
        ...promotion.edgeIds,
        promotion.centerSpokeId,
        ...promotion.helperIds
      ])
    : new Set([objectId]);
  const referenced = sketchProfileReferences(document, sketch.sketchId).some(
    (reference) =>
      (promotion &&
        reference.sourceEntityIds?.some((id) => owned.has(id as EntityId))) ||
      (reference.all !== true &&
        isBoundaryProvenance(reference.sourceBoundaryLoops) &&
        boundaryProvenanceObjectIds(reference.sourceBoundaryLoops).some((id) =>
          owned.has(id)
        ))
  );
  const wholeSketchConsumer =
    promotion &&
    promotion.edgeIds[0] === sketch.objectIds[0] &&
    Object.values(document.nodes).some(
      (node) =>
        node.kind === 'feature' &&
        (node.data.featureKind === 'extrude' ||
          node.data.featureKind === 'revolve') &&
        node.data.sketchId === sketch.sketchId &&
        (node.data.featureKind === 'revolve' ||
          (!node.data.profile && !node.data.profiles?.length))
    );
  if (referenced || wholeSketchConsumer)
    throw new Error(
      'This geometry owns a saved downstream boundary. Remove or repair its dependent features before deleting it.'
    );
}

export function dissolveSketchPromotion(
  sketch: SketchNode,
  objectId: EntityId
): void {
  const removed =
    sketch.promotions?.filter((p) =>
      [...p.edgeIds, p.centerSpokeId, ...p.helperIds].includes(objectId)
    ) ?? [];
  if (!removed.length) return;
  const owners = new Set(removed.map((p) => p.promotionId));
  sketch.constraints = sketch.constraints?.filter(
    (c) => !c.promotionId || !owners.has(c.promotionId)
  );
  const kept = sketch.promotions!.filter((p) => !owners.has(p.promotionId));
  if (kept.length) sketch.promotions = kept;
  else delete sketch.promotions;
}
