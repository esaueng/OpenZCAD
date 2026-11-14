import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  ownEntry,
  type BodyId,
  type DerivedState,
  type FaceTopology,
  type FeatureId,
  type ProjectDocument,
  type Vector3
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
 * wholesale and every origin would look gone: nothing is reported then. A
 * fallback for some faces alone is caught per opening: one whose face could
 * still stand untraced in the result (`mayBeSameFace`) is not reported.
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
  const cutOrigins = new Map<FeatureId, FaceTopology[]>();
  const originsBefore = new Set<FeatureId>();
  for (const face of beforeFaces) {
    const reference = face.reference;
    if (!reference || reference.currentHash !== face.hash) continue;
    const trace = traceBefore(reference);
    if (!trace?.origin) continue;
    originsBefore.add(trace.origin);
    if (isCutOrigin(trace.origin, trace.cutBy)) {
      const faces = cutOrigins.get(trace.origin) ?? [];
      faces.push(face);
      cutOrigins.set(trace.origin, faces);
    }
  }
  if (cutOrigins.size === 0) return [];

  const traceAfter = faceLineageTracer(after);
  const originsAfter = new Set<FeatureId>();
  const untracedAfter: FaceTopology[] = [];
  for (const face of afterFaces) {
    const reference = face.reference;
    const origin =
      reference && reference.currentHash === face.hash
        ? traceAfter(reference)?.origin
        : null;
    if (origin) originsAfter.add(origin);
    else untracedAfter.push(face);
  }
  // The lineage survived the edit: some origin is still traced on both sides.
  if (![...originsAfter].some((origin) => originsBefore.has(origin))) {
    return [];
  }

  return [...cutOrigins]
    .filter(
      ([origin, faces]) =>
        !originsAfter.has(origin) &&
        // A face of the opening may still stand with its name lost (the
        // edit's lineage fell back for it alone): where an untraced face
        // could be one of them, the opening is not reported as closed.
        !faces.some((face) =>
          untracedAfter.some((candidate) => mayBeSameFace(face, candidate))
        )
    )
    .flatMap(([origin]) => {
      const feature = features.get(origin);
      return feature ? [{ featureId: origin, name: feature.name }] : [];
    });
}

/**
 * Whether `after` could be `before` with its name lost: on the same plane
 * for planar faces; for any other surface, only the same surface class, as
 * nothing cheaper rules a curved face out.
 */
function mayBeSameFace(before: FaceTopology, after: FaceTopology): boolean {
  const a = before.geometry;
  const b = after.geometry;
  if (!a || !b) return true;
  if (a.surfaceType !== b.surfaceType) return false;
  if (a.surfaceType !== 'plane' || !a.normal || !b.normal) return true;
  const dot = (u: Vector3, v: Vector3) => u.x * v.x + u.y * v.y + u.z * v.z;
  if (dot(a.normal, b.normal) < 1 - 1e-6) return false;
  const scale = Math.max(
    1,
    Math.abs(a.center.x),
    Math.abs(a.center.y),
    Math.abs(a.center.z)
  );
  return (
    Math.abs(dot(a.normal, a.center) - dot(a.normal, b.center)) <= 1e-6 * scale
  );
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
