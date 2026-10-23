import type {
  EntityId,
  SketchConstraintId,
  SketchConstraintData,
  SketchObjectData,
  SketchPointRef
} from './index';
import {
  isLegacyCompositeTopology,
  isSketchBoundaryEntityId,
  makeSketchCompositeBoundaryToken,
  type LegacyCompositeTopology
} from './sketch-boundary-provenance';

export type LegacyCompositeObjectData = Extract<
  SketchObjectData,
  { objectKind: 'rectangle' | 'polygon' }
>;

/** Conversion owns all aliases; the source data is an inert history witness. */
export interface SketchPromotion {
  promotionId: string;
  version: 1;
  sourceObjectId: EntityId;
  sourceData: LegacyCompositeObjectData;
  sourceName: string;
  topology: LegacyCompositeTopology;
  edgeIds: EntityId[];
  centerSpokeId: EntityId;
  helperIds: EntityId[];
  structureConstraintIds: SketchConstraintId[];
  aliases: {
    version: 1;
    vertices: SketchPointRef[];
    edges: EntityId[];
    center: SketchPointRef;
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ids(value: unknown): value is EntityId[] {
  return (
    Array.isArray(value) && Array.from(value).every(isSketchBoundaryEntityId)
  );
}

function parameter(value: unknown): boolean {
  return typeof value === 'number'
    ? Number.isFinite(value)
    : typeof value === 'string' && value.length > 0;
}

export function isLegacyCompositeObjectData(
  value: unknown
): value is LegacyCompositeObjectData {
  if (!record(value)) return false;
  const parameters =
    value.objectKind === 'rectangle'
      ? ['width', 'height', 'centerX', 'centerY']
      : value.objectKind === 'polygon'
        ? ['sides', 'radius', 'centerX', 'centerY']
        : null;
  if (!parameters || !parameters.every((key) => parameter(value[key])))
    return false;
  const known = new Set(['objectKind', 'construction', ...parameters]);
  return (
    Object.keys(value).every((key) => known.has(key)) &&
    (value.construction === undefined ||
      typeof value.construction === 'boolean')
  );
}

function endpoint(value: unknown, objectId: string): value is SketchPointRef {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    value.objectId === objectId &&
    value.point === 'start'
  );
}

/** Shape-only validation of the existing legal constraints promotion authors. */
export function promotionStructureObjectIds(value: unknown): EntityId[] | null {
  if (!record(value)) return null;
  const point = (candidate: unknown): candidate is SketchPointRef =>
    record(candidate) &&
    Object.keys(candidate).length === 2 &&
    isSketchBoundaryEntityId(candidate.objectId) &&
    (candidate.point === 'start' || candidate.point === 'end');
  switch (value.constraintKind) {
    case 'horizontal':
    case 'vertical':
      return Object.keys(value).length === 2 &&
        isSketchBoundaryEntityId(value.objectId)
        ? [value.objectId]
        : null;
    case 'parallel':
    case 'equal':
      return Object.keys(value).length === 3 &&
        isSketchBoundaryEntityId(value.a) &&
        isSketchBoundaryEntityId(value.b)
        ? [value.a, value.b]
        : null;
    case 'coincident':
      return Object.keys(value).length === 3 && point(value.a) && point(value.b)
        ? [value.a.objectId, value.b.objectId]
        : null;
    case 'distance':
      return Object.keys(value).length === 4 &&
        point(value.a) &&
        point(value.b) &&
        parameter(value.value) &&
        (typeof value.value !== 'number' || value.value > 0)
        ? [value.a.objectId, value.b.objectId]
        : null;
    case 'midpoint':
      return Object.keys(value).length === 3 &&
        point(value.point) &&
        isSketchBoundaryEntityId(value.line)
        ? [value.point.objectId, value.line]
        : null;
    default:
      return null;
  }
}

export function isPromotionStructureConstraintData(
  value: unknown
): value is SketchConstraintData {
  return promotionStructureObjectIds(value) !== null;
}

export function isSketchPromotion(value: unknown): value is SketchPromotion {
  if (
    !record(value) ||
    Object.keys(value).length !== 11 ||
    !isSketchBoundaryEntityId(value.promotionId) ||
    value.version !== 1 ||
    !isSketchBoundaryEntityId(value.sourceObjectId) ||
    !isLegacyCompositeObjectData(value.sourceData) ||
    typeof value.sourceName !== 'string' ||
    !isLegacyCompositeTopology(value.topology) ||
    !ids(value.edgeIds) ||
    value.edgeIds.length !== value.topology.count ||
    !isSketchBoundaryEntityId(value.centerSpokeId) ||
    !ids(value.helperIds) ||
    value.helperIds.length !== (value.topology.kind === 'rectangle' ? 1 : 0) ||
    !ids(value.structureConstraintIds) ||
    new Set(value.structureConstraintIds).size !==
      value.structureConstraintIds.length ||
    !record(value.aliases) ||
    Object.keys(value.aliases).length !== 4 ||
    value.aliases.version !== 1 ||
    !Array.isArray(value.aliases.vertices) ||
    value.aliases.vertices.length !== value.edgeIds.length ||
    !ids(value.aliases.edges) ||
    value.aliases.edges.length !== value.edgeIds.length ||
    !endpoint(value.aliases.center, value.centerSpokeId)
  )
    return false;
  const members = [
    value.sourceObjectId,
    ...value.edgeIds,
    value.centerSpokeId,
    ...value.helperIds
  ];
  if (
    new Set(members).size !== members.length ||
    (value.sourceData.objectKind === 'rectangle'
      ? value.topology.kind !== 'rectangle'
      : value.topology.kind !== 'regular-polygon')
  )
    return false;
  const edgeIds = value.edgeIds;
  return (
    Array.from(value.aliases.vertices).every((point, i) =>
      endpoint(point, edgeIds[i]!)
    ) && value.aliases.edges.every((id, i) => id === edgeIds[i])
  );
}

/** A partial owner never supplies a partial alias map to profile matching. */
export function resolveSketchPromotionBoundaryTokens(
  promotions: readonly SketchPromotion[],
  objects: ReadonlyMap<string, SketchObjectData>
): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  const promotionIds = new Set<string>();
  const sources = new Set<string>();
  const members = new Set<string>();
  for (const promotion of promotions) {
    const label =
      record(promotion) && typeof promotion.promotionId === 'string'
        ? promotion.promotionId
        : 'unknown';
    const failure = (detail: string): never => {
      throw new Error(`Sketch promotion "${label}": ${detail}`);
    };
    if (!isSketchPromotion(promotion))
      failure('the saved alias record is malformed.');
    if (
      promotionIds.has(promotion.promotionId) ||
      sources.has(promotion.sourceObjectId)
    )
      failure('the source or promotion identity has more than one owner.');
    promotionIds.add(promotion.promotionId);
    sources.add(promotion.sourceObjectId);
    if (objects.has(promotion.sourceObjectId))
      failure(
        'the source object still contributes alongside its promoted edges.'
      );
    for (const id of [
      ...promotion.edgeIds,
      promotion.centerSpokeId,
      ...promotion.helperIds
    ]) {
      if (members.has(id))
        failure(`member "${id}" has more than one promotion owner.`);
      members.add(id);
      const object = objects.get(id);
      if (!object || object.objectKind !== 'line')
        failure(`generated line "${id}" is missing or has changed kind.`);
      if (
        (id === promotion.centerSpokeId || promotion.helperIds.includes(id)) &&
        !object?.construction
      )
        failure(
          'an owned center spoke or helper is no longer construction geometry.'
        );
    }
    promotion.edgeIds.forEach((id, index) =>
      tokens.set(
        id,
        makeSketchCompositeBoundaryToken(
          promotion.sourceObjectId,
          promotion.topology,
          index
        )
      )
    );
  }
  return tokens;
}
