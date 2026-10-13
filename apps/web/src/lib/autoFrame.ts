import type { BodyId, BodyRepresentation, FeatureNode } from '@openzcad/shared';

/**
 * One committed change to frame for: the body projections from before the
 * command and the exact ones its rebuild published. Built by the workspace on
 * a local commit, never for a preview, an undo, or someone else's edit.
 */
export interface AutoFrameRequest {
  before: Readonly<Record<string, BodyRepresentation>>;
  after: Readonly<Record<string, BodyRepresentation>>;
  /** Committed history order distinguishes edit results from independent additions. */
  features: readonly FeatureNode[];
}

/**
 * Only independently added bodies may request framing. Editing an existing
 * body preserves the user's camera, even when it grows or moves out of view.
 *
 * Follow each result's body inputs through history so replacement chains stay
 * edits, while unrelated additions in the same transaction can still frame.
 */
export function createdBodiesToFrame(
  before: Readonly<Record<string, BodyRepresentation>>,
  after: Readonly<Record<string, BodyRepresentation>>,
  features: readonly FeatureNode[]
): BodyId[] {
  const existing = new Set(Object.values(before).map((body) => body.bodyId));
  for (const feature of features) {
    const data = feature.data;
    // A mirror is an independent copy: its source stays where it was.
    if (data.featureKind === 'mirror') continue;
    const inputs =
      'targetBodyIds' in data
        ? data.targetBodyIds
        : 'targetBodyId' in data && data.targetBodyId
          ? [data.targetBodyId]
          : [];
    if (!inputs.some((bodyId) => existing.has(bodyId))) continue;
    if (feature.bodyId) existing.add(feature.bodyId);
    if (data.featureKind === 'split') existing.add(data.secondBodyId);
  }
  return Object.values(after)
    .filter((body) => !body.consumed && !existing.has(body.bodyId))
    .map((body) => body.bodyId);
}
