/**
 * M16 slice 4: which features have a flat pattern, and which one a body's
 * sheet came from. Document reads only, so the workspace can offer the
 * flat-pattern view without loading its writers.
 */
import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureManuallySuppressed,
  isFeatureRollbackSuppressed,
  type BodyId,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

export interface SheetMetalFeatureOption {
  featureId: FeatureId;
  name: string;
  bodyId: BodyId | null;
}

/** The sheet-metal features that build: neither suppressed nor rolled back. */
export function sheetMetalFeatureOptions(
  document: ProjectDocument
): SheetMetalFeatureOption[] {
  return listFeaturesInOrder(document)
    .filter(
      (feature) =>
        feature.data.featureKind === 'sheet-metal' &&
        !isFeatureManuallySuppressed(feature) &&
        !isFeatureRollbackSuppressed(feature)
    )
    .map((feature) => ({
      featureId: feature.featureId,
      name: feature.name,
      bodyId: feature.bodyId ?? null
    }));
}

/**
 * The sheet-metal feature `bodyId`'s sheet came from: the feature that owns
 * the body, or one whose body a later feature (a hole, a cut, a move) carried
 * on into `bodyId`. Null for a body with no sheet behind it.
 */
export function sheetMetalFeatureForBody(
  document: ProjectDocument,
  bodyId: BodyId
): SheetMetalFeatureOption | null {
  const sheets = new Map(
    sheetMetalFeatureOptions(document).map((option) => [
      option.featureId,
      option
    ])
  );
  const source = new Map<BodyId, FeatureId>();
  for (const feature of listFeaturesInOrder(document)) {
    if (
      isFeatureManuallySuppressed(feature) ||
      isFeatureRollbackSuppressed(feature)
    ) {
      continue;
    }
    if (sheets.has(feature.featureId)) {
      if (feature.bodyId) source.set(feature.bodyId, feature.featureId);
      continue;
    }
    const data = feature.data as unknown as Record<string, unknown>;
    const list = (value: unknown): unknown[] =>
      Array.isArray(value) ? (value as unknown[]) : [];
    const inputs = [
      data.targetBodyId,
      ...list(data.targetBodyIds),
      ...list(data.toolBodyIds)
    ].filter((id): id is BodyId => typeof id === 'string');
    const from = inputs.map((id) => source.get(id)).find(Boolean);
    if (from && feature.bodyId) source.set(feature.bodyId, from);
  }
  const featureId = source.get(bodyId);
  return featureId ? (sheets.get(featureId) ?? null) : null;
}
