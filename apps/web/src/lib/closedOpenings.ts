import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  ownEntry,
  type BodyId,
  type DerivedState,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import { faceLineageTracer } from './historyFocus';

/**
 * The cut features whose every face a face edit removed from its body.
 *
 * Offsetting a window's sill past its lintel fills the window: the result is
 * what was asked for, but the Window step stays in the history and no longer
 * changes the shape, and nothing said so. A cut's faces are recognised by
 * their decoded lineage, not by `producingFeatureId`: a subtract republishes
 * the body it cut and its tools' faces alike, so that names the subtract for
 * every face. The decoded origin is the tool's own feature ("Window HDMI
 * IN"), or the extrude for a cut extrude's sweep.
 *
 * Only faces whose reference is current count. A face that was hash-only
 * before the edit cannot be traced, so an opening drawn only by such faces is
 * not reported (a quiet miss, never a false alarm). If the edit left the body
 * with no traceable face from an origin it had before, its lineage fell back
 * wholesale and every origin would look gone: nothing is reported then.
 */
export function openingsClosedByEdit(
  before: ProjectDocument,
  after: ProjectDocument,
  derived: DerivedState,
  bodyId: BodyId
): { featureId: FeatureId; name: string }[] {
  const beforeFaces = ownEntry(before.derived.bodyRepresentations, bodyId)
    ?.topology?.faces;
  const afterBody = ownEntry(derived.bodyRepresentations, bodyId);
  const afterFaces = afterBody?.topology?.faces;
  if (!beforeFaces || !afterFaces || afterBody.consumed) return [];
  // An opening closed is faces gone; an edit that only moved faces is not.
  if (afterFaces.length >= beforeFaces.length) return [];

  const features = new Map(
    listFeaturesInOrder(after).map((feature) => [feature.featureId, feature])
  );
  const isCutOrigin = (origin: FeatureId, cutBy: FeatureId | undefined) => {
    if (cutBy) return true;
    const data = features.get(origin)?.data;
    return data?.featureKind === 'extrude' && data.operation === 'cut';
  };

  const traceBefore = faceLineageTracer(before);
  const cutOrigins = new Set<FeatureId>();
  const originsBefore = new Set<FeatureId>();
  for (const face of beforeFaces) {
    const reference = face.reference;
    if (!reference || reference.currentHash !== face.hash) continue;
    const trace = traceBefore(reference);
    if (!trace?.origin) continue;
    originsBefore.add(trace.origin);
    if (isCutOrigin(trace.origin, trace.cutBy)) cutOrigins.add(trace.origin);
  }
  if (cutOrigins.size === 0) return [];

  const traceAfter = faceLineageTracer(after);
  const originsAfter = new Set<FeatureId>();
  for (const face of afterFaces) {
    const reference = face.reference;
    if (!reference || reference.currentHash !== face.hash) continue;
    const origin = traceAfter(reference)?.origin;
    if (origin) originsAfter.add(origin);
  }
  // The lineage survived the edit: some origin is still traced on both sides.
  if (![...originsAfter].some((origin) => originsBefore.has(origin))) {
    return [];
  }

  return [...cutOrigins]
    .filter((origin) => !originsAfter.has(origin))
    .flatMap((origin) => {
      const feature = features.get(origin);
      return feature ? [{ featureId: origin, name: feature.name }] : [];
    });
}

/** The notice for openings a face edit closed, or null when it closed none. */
export function closedOpeningsNotice(
  editName: string,
  closed: readonly { name: string }[]
): string | null {
  if (closed.length === 0) return null;
  if (closed.length === 1) {
    return `“${editName}” filled in the opening cut by “${closed[0]!.name}”; that step no longer changes the shape.`;
  }
  const names = closed.map((entry) => `“${entry.name}”`).join(', ');
  return `“${editName}” filled in ${closed.length} openings (${names}); those steps no longer change the shape.`;
}

/**
 * The notice for openings the face edits a commit added or changed filled
 * in, or null. Only `direct-edit` steps new in `after`, or whose data the
 * commit replaced, are checked.
 */
export function closedOpeningsAdvisory(
  before: ProjectDocument,
  after: ProjectDocument,
  derived: DerivedState
): string | null {
  for (const feature of listFeaturesInOrder(after)) {
    if (feature.data.featureKind !== 'direct-edit') continue;
    const previous = ownEntry(before.nodes, feature.id);
    if (previous?.kind === 'feature' && previous.data === feature.data)
      continue;
    const notice = closedOpeningsNotice(
      feature.name,
      openingsClosedByEdit(before, after, derived, feature.data.targetBodyId)
    );
    if (notice) return notice;
  }
  return null;
}
