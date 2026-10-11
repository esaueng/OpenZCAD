import {
  PREVIEW_BODY_COLOR,
  type GeometryBodyRepresentation
} from '@openzcad/shared';

function sameGeometry(
  preview: GeometryBodyRepresentation,
  applied: GeometryBodyRepresentation | undefined
): boolean {
  if (!applied) return false;
  if (preview === applied || preview.mesh === applied.mesh) return true;
  const a = preview.projectionRevision;
  const b = applied.projectionRevision;
  if (a && b && a.session === b.session) return a.geometry === b.geometry;
  // A rebuild may copy buffers without changing the body. Compare exact
  // display values when no shared projection identity is available.
  return (['vertices', 'indices'] as const).every((key) => {
    const left = preview.mesh[key];
    const right = applied.mesh[key];
    return left.length === right.length && left.every((v, i) => v === right[i]);
  });
}

/** Tint unapplied geometry, including edits that retain their body's ID. */
export function tintPreviewResultBodies<T extends GeometryBodyRepresentation>(
  previewBodies: T[],
  appliedBodies: Readonly<Record<string, GeometryBodyRepresentation>>
): T[] {
  let changed = false;
  const tinted = previewBodies.map((body) => {
    if (sameGeometry(body, appliedBodies[body.bodyId])) return body;
    changed = true;
    return { ...body, color: PREVIEW_BODY_COLOR };
  });
  return changed ? tinted : previewBodies;
}
